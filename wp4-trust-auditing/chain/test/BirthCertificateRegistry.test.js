const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { py } = require("./py");

const TOKEN = 7;
// assetType, manufacturer, serialNumber, birthDate (yyyymmdd), designSpecHash, initialStateHash
const CERT = ["wind-turbine/V2", "ACME Turbines s.r.o.", "SN-2026-0042", 20260115, "0x5ca1ab1e-design-spec", "0xinitial-state"];
const K = CERT.length;

describe("BirthCertificateRegistry (zero-knowledge DT–NFT link, T4.3)", function () {
  async function deployed() {
    const [alice, bob, carol] = await ethers.getSigners();
    const nft = await ethers.deployContract("MockTwinNFT");
    await nft.mint(alice.address, TOKEN);
    const reg = await ethers.deployContract("BirthCertificateRegistry", [await nft.getAddress(), K]);
    const chainId = (await ethers.provider.getNetwork()).chainId.toString();
    const contract = await reg.getAddress();
    const opening = py("commit", { attrs: JSON.stringify(CERT), seed: "alice" });
    const prove = (prover, r, mask = 0, token = TOKEN, seed = "p") =>
      py("prove", { chainId, contract, token: String(token), prover: prover.address, attrs: JSON.stringify(CERT), r, mask: String(mask), seed });
    const rotate = (prover, r) => py("rotate", { chainId, contract, token: String(TOKEN), prover: prover.address, attrs: JSON.stringify(CERT), r });
    return { alice, bob, carol, nft, reg, opening, prove, rotate };
  }

  async function registered() {
    const f = await deployed();
    await f.reg.connect(f.alice).registerBirthCertificate(TOKEN, f.opening.commitment);
    return f;
  }

  it("registers a commitment to the birth certificate once, only by the NFT owner", async function () {
    const { reg, alice, bob, opening } = await loadFixture(deployed);
    await expect(reg.connect(bob).registerBirthCertificate(TOKEN, opening.commitment)).to.be.revertedWithCustomError(reg, "NotTwinOwner");
    await expect(reg.connect(alice).registerBirthCertificate(TOKEN, { x: 1, y: 3 })).to.be.revertedWithCustomError(reg, "InvalidCommitment");
    await expect(reg.connect(alice).registerBirthCertificate(TOKEN, { x: 0, y: 0 })).to.be.revertedWithCustomError(reg, "InvalidCommitment");
    await expect(reg.connect(alice).registerBirthCertificate(TOKEN, opening.commitment))
      .to.emit(reg, "BirthCertificateRegistered")
      .withArgs(TOKEN, opening.commitment.x, opening.commitment.y);
    expect(await reg.commitmentVersion(TOKEN)).to.equal(1);
    expect((await reg.commitmentOf(TOKEN)).y).to.equal(opening.commitment.y);
    await expect(reg.connect(alice).registerBirthCertificate(TOKEN, opening.commitment)).to.be.revertedWithCustomError(reg, "AlreadyRegistered");
  });

  it("verifies a proof of the certificate that reveals nothing", async function () {
    const { reg, alice, opening, prove } = await loadFixture(registered);
    const p = prove(alice, opening.r);
    expect(p.disclosed).to.deep.equal([]);
    expect(await reg.verifyCertificate(TOKEN, alice.address, p)).to.equal(true);
    await expect(reg.connect(alice).proveCertificate(TOKEN, p)).to.emit(reg, "CertificateProven").withArgs(TOKEN, alice.address, 0, []);
  });

  it("supports selective disclosure of chosen attributes", async function () {
    const { reg, alice, opening, prove } = await loadFixture(registered);
    const mask = (1 << 1) | (1 << 3); // manufacturer and birth date
    const p = prove(alice, opening.r, mask);
    expect(p.disclosed).to.deep.equal([opening.attrs[1], opening.attrs[3]]);
    expect(p.disclosed[1]).to.equal("20260115");
    await expect(reg.connect(alice).proveCertificate(TOKEN, p)).to.emit(reg, "CertificateProven").withArgs(TOKEN, alice.address, mask, p.disclosed);
    // a false disclosed value is rejected
    const lie = { ...p, disclosed: [p.disclosed[0], "20200101"] };
    expect(await reg.verifyCertificate(TOKEN, alice.address, lie)).to.equal(false);
    await expect(reg.connect(alice).proveCertificate(TOKEN, lie)).to.be.revertedWithCustomError(reg, "InvalidProof");
  });

  it("binds every proof to its prover, token and contract", async function () {
    const { reg, nft, alice, bob, opening, prove } = await loadFixture(registered);
    const p = prove(alice, opening.r);
    expect(await reg.verifyCertificate(TOKEN, bob.address, p)).to.equal(false); // stolen proof
    await expect(reg.connect(bob).proveCertificate(TOKEN, p)).to.be.revertedWithCustomError(reg, "NotTwinOwner");
    await nft.mint(alice.address, TOKEN + 1);
    await reg.connect(alice).registerBirthCertificate(TOKEN + 1, opening.commitment);
    expect(await reg.verifyCertificate(TOKEN + 1, alice.address, p)).to.equal(false); // other token
    const wrongR = prove(alice, (BigInt(opening.r) + 1n).toString());
    expect(await reg.verifyCertificate(TOKEN, alice.address, wrongR)).to.equal(false); // no knowledge of r
    expect(await reg.verifyCertificate(TOKEN, alice.address, { ...p, sHidden: p.sHidden.slice(1) })).to.equal(false);
    expect(await reg.verifyCertificate(TOKEN, alice.address, { ...p, mask: 1 << K })).to.equal(false);
    expect(await reg.verifyCertificate(TOKEN + 2, alice.address, p)).to.equal(false); // nothing registered
  });

  it("after a sale, the new owner rotates the commitment and the seller can no longer prove", async function () {
    const { reg, nft, alice, bob, opening, prove, rotate } = await loadFixture(registered);
    await nft.connect(alice).transferFrom(alice.address, bob.address, TOKEN);
    // the seller hands over the opening; the buyer can prove at once…
    expect(await reg.verifyCertificate(TOKEN, bob.address, prove(bob, opening.r))).to.equal(true);
    // …and re-randomises the commitment so that the seller's knowledge becomes useless
    const rot = rotate(bob, opening.r);
    await expect(reg.connect(alice).rotateCommitment(TOKEN, rot.commitment, rot.t, rot.s)).to.be.revertedWithCustomError(reg, "NotTwinOwner");
    const forAlice = rotate(alice, opening.r);
    await expect(reg.connect(bob).rotateCommitment(TOKEN, forAlice.commitment, forAlice.t, forAlice.s)).to.be.revertedWithCustomError(reg, "InvalidProof");
    await expect(reg.connect(bob).rotateCommitment(TOKEN, rot.commitment, rot.t, rot.s)).to.emit(reg, "CommitmentRotated").withArgs(TOKEN, 2, rot.commitment.x, rot.commitment.y);

    expect(await reg.verifyCertificate(TOKEN, alice.address, prove(alice, opening.r))).to.equal(false);
    expect(await reg.verifyCertificate(TOKEN, bob.address, prove(bob, opening.r))).to.equal(false);
    const fresh = prove(bob, rot.r, 1 << 2);
    await expect(reg.connect(bob).proveCertificate(TOKEN, fresh)).to.emit(reg, "CertificateProven");
  });

  it("rejects rotation of an unregistered twin and bad attribute counts", async function () {
    const { reg, nft, alice, rotate } = await loadFixture(deployed);
    const rot = rotate(alice, "1");
    await expect(reg.connect(alice).rotateCommitment(TOKEN, rot.commitment, rot.t, rot.s)).to.be.revertedWithCustomError(reg, "NotRegistered");
    const Reg = await ethers.getContractFactory("BirthCertificateRegistry");
    await expect(Reg.deploy(await nft.getAddress(), 0)).to.be.revertedWithCustomError(Reg, "BadAttributeCount");
    await expect(Reg.deploy(await nft.getAddress(), 17)).to.be.revertedWithCustomError(Reg, "BadAttributeCount");
    const [gens, h] = await reg.generators();
    expect(gens.length).to.equal(K);
    expect(h.x).to.not.equal(0n);
  });
});

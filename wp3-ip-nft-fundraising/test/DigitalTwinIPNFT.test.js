const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const spec = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

describe("DigitalTwinIPNFT", function () {
  async function deploy() {
    const [team, other] = await ethers.getSigners();
    const ipnft = await ethers.deployContract("DigitalTwinIPNFT");
    return { ipnft, team, other };
  }

  async function registered() {
    const f = await deploy();
    await f.ipnft.connect(f.team).registerTwin(spec("robot-arm-v1"), "ipfs://twin-1", "CC-BY-NC-4.0", 500);
    return f;
  }

  it("registers a twin with its birth certificate", async function () {
    const { ipnft, team } = await loadFixture(deploy);
    await expect(ipnft.registerTwin(spec("robot-arm-v1"), "ipfs://twin-1", "CC-BY-NC-4.0", 500))
      .to.emit(ipnft, "TwinRegistered")
      .withArgs(1, team.address, spec("robot-arm-v1"), "ipfs://twin-1");

    const cert = await ipnft.birthCertificate(1);
    expect(cert.specHash).to.equal(spec("robot-arm-v1"));
    expect(cert.creator).to.equal(team.address);
    expect(cert.license).to.equal("CC-BY-NC-4.0");
    expect(await ipnft.ownerOf(1)).to.equal(team.address);
    expect(await ipnft.tokenURI(1)).to.equal("ipfs://twin-1");
    expect(await ipnft.totalRegistered()).to.equal(1);
  });

  it("rejects an empty or duplicate specification", async function () {
    const { ipnft } = await loadFixture(registered);
    await expect(ipnft.registerTwin(ethers.ZeroHash, "", "", 0)).to.be.revertedWithCustomError(ipnft, "EmptyHash");
    await expect(ipnft.registerTwin(spec("robot-arm-v1"), "", "", 0))
      .to.be.revertedWithCustomError(ipnft, "SpecAlreadyRegistered")
      .withArgs(1);
  });

  it("verifies an off-chain specification", async function () {
    const { ipnft } = await loadFixture(registered);
    expect(await ipnft.verifySpec(1, spec("robot-arm-v1"))).to.equal(true);
    expect(await ipnft.verifySpec(1, spec("tampered"))).to.equal(false);
  });

  it("keeps an append-only provenance trail", async function () {
    const { ipnft, other } = await loadFixture(registered);
    await expect(ipnft.recordVersion(1, spec("model-v2"), "retrained on Q3 data"))
      .to.emit(ipnft, "VersionRecorded")
      .withArgs(1, 1, spec("model-v2"), "retrained on Q3 data");

    expect(await ipnft.versionCount(1)).to.equal(2);
    const genesis = await ipnft.versionAt(1, 0);
    expect(genesis.note).to.equal("genesis");
    expect((await ipnft.versionAt(1, 1)).dataHash).to.equal(spec("model-v2"));

    await expect(ipnft.connect(other).recordVersion(1, spec("x"), "")).to.be.revertedWithCustomError(
      ipnft,
      "NotOwnerOrCreator"
    );
  });

  it("pays royalties to the creator (ERC-2981)", async function () {
    const { ipnft, team } = await loadFixture(registered);
    const [receiver, amount] = await ipnft.royaltyInfo(1, ethers.parseEther("1"));
    expect(receiver).to.equal(team.address);
    expect(amount).to.equal(ethers.parseEther("0.05")); // 5 %
    expect(await ipnft.supportsInterface("0x2a55205a")).to.equal(true); // ERC-2981
    expect(await ipnft.supportsInterface("0x80ac58cd")).to.equal(true); // ERC-721
  });
});

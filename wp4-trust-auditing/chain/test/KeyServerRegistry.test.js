const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { py } = require("./py");

describe("KeyServerRegistry (distributed IBE parameters, T4.1)", function () {
  async function deployed() {
    const [dao, outsider, ...ops] = await ethers.getSigners();
    const reg = await ethers.deployContract("KeyServerRegistry", [dao.address]);
    const dkg = py("keyservers", { n: "5", t: "3", seed: "registry" });
    const servers = dkg.shares.map((share, i) => ({ operator: ops[i].address, endpoint: `https://ks${i + 1}.dedt.example`, publicShare: share }));
    return { reg, dao, outsider, dkg, servers };
  }

  it("publishes the DKG result, settable only by the DAO", async function () {
    const { reg, dao, outsider, dkg, servers } = await loadFixture(deployed);
    await expect(reg.connect(outsider).setParameters(dkg.masterPublic, 3, servers)).to.be.revertedWithCustomError(reg, "OwnableUnauthorizedAccount");
    await expect(reg.connect(dao).setParameters(dkg.masterPublic, 3, servers)).to.emit(reg, "ParametersUpdated").withArgs(1, 3, 5);
    const mpk = await reg.masterPublicKey();
    expect(mpk.x.map(String)).to.deep.equal(dkg.masterPublic.x);
    const list = await reg.servers();
    expect(list.length).to.equal(5);
    expect(list[2].endpoint).to.equal("https://ks3.dedt.example");
    expect(list[2].publicShare.y.map(String)).to.deep.equal(dkg.shares[2].y);
    expect(await reg.threshold()).to.equal(3);
    await reg.setParameters(dkg.masterPublic, 2, servers.slice(0, 3));
    expect(await reg.version()).to.equal(2);
    expect((await reg.servers()).length).to.equal(3);
  });

  it("rejects invalid thresholds, operators and curve points", async function () {
    const { reg, dkg, servers } = await loadFixture(deployed);
    await expect(reg.setParameters(dkg.masterPublic, 0, servers)).to.be.revertedWithCustomError(reg, "InvalidParameters");
    await expect(reg.setParameters(dkg.masterPublic, 6, servers)).to.be.revertedWithCustomError(reg, "InvalidParameters");
    const noOp = servers.map((s, i) => (i === 1 ? { ...s, operator: ethers.ZeroAddress } : s));
    await expect(reg.setParameters(dkg.masterPublic, 3, noOp)).to.be.revertedWithCustomError(reg, "InvalidParameters");
    const off = { x: dkg.masterPublic.x, y: [dkg.masterPublic.y[0], (BigInt(dkg.masterPublic.y[1]) + 1n).toString()] };
    await expect(reg.setParameters(off, 3, servers)).to.be.reverted; // not on the twist: precompile fails
    const badShare = servers.map((s, i) => (i === 4 ? { ...s, publicShare: off } : s));
    await expect(reg.setParameters(dkg.masterPublic, 3, badShare)).to.be.reverted;
  });
});

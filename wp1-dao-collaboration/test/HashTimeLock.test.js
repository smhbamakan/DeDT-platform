const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { twoChains } = require("./fixtures");

const ETH = (n) => ethers.parseEther(String(n));
const HOUR = 3600;

describe("HashTimeLock (atomic swap, paper §3.1.1)", function () {
  /**
   * Team #1 sells its twin dNFT (chain A) to team #2 for 2 ETH (chain B).
   * Team #1 knows the secret s, so its own lock on A uses the longer timelock.
   */
  async function swapReady() {
    const f = await twoChains();
    const htlcA = await ethers.deployContract("HashTimeLock");
    const htlcB = await ethers.deployContract("HashTimeLock");
    await f.dnftA.connect(f.team1).mint(ethers.id("twin"), "ipfs://twin");

    const secret = ethers.hexlify(ethers.randomBytes(32));
    const hashlock = ethers.keccak256(secret);
    const now = await time.latest();

    await f.dnftA.connect(f.team1).approve(await htlcA.getAddress(), 1);
    const txA = await htlcA.connect(f.team1).lockNFT(f.team2.address, await f.dnftA.getAddress(), 1, hashlock, now + 48 * HOUR);
    const txB = await htlcB.connect(f.team2).lockETH(f.team1.address, hashlock, now + 24 * HOUR, { value: ETH(2) });
    const idA = (await htlcA.queryFilter(htlcA.filters.Locked(), txA.blockNumber))[0].args.id;
    const idB = (await htlcB.queryFilter(htlcB.filters.Locked(), txB.blockNumber))[0].args.id;
    return { ...f, htlcA, htlcB, secret, idA, idB };
  }

  it("completes both legs once the secret is revealed", async function () {
    const { htlcA, htlcB, dnftA, team1, team2, secret, idA, idB } = await loadFixture(swapReady);
    // team #1 claims the ETH on B, revealing s on-chain
    await expect(htlcB.connect(team1).claim(idB, secret)).to.changeEtherBalance(team1, ETH(2));
    const revealed = (await htlcB.queryFilter(htlcB.filters.Claimed()))[0].args.preimage;
    // team #2 reuses the revealed s to claim the dNFT on A
    await htlcA.connect(team2).claim(idA, revealed);
    expect(await dnftA.ownerOf(1)).to.equal(team2.address);
    await expect(htlcA.claim(idA, secret)).to.be.revertedWithCustomError(htlcA, "AlreadySettled");
  });

  it("rejects a wrong preimage", async function () {
    const { htlcB, team1, idB } = await loadFixture(swapReady);
    await expect(htlcB.connect(team1).claim(idB, ethers.ZeroHash)).to.be.revertedWithCustomError(htlcB, "WrongPreimage");
  });

  it("refunds both parties if the swap is abandoned", async function () {
    const { htlcA, htlcB, dnftA, team1, team2, idA, idB } = await loadFixture(swapReady);
    await expect(htlcB.connect(team2).refund(idB)).to.be.revertedWithCustomError(htlcB, "NotExpired");
    await time.increase(48 * HOUR);
    await expect(htlcB.connect(team1).refund(idB)).to.be.revertedWithCustomError(htlcB, "NotSender");
    await expect(htlcB.connect(team2).refund(idB)).to.changeEtherBalance(team2, ETH(2));
    await htlcA.connect(team1).refund(idA);
    expect(await dnftA.ownerOf(1)).to.equal(team1.address);
  });

  it("cannot be claimed after expiry", async function () {
    const { htlcB, team1, secret, idB } = await loadFixture(swapReady);
    await time.increase(24 * HOUR);
    await expect(htlcB.connect(team1).claim(idB, secret)).to.be.revertedWithCustomError(htlcB, "Expired");
  });

  it("validates lock parameters", async function () {
    const { htlcA, team1, idA } = await loadFixture(swapReady);
    const future = (await time.latest()) + HOUR;
    const hl = ethers.id("x");
    await expect(htlcA.lockETH(team1.address, hl, future)).to.be.revertedWithCustomError(htlcA, "InvalidLock");
    await expect(htlcA.lockETH(ethers.ZeroAddress, hl, future, { value: 1 })).to.be.revertedWithCustomError(htlcA, "InvalidLock");
    await expect(htlcA.lockETH(team1.address, ethers.ZeroHash, future, { value: 1 })).to.be.revertedWithCustomError(htlcA, "InvalidLock");
    await expect(htlcA.lockETH(team1.address, hl, 1, { value: 1 })).to.be.revertedWithCustomError(htlcA, "InvalidLock");
    await expect(htlcA.lockNFT(team1.address, ethers.ZeroAddress, 1, hl, future)).to.be.revertedWithCustomError(htlcA, "InvalidLock");
    await expect(htlcA.claim(ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(htlcA, "InvalidLock");
    await expect(htlcA.refund(ethers.ZeroHash)).to.be.revertedWithCustomError(htlcA, "InvalidLock");
    expect((await htlcA.locks(idA)).settled).to.equal(false);
  });
});

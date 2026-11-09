const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 60 * 60;

describe("QuadraticMatchingPool", function () {
  async function round() {
    const [owner, sponsor, a, b, c, d, recA, recB] = await ethers.getSigners();
    const eur = await ethers.deployContract("MockStablecoin");
    const qf = await ethers.deployContract("QuadraticMatchingPool", [await eur.getAddress(), 14 * DAY]);
    for (const s of [sponsor, a, b, c, d]) {
      await eur.mint(s.address, E(100000));
      await eur.connect(s).approve(await qf.getAddress(), ethers.MaxUint256);
    }
    await qf.addComponent(recA.address); // open model library, broad support
    await qf.addComponent(recB.address); // niche component, one large backer
    await qf.setVerified([a.address, b.address, c.address, d.address], true);
    return { eur, qf, owner, sponsor, a, b, c, d, recA, recB };
  }

  it("computes the quadratic match (sum of square roots, squared, minus contributions)", async function () {
    const f = await loadFixture(round);
    for (const s of [f.a, f.b, f.c, f.d]) await f.qf.connect(s).contribute(0, E(100)); // 4 x 100
    await f.qf.connect(f.a).contribute(1, E(400)); // 1 x 400
    // component 0: (4*sqrt(100))^2 - 400 = 1600 - 400 = 1200 ; component 1: 400 - 400 = 0
    expect(await f.qf.rawMatch(0)).to.equal(E(1200));
    expect(await f.qf.rawMatch(1)).to.equal(0);
  });

  it("updates the square-root sum correctly for repeat contributions", async function () {
    const f = await loadFixture(round);
    await f.qf.connect(f.a).contribute(0, E(36));
    await f.qf.connect(f.a).contribute(0, E(64)); // a now 100 -> sqrt 10
    await f.qf.connect(f.b).contribute(0, E(100));
    expect(await f.qf.rawMatch(0)).to.equal(E(200)); // (10+10)^2*1e6 scale - 200
  });

  it("scales matches down when the pool is too small and pays out", async function () {
    const f = await loadFixture(round);
    await f.qf.connect(f.sponsor).fundPool(E(600));
    for (const s of [f.a, f.b, f.c, f.d]) await f.qf.connect(s).contribute(0, E(100));
    await expect(f.qf.close()).to.be.revertedWithCustomError(f.qf, "RoundOpen");
    await time.increase(14 * DAY);
    await expect(f.qf.connect(f.a).contribute(0, E(1))).to.be.revertedWithCustomError(f.qf, "RoundOver");
    await f.qf.close();
    expect(await f.qf.matchOf(0)).to.equal(E(600));
    await expect(f.qf.payout(0)).to.changeTokenBalance(f.eur, f.recA, E(1000));
    await expect(f.qf.payout(0)).to.be.revertedWithCustomError(f.qf, "AlreadyDone");
  });

  it("pays the full match when the pool suffices and returns the rest to the sponsor", async function () {
    const f = await loadFixture(round);
    await f.qf.connect(f.sponsor).fundPool(E(5000));
    for (const s of [f.a, f.b]) await f.qf.connect(s).contribute(0, E(100));
    await time.increase(14 * DAY);
    await f.qf.close();
    await expect(f.qf.sweep()).to.be.revertedWithCustomError(f.qf, "RoundOpen");
    await f.qf.payout(0);
    await f.qf.payout(1);
    await expect(f.qf.sweep()).to.changeTokenBalance(f.eur, f.owner, E(4800));
  });

  it("admits only verified contributors and only the owner manages the round", async function () {
    const f = await loadFixture(round);
    await f.qf.setVerified([f.d.address], false);
    await expect(f.qf.connect(f.d).contribute(0, E(1))).to.be.revertedWithCustomError(f.qf, "NotVerified");
    await expect(f.qf.connect(f.a).contribute(0, 0)).to.be.revertedWithCustomError(f.qf, "Nothing");
    await expect(f.qf.connect(f.a).addComponent(f.a.address)).to.be.revertedWithCustomError(f.qf, "OwnableUnauthorizedAccount");
    await expect(f.qf.payout(0)).to.be.revertedWithCustomError(f.qf, "RoundOpen");
  });
});

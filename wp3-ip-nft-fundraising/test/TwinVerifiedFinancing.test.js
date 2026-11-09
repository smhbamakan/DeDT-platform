const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const E = (n) => ethers.parseUnits(String(n), 6); // mock euro stablecoin, 6 decimals
const DAY = 24 * 60 * 60;
const Phase = { Funding: 0, Active: 1, Completed: 2, Cancelled: 3 };
const MS = { Pending: 0, Claimed: 1, Disputed: 2, Accepted: 3, Rejected: 4 };
const KPI = ethers.id("availability");

function terms(over = {}) {
  return {
    fundingDuration: 30 * DAY, challengeWindow: 3 * DAY, voteWindow: 5 * DAY,
    bondBps: 500, quorumBps: 2000, thetaBps: 3000, capPerBacker: 0, advance: 0, allowListOnly: false, ...over,
  };
}
const ms = (budget, target = 90, duration = 60 * DAY) => ({
  budget: E(budget), duration, kpi: KPI, target, reported: 0, evidence: ethers.ZeroHash,
  claimedAt: 0, disputeEnd: 0, challenger: ethers.ZeroAddress, votesFor: 0, votesAgainst: 0, state: 0,
});

describe("TwinVerifiedFinancing (DTVF)", function () {
  async function deployed() {
    const [team, dev, alice, bob, carol, outsider] = await ethers.getSigners();
    const ipnft = await ethers.deployContract("DigitalTwinIPNFT");
    const dtvf = await ethers.deployContract("TwinVerifiedFinancing", [await ipnft.getAddress()]);
    const eur = await ethers.deployContract("MockStablecoin");
    for (const s of [team, alice, bob, carol, outsider]) {
      await eur.mint(s.address, E(1_000_000));
      await eur.connect(s).approve(await dtvf.getAddress(), ethers.MaxUint256);
    }
    await ipnft.registerTwin(ethers.id("production-line-twin"), "ipfs://line", "CC-BY-NC-4.0", 250);
    await ipnft.approve(await dtvf.getAddress(), 1);
    return { ipnft, dtvf, eur, team, dev, alice, bob, carol, outsider };
  }

  async function created(t = terms()) {
    const f = await deployed();
    await f.dtvf.createProject(1, await f.eur.getAddress(), [ms(40), ms(60)], [f.team.address, f.dev.address], [7000, 3000], t);
    return f;
  }

  async function active() {
    const f = await created();
    await f.dtvf.connect(f.alice).contribute(0, E(60));
    await f.dtvf.connect(f.bob).contribute(0, E(30));
    await f.dtvf.connect(f.carol).contribute(0, E(10));
    await f.dtvf.closeFunding(0);
    return f;
  }

  async function claimed() {
    const f = await active();
    await f.ipnft.recordVersion(1, ethers.id("kpi-batch-1"), "pilot KPI evidence");
    await f.dtvf.claim(0, 95, 1);
    return f;
  }

  async function disputed() {
    const f = await claimed();
    await f.dtvf.connect(f.bob).challenge(0);
    return f;
  }

  describe("set-up and funding", function () {
    it("escrows the IP-NFT and sets the goal to the sum of milestone budgets", async function () {
      const { ipnft, dtvf } = await loadFixture(created);
      expect(await ipnft.ownerOf(1)).to.equal(await dtvf.getAddress());
      const p = await dtvf.project(0);
      expect(p.goal).to.equal(E(100));
      expect(p.phase).to.equal(Phase.Funding);
      expect(await dtvf.milestoneCount(0)).to.equal(2);
    });

    it("rejects invalid splits, empty milestones and bad terms", async function () {
      const { dtvf, eur, team, dev } = await loadFixture(deployed);
      const a = await eur.getAddress();
      await expect(dtvf.createProject(1, a, [ms(1)], [team.address, dev.address], [5000, 4000], terms()))
        .to.be.revertedWithCustomError(dtvf, "BadParameters");
      await expect(dtvf.createProject(1, a, [], [team.address], [10000], terms()))
        .to.be.revertedWithCustomError(dtvf, "BadParameters");
      await expect(dtvf.createProject(1, a, [ms(1)], [team.address], [10000], terms({ thetaBps: 10001 })))
        .to.be.revertedWithCustomError(dtvf, "BadParameters");
      await expect(dtvf.createProject(1, a, [ms(0)], [team.address], [10000], terms()))
        .to.be.revertedWithCustomError(dtvf, "BadParameters");
    });

    it("caps contributions at the goal and per backer", async function () {
      const { dtvf, alice } = await loadFixture(created);
      await expect(dtvf.connect(alice).contribute(0, E(101))).to.be.revertedWithCustomError(dtvf, "CapExceeded");
      const f = await created(terms({ capPerBacker: E(20) }));
      await expect(f.dtvf.connect(f.alice).contribute(0, E(21))).to.be.revertedWithCustomError(f.dtvf, "CapExceeded");
    });

    it("enforces the allow-list when enabled", async function () {
      const f = await created(terms({ allowListOnly: true }));
      await expect(f.dtvf.connect(f.alice).contribute(0, E(1))).to.be.revertedWithCustomError(f.dtvf, "NotAllowed");
      await expect(f.dtvf.connect(f.alice).setAllowed(0, [f.alice.address], true)).to.be.revertedWithCustomError(f.dtvf, "NotTeam");
      await f.dtvf.setAllowed(0, [f.alice.address], true);
      await expect(f.dtvf.connect(f.alice).contribute(0, E(1))).to.emit(f.dtvf, "Contributed");
    });

    it("cancels and refunds in full if the goal is not reached", async function () {
      const { dtvf, eur, ipnft, team, alice } = await loadFixture(created);
      await dtvf.connect(alice).contribute(0, E(50));
      await expect(dtvf.closeFunding(0)).to.be.revertedWithCustomError(dtvf, "TooEarly");
      await time.increase(30 * DAY);
      await expect(dtvf.connect(alice).contribute(0, E(1))).to.be.revertedWithCustomError(dtvf, "TooLate");
      await dtvf.closeFunding(0);
      expect((await dtvf.project(0)).phase).to.equal(Phase.Cancelled);
      expect(await ipnft.ownerOf(1)).to.equal(team.address);
      await expect(dtvf.connect(alice).refund(0)).to.changeTokenBalance(eur, alice, E(50));
      await expect(dtvf.connect(alice).refund(0)).to.be.revertedWithCustomError(dtvf, "AlreadyDone");
    });

    it("activates as soon as the goal is reached", async function () {
      const { dtvf } = await loadFixture(active);
      expect((await dtvf.project(0)).phase).to.equal(Phase.Active);
    });
  });

  describe("claims", function () {
    it("requires the team, a met target and fresh evidence from the provenance trail", async function () {
      const f = await loadFixture(active);
      await expect(f.dtvf.connect(f.alice).claim(0, 95, 0)).to.be.revertedWithCustomError(f.dtvf, "NotTeam");
      await expect(f.dtvf.claim(0, 95, 0)).to.be.revertedWithCustomError(f.dtvf, "BadEvidence"); // genesis is older
      await f.ipnft.recordVersion(1, ethers.id("batch"), "evidence");
      await expect(f.dtvf.claim(0, 80, 1)).to.be.revertedWithCustomError(f.dtvf, "TargetNotMet");
      await expect(f.dtvf.claim(0, 95, 1)).to.emit(f.dtvf, "Claimed").withArgs(0, 0, 95, ethers.id("batch"));
      const m = await f.dtvf.milestone(0, 0);
      expect(m.state).to.equal(MS.Claimed);
      expect(m.evidence).to.equal(ethers.id("batch"));
    });

    it("takes a bond from the team when claiming", async function () {
      const f = await loadFixture(active);
      await f.ipnft.recordVersion(1, ethers.id("batch"), "evidence");
      await expect(f.dtvf.claim(0, 95, 1)).to.changeTokenBalance(f.eur, f.team, -E(2)); // 5% of 40
    });

    it("accepts an unchallenged claim after the window and pays the team by its split", async function () {
      const f = await loadFixture(claimed);
      await expect(f.dtvf.resolve(0)).to.be.revertedWithCustomError(f.dtvf, "TooEarly");
      await time.increase(3 * DAY + 1);
      await expect(f.dtvf.resolve(0)).to.emit(f.dtvf, "MilestoneResolved").withArgs(0, 0, true, E(40));
      const a = await f.eur.getAddress();
      expect(await f.dtvf.credit(a, f.team.address)).to.equal(E(28) + E(2)); // 70% + bond back
      expect(await f.dtvf.credit(a, f.dev.address)).to.equal(E(12));
      const p = await f.dtvf.project(0);
      expect(p.current).to.equal(1);
      expect(p.released).to.equal(E(40));
      await expect(f.dtvf.connect(f.dev).withdraw(a)).to.changeTokenBalance(f.eur, f.dev, E(12));
      await expect(f.dtvf.connect(f.dev).withdraw(a)).to.be.revertedWithCustomError(f.dtvf, "Nothing");
    });

    it("completes the project after the last milestone", async function () {
      const f = await loadFixture(claimed);
      await time.increase(3 * DAY + 1);
      await f.dtvf.resolve(0);
      await f.ipnft.recordVersion(1, ethers.id("batch-2"), "scale-up evidence");
      await f.dtvf.claim(0, 99, 2);
      await time.increase(3 * DAY + 1);
      await f.dtvf.resolve(0);
      expect((await f.dtvf.project(0)).phase).to.equal(Phase.Completed);
    });

    it("lets anyone cancel an overdue milestone and refunds the unreleased balance", async function () {
      const f = await loadFixture(active);
      await expect(f.dtvf.cancelOverdue(0)).to.be.revertedWithCustomError(f.dtvf, "TooEarly");
      await time.increase(60 * DAY + 1);
      await f.ipnft.recordVersion(1, ethers.id("late"), "late");
      await expect(f.dtvf.claim(0, 95, 1)).to.be.revertedWithCustomError(f.dtvf, "TooLate");
      await f.dtvf.connect(f.outsider).cancelOverdue(0);
      await expect(f.dtvf.connect(f.alice).refund(0)).to.changeTokenBalance(f.eur, f.alice, E(60));
      await expect(f.dtvf.connect(f.outsider).refund(0)).to.be.revertedWithCustomError(f.dtvf, "Nothing");
    });
  });

  describe("disputes", function () {
    it("opens a dispute only within the challenge window, against a bond", async function () {
      const f = await loadFixture(claimed);
      await expect(f.dtvf.connect(f.bob).challenge(0)).to.changeTokenBalance(f.eur, f.bob, -E(2));
      expect((await f.dtvf.milestone(0, 0)).state).to.equal(MS.Disputed);
      const g = await claimed();
      await time.increase(3 * DAY + 1);
      await expect(g.dtvf.connect(g.bob).challenge(0)).to.be.revertedWithCustomError(g.dtvf, "TooLate");
    });

    it("lets only backers vote, once, with weight equal to their contribution", async function () {
      const f = await loadFixture(disputed);
      await expect(f.dtvf.connect(f.outsider).vote(0, false)).to.be.revertedWithCustomError(f.dtvf, "NotBacker");
      await expect(f.dtvf.connect(f.alice).vote(0, false)).to.emit(f.dtvf, "Voted").withArgs(0, 0, f.alice.address, false, E(60));
      await expect(f.dtvf.connect(f.alice).vote(0, true)).to.be.revertedWithCustomError(f.dtvf, "AlreadyDone");
    });

    it("rejects the claim when a quorate majority votes against: challenger wins bonds, backers recover all", async function () {
      const f = await loadFixture(disputed);
      await f.dtvf.connect(f.alice).vote(0, false);
      await f.dtvf.connect(f.carol).vote(0, true);
      await expect(f.dtvf.resolve(0)).to.be.revertedWithCustomError(f.dtvf, "TooEarly");
      await time.increase(5 * DAY + 1);
      await expect(f.dtvf.resolve(0)).to.emit(f.dtvf, "ProjectCancelled").withArgs(0, E(100));
      expect(await f.dtvf.credit(await f.eur.getAddress(), f.bob.address)).to.equal(E(4));
      expect(await f.ipnft.ownerOf(1)).to.equal(f.team.address);
      await expect(f.dtvf.connect(f.bob).refund(0)).to.changeTokenBalance(f.eur, f.bob, E(30));
    });

    it("upholds the claim without quorum (burden of proof on the challenger)", async function () {
      const f = await loadFixture(disputed);
      await f.dtvf.connect(f.carol).vote(0, false); // 10% < 20% quorum
      await time.increase(5 * DAY + 1);
      await f.dtvf.resolve(0);
      expect((await f.dtvf.milestone(0, 0)).state).to.equal(MS.Accepted);
      expect(await f.dtvf.credit(await f.eur.getAddress(), f.team.address)).to.equal(E(28) + E(4));
    });

    it("refunds only the unreleased balance if a later milestone is rejected", async function () {
      const f = await loadFixture(claimed);
      await time.increase(3 * DAY + 1);
      await f.dtvf.resolve(0); // 40 released
      await f.ipnft.recordVersion(1, ethers.id("b2"), "b2");
      await f.dtvf.claim(0, 99, 2);
      await f.dtvf.connect(f.bob).challenge(0);
      await f.dtvf.connect(f.alice).vote(0, false);
      await time.increase(5 * DAY + 1);
      await f.dtvf.resolve(0);
      await expect(f.dtvf.connect(f.alice).refund(0)).to.changeTokenBalance(f.eur, f.alice, E(36)); // 60% of 60
    });

    it("rejects actions in the wrong state", async function () {
      const f = await loadFixture(active);
      await expect(f.dtvf.challenge(0)).to.be.revertedWithCustomError(f.dtvf, "WrongState");
      await expect(f.dtvf.vote(0, true)).to.be.revertedWithCustomError(f.dtvf, "WrongState");
      await expect(f.dtvf.resolve(0)).to.be.revertedWithCustomError(f.dtvf, "WrongState");
      await expect(f.dtvf.refund(0)).to.be.revertedWithCustomError(f.dtvf, "WrongPhase");
      await expect(f.dtvf.closeFunding(0)).to.be.revertedWithCustomError(f.dtvf, "WrongPhase");
    });
  });

  it("releases the advance to the team when funding succeeds", async function () {
    const f = await created(terms({ advance: E(10) }));
    expect((await f.dtvf.project(0)).goal).to.equal(E(110));
    await f.dtvf.connect(f.alice).contribute(0, E(110));
    await f.dtvf.closeFunding(0);
    const a = await f.eur.getAddress();
    expect(await f.dtvf.credit(a, f.team.address)).to.equal(E(7));
    expect(await f.dtvf.credit(a, f.dev.address)).to.equal(E(3));
    expect((await f.dtvf.project(0)).released).to.equal(E(10));
    await time.increase(60 * DAY + 1);
    await f.dtvf.cancelOverdue(0);
    await expect(f.dtvf.connect(f.alice).refund(0)).to.changeTokenBalance(f.eur, f.alice, E(100));
  });

  describe("income sharing", function () {
    it("splits income between backers (theta) and team members", async function () {
      const f = await loadFixture(active);
      await f.dtvf.connect(f.outsider).depositRevenue(0, E(1000)); // 30% to backers
      expect(await f.dtvf.pendingRevenue(0, f.alice.address)).to.equal(E(180));
      expect(await f.dtvf.pendingRevenue(0, f.carol.address)).to.equal(E(30));
      const a = await f.eur.getAddress();
      expect(await f.dtvf.credit(a, f.team.address)).to.equal(E(490));
      expect(await f.dtvf.credit(a, f.dev.address)).to.equal(E(210));
      await f.dtvf.connect(f.alice).claimRevenue(0);
      await expect(f.dtvf.connect(f.alice).claimRevenue(0)).to.be.revertedWithCustomError(f.dtvf, "Nothing");
      await f.dtvf.connect(f.outsider).depositRevenue(0, E(100));
      expect(await f.dtvf.pendingRevenue(0, f.alice.address)).to.equal(E(18));
      await expect(f.dtvf.connect(f.alice).withdraw(a)).to.changeTokenBalance(f.eur, f.alice, E(180));
    });

    it("does not accept income before activation or after cancellation", async function () {
      const f = await loadFixture(created);
      await expect(f.dtvf.depositRevenue(0, E(1))).to.be.revertedWithCustomError(f.dtvf, "WrongPhase");
      const g = await loadFixture(active);
      await expect(g.dtvf.depositRevenue(0, 0)).to.be.revertedWithCustomError(g.dtvf, "Nothing");
    });
  });

  it("refuses NFTs that do not come from the registry", async function () {
    const f = await loadFixture(deployed);
    await expect(f.dtvf.onERC721Received(f.team.address, f.team.address, 1, "0x"))
      .to.be.revertedWithCustomError(f.dtvf, "UnexpectedNFT");
  });
});

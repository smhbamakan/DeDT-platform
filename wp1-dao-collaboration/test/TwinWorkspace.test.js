const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const ETH = (n) => ethers.parseEther(String(n));
const DAY = 86400;
const BOND = ETH("0.1");
const Status = { Open: 0, Claimed: 1, Submitted: 2, Completed: 3, Cancelled: 4 };

// Unit tests of the workspace logic. A plain account plays the DAO (the timelock in production),
// so every rule can be tested without running a vote; TwinTeamDAO.test.js covers the votes.
describe("TwinWorkspace", function () {
  async function deployed() {
    const [dao, lead, alice, bob, outsider] = await ethers.getSigners();
    const reputation = await ethers.deployContract("DTReputation");
    const workspace = await ethers.deployContract("TwinWorkspace", [await reputation.getAddress(), dao.address, BOND, 10]);
    for (const [m, rep] of [[lead, 100], [alice, 50], [bob, 30]]) await reputation.mint(m.address, rep);
    await reputation.transferOwnership(await workspace.getAddress());
    await dao.sendTransaction({ to: await workspace.getAddress(), value: ETH(10) });
    await workspace.createProject("Wind turbine twin", ethers.ZeroAddress, 1, lead.address);
    const deadline = (await time.latest()) + 7 * DAY;
    await workspace.openTask(0, ethers.id("calibrate vibration model"), ETH(2), 20, deadline);
    return { reputation, workspace, dao, lead, alice, bob, outsider, deadline };
  }

  describe("reputation", function () {
    it("is non-transferable, whole-point and self-delegated", async function () {
      const { reputation, alice, bob } = await loadFixture(deployed);
      expect(await reputation.decimals()).to.equal(0);
      expect(await reputation.getVotes(alice.address)).to.equal(50);
      expect(await reputation.delegates(alice.address)).to.equal(alice.address);
      await expect(reputation.connect(alice).transfer(bob.address, 1)).to.be.revertedWithCustomError(reputation, "NonTransferable");
    });

    it("can only be minted and burned by the workspace", async function () {
      const { reputation, alice } = await loadFixture(deployed);
      await expect(reputation.connect(alice).mint(alice.address, 1)).to.be.revertedWithCustomError(reputation, "OwnableUnauthorizedAccount");
    });
  });

  describe("membership (DAO only)", function () {
    it("admits, rewards and expels members", async function () {
      const { reputation, workspace, alice, outsider } = await loadFixture(deployed);
      await expect(workspace.admitMember(outsider.address, 25)).to.emit(workspace, "MemberAdmitted").withArgs(outsider.address, 25);
      await expect(workspace.admitMember(outsider.address, 25)).to.be.revertedWithCustomError(workspace, "AlreadyMember");
      await workspace.grantReputation(outsider.address, 5);
      expect(await reputation.balanceOf(outsider.address)).to.equal(30);
      await expect(workspace.expelMember(outsider.address)).to.emit(workspace, "MemberExpelled").withArgs(outsider.address, 30);
      await expect(workspace.expelMember(outsider.address)).to.be.revertedWithCustomError(workspace, "NotMember");
      await expect(workspace.grantReputation(outsider.address, 5)).to.be.revertedWithCustomError(workspace, "NotMember");
      await expect(workspace.connect(alice).admitMember(alice.address, 1)).to.be.revertedWithCustomError(workspace, "OwnableUnauthorizedAccount");
    });
  });

  describe("projects", function () {
    it("requires a member as lead and can be updated or closed", async function () {
      const { workspace, alice, outsider } = await loadFixture(deployed);
      await expect(workspace.createProject("x", ethers.ZeroAddress, 0, outsider.address)).to.be.revertedWithCustomError(workspace, "NotMember");
      await workspace.updateProject(0, alice.address, false);
      const p = await workspace.project(0);
      expect(p.lead).to.equal(alice.address);
      expect(p.active).to.equal(false);
      await expect(workspace.connect(alice).submitExperiment(0, ethers.id("c"), ethers.id("r"))).to.be.revertedWithCustomError(workspace, "InvalidProject");
      await expect(workspace.updateProject(9, alice.address, true)).to.be.revertedWithCustomError(workspace, "InvalidProject");
      await expect(workspace.project(9)).to.be.revertedWithCustomError(workspace, "InvalidProject");
    });
  });

  describe("tasks (parallel workstreams)", function () {
    it("pays the bounty and reputation when the lead approves the result", async function () {
      const { reputation, workspace, lead, alice } = await loadFixture(deployed);
      await workspace.connect(alice).claimTask(0);
      await workspace.connect(alice).submitResult(0, ethers.id("calibration report"));
      await expect(workspace.connect(lead).approveTask(0)).to.changeEtherBalance(alice, ETH(2));
      expect(await reputation.balanceOf(alice.address)).to.equal(70);
      expect((await workspace.task(0)).status).to.equal(Status.Completed);
      expect(await workspace.committedBounties()).to.equal(0);
    });

    it("reserves treasury for open tasks", async function () {
      const { workspace, deadline } = await loadFixture(deployed);
      expect(await workspace.availableTreasury()).to.equal(ETH(8));
      await expect(workspace.openTask(0, ethers.id("big"), ETH(9), 0, deadline)).to.be.revertedWithCustomError(workspace, "InsufficientTreasury");
      await workspace.openTask(0, ethers.id("parallel task"), ETH(8), 5, deadline);
      expect(await workspace.availableTreasury()).to.equal(0);
      await workspace.cancelTask(1);
      expect(await workspace.availableTreasury()).to.equal(ETH(8));
      await expect(workspace.cancelTask(1)).to.be.revertedWithCustomError(workspace, "WrongStatus");
    });

    it("lets the lead reject a result, reopening the task", async function () {
      const { workspace, lead, alice, bob } = await loadFixture(deployed);
      await workspace.connect(alice).claimTask(0);
      await workspace.connect(alice).submitResult(0, ethers.id("weak"));
      await expect(workspace.connect(bob).rejectResult(0)).to.be.revertedWithCustomError(workspace, "NotLead");
      await expect(workspace.connect(lead).rejectResult(0)).to.emit(workspace, "TaskRejected");
      await workspace.connect(bob).claimTask(0);
      expect((await workspace.task(0)).assignee).to.equal(bob.address);
    });

    it("needs the DAO, not the lead, to accept the lead's own work", async function () {
      const { workspace, dao, lead } = await loadFixture(deployed);
      await workspace.connect(lead).claimTask(0);
      await workspace.connect(lead).submitResult(0, ethers.id("own work"));
      await expect(workspace.connect(lead).approveTask(0)).to.be.revertedWithCustomError(workspace, "NotLead");
      await expect(workspace.connect(dao).approveTask(0)).to.changeEtherBalance(lead, ETH(2));
    });

    it("enforces membership, assignee, status and deadline", async function () {
      const { workspace, lead, alice, bob, outsider } = await loadFixture(deployed);
      await expect(workspace.connect(outsider).claimTask(0)).to.be.revertedWithCustomError(workspace, "NotMember");
      await expect(workspace.connect(alice).claimTask(5)).to.be.revertedWithCustomError(workspace, "InvalidTask");
      await workspace.connect(alice).claimTask(0);
      await expect(workspace.connect(bob).claimTask(0)).to.be.revertedWithCustomError(workspace, "WrongStatus");
      await expect(workspace.connect(bob).submitResult(0, ethers.id("x"))).to.be.revertedWithCustomError(workspace, "WrongStatus");
      await expect(workspace.connect(lead).approveTask(0)).to.be.revertedWithCustomError(workspace, "WrongStatus");
      await expect(workspace.connect(lead).rejectResult(0)).to.be.revertedWithCustomError(workspace, "WrongStatus");
      await time.increase(7 * DAY);
      await expect(workspace.connect(alice).submitResult(0, ethers.id("late"))).to.be.revertedWithCustomError(workspace, "DeadlinePassed");
      await expect(workspace.openTask(0, ethers.id("past"), 0, 0, 1)).to.be.revertedWithCustomError(workspace, "DeadlinePassed");
    });

    it("rejects claims after the deadline", async function () {
      const { workspace, alice } = await loadFixture(deployed);
      await time.increase(7 * DAY);
      await expect(workspace.connect(alice).claimTask(0)).to.be.revertedWithCustomError(workspace, "DeadlinePassed");
    });
  });

  describe("computational experiments", function () {
    it("records experiments and reputation-weighted endorsements", async function () {
      const { workspace, lead, alice, bob, outsider } = await loadFixture(deployed);
      await workspace.connect(alice).submitExperiment(0, ethers.id("LSTM, lr=1e-3, data v4"), ethers.id("RMSE 0.031"));
      await workspace.connect(lead).endorseExperiment(0);
      await workspace.connect(bob).endorseExperiment(0);
      const e = await workspace.experiment(0);
      expect(e.author).to.equal(alice.address);
      expect(e.endorsements).to.equal(2);
      expect(e.endorsementWeight).to.equal(130);
      await expect(workspace.connect(alice).endorseExperiment(0)).to.be.revertedWithCustomError(workspace, "CannotEndorse");
      await expect(workspace.connect(bob).endorseExperiment(0)).to.be.revertedWithCustomError(workspace, "CannotEndorse");
      await expect(workspace.connect(bob).endorseExperiment(7)).to.be.revertedWithCustomError(workspace, "CannotEndorse");
      await expect(workspace.connect(outsider).submitExperiment(0, ethers.id("c"), ethers.id("r"))).to.be.revertedWithCustomError(workspace, "NotMember");
    });
  });

  describe("misbehaviour reports (collective monitoring)", function () {
    it("upheld: slashes the accused, refunds and rewards the reporter", async function () {
      const { reputation, workspace, alice, bob } = await loadFixture(deployed);
      await workspace.connect(alice).fileReport(bob.address, ethers.id("evidence: falsified sensor data"), { value: BOND });
      expect(await workspace.pendingBonds()).to.equal(BOND);
      await expect(workspace.resolveReport(0, true, 20)).to.changeEtherBalance(alice, BOND);
      expect(await reputation.balanceOf(bob.address)).to.equal(10);
      expect(await reputation.balanceOf(alice.address)).to.equal(60);
      expect(await workspace.pendingBonds()).to.equal(0);
      await expect(workspace.resolveReport(0, true, 1)).to.be.revertedWithCustomError(workspace, "WrongStatus");
    });

    it("caps the slash at the accused's reputation", async function () {
      const { reputation, workspace, alice, bob } = await loadFixture(deployed);
      await workspace.connect(alice).fileReport(bob.address, ethers.id("e"), { value: BOND });
      await expect(workspace.resolveReport(0, true, 1000)).to.emit(workspace, "ReportResolved").withArgs(0, true, 30);
      expect(await reputation.balanceOf(bob.address)).to.equal(0);
    });

    it("dismissed: the bond goes to the treasury", async function () {
      const { workspace, alice, bob } = await loadFixture(deployed);
      await workspace.connect(alice).fileReport(bob.address, ethers.id("weak evidence"), { value: BOND });
      const before = await workspace.availableTreasury();
      await workspace.resolveReport(0, false, 0);
      expect((await workspace.report(0)).status).to.equal(2);
      expect(await workspace.availableTreasury()).to.equal(before + BOND);
    });

    it("validates bond, accused and report id; bonds cannot fund tasks", async function () {
      const { workspace, alice, bob, outsider, deadline } = await loadFixture(deployed);
      await expect(workspace.connect(alice).fileReport(bob.address, ethers.id("e"))).to.be.revertedWithCustomError(workspace, "WrongBond");
      await expect(workspace.connect(alice).fileReport(alice.address, ethers.id("e"), { value: BOND })).to.be.revertedWithCustomError(workspace, "InvalidReport");
      await expect(workspace.connect(alice).fileReport(outsider.address, ethers.id("e"), { value: BOND })).to.be.revertedWithCustomError(workspace, "InvalidReport");
      await expect(workspace.connect(outsider).fileReport(bob.address, ethers.id("e"), { value: BOND })).to.be.revertedWithCustomError(workspace, "NotMember");
      await expect(workspace.resolveReport(3, true, 1)).to.be.revertedWithCustomError(workspace, "InvalidReport");

      await workspace.connect(alice).fileReport(bob.address, ethers.id("e"), { value: BOND });
      await expect(workspace.openTask(0, ethers.id("x"), ETH(8) + 1n, 0, deadline)).to.be.revertedWithCustomError(workspace, "InsufficientTreasury");
    });

    it("lets the DAO change the bond and reward", async function () {
      const { workspace } = await loadFixture(deployed);
      await expect(workspace.setParameters(ETH(1), 3)).to.emit(workspace, "ParametersSet").withArgs(ETH(1), 3);
      expect(await workspace.reportBond()).to.equal(ETH(1));
    });
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployDAO, action, runProposal } = require("../lib/dao");

const ETH = (n) => ethers.parseEther(String(n));
const FOR = 1;
const AGAINST = 0;
const ABSTAIN = 2;

// End-to-end governance: every workspace action goes through propose → vote → timelock → execute.
describe("TwinTeamDAO (governance end to end)", function () {
  async function dao() {
    const [deployer, lead, alice, bob, newcomer] = await ethers.getSigners();
    const d = await deployDAO([
      { signer: lead, rep: 100 },
      { signer: alice, rep: 60 },
      { signer: bob, rep: 40 },
    ]);
    await deployer.sendTransaction({ to: await d.workspace.getAddress(), value: ETH(5) });
    return { ...d, deployer, lead, alice, bob, newcomer };
  }

  it("is wired with no privileged deployer", async function () {
    const { reputation, timelock, governor, workspace, deployer } = await loadFixture(dao);
    expect(await reputation.owner()).to.equal(await workspace.getAddress());
    expect(await workspace.owner()).to.equal(await timelock.getAddress());
    expect(await governor.timelock()).to.equal(await timelock.getAddress());
    expect(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address)).to.equal(false);
    expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), await governor.getAddress())).to.equal(true);
    expect(await governor.quorumNumerator()).to.equal(20);
  });

  it("admits a new member by vote", async function () {
    const d = await loadFixture(dao);
    const result = await runProposal(d, d.alice, [await action(d.workspace, "admitMember", [d.newcomer.address, 30])], "Admit a data scientist to the twin team", [
      { signer: d.lead, support: FOR },
      { signer: d.alice, support: FOR },
    ]);
    expect(result.state).to.equal("Executed");
    expect(await d.reputation.balanceOf(d.newcomer.address)).to.equal(30);
    expect(await d.reputation.getVotes(d.newcomer.address)).to.equal(30);
  });

  it("funds a task and pays it after the lead approves (whole loop)", async function () {
    const d = await loadFixture(dao);
    const deadline = (await time.latest()) + 30 * 86400;
    await runProposal(
      d,
      d.lead,
      [
        await action(d.workspace, "createProject", ["Robot arm twin", ethers.ZeroAddress, 1, d.lead.address]),
        await action(d.workspace, "openTask", [0, ethers.id("train anomaly detector"), ETH(1), 15, deadline]),
      ],
      "Create the robot-arm project and fund its first task",
      [{ signer: d.lead, support: FOR }, { signer: d.bob, support: FOR }]
    );
    await d.workspace.connect(d.alice).claimTask(0);
    await d.workspace.connect(d.alice).submitResult(0, ethers.id("model + metrics"));
    await expect(d.workspace.connect(d.lead).approveTask(0)).to.changeEtherBalance(d.alice, ETH(1));
    expect(await d.reputation.balanceOf(d.alice.address)).to.equal(75);
  });

  it("rules on a misbehaviour report by vote", async function () {
    const d = await loadFixture(dao);
    await d.workspace.connect(d.alice).fileReport(d.bob.address, ethers.id("evidence"), { value: ETH("0.1") });
    const r = await runProposal(d, d.lead, [await action(d.workspace, "resolveReport", [0, true, 25])], "Uphold report #0 against bob", [
      { signer: d.lead, support: FOR },
      { signer: d.alice, support: FOR },
      { signer: d.bob, support: AGAINST },
    ]);
    expect(r.state).to.equal("Executed");
    expect(await d.reputation.balanceOf(d.bob.address)).to.equal(15);
  });

  it("defeats a proposal when the majority votes against", async function () {
    const d = await loadFixture(dao);
    const r = await runProposal(d, d.bob, [await action(d.workspace, "grantReputation", [d.bob.address, 500])], "Give bob 500 reputation", [
      { signer: d.bob, support: FOR },
      { signer: d.lead, support: AGAINST },
    ]);
    expect(r.state).to.equal("Defeated");
    expect(await d.reputation.balanceOf(d.bob.address)).to.equal(40);
  });

  it("defeats a proposal that does not reach quorum", async function () {
    const d = await loadFixture(dao);
    // quorum = 20% of 200 = 40 (for + abstain); with no votes it is missed
    const r = await runProposal(d, d.bob, [await action(d.workspace, "setParameters", [0, 0])], "Remove the report bond", []);
    expect(r.state).to.equal("Defeated");
    const r2 = await runProposal(d, d.bob, [await action(d.workspace, "setParameters", [0, 0])], "Remove the report bond (2)", [
      { signer: d.bob, support: FOR },
      { signer: d.alice, support: ABSTAIN },
    ]);
    expect(r2.state).to.equal("Executed");
  });

  it("blocks non-members from proposing and members from bypassing the vote", async function () {
    const d = await loadFixture(dao);
    const a = await action(d.workspace, "admitMember", [d.newcomer.address, 1000]);
    await expect(d.governor.connect(d.newcomer).propose([a.target], [0], [a.data], "Let me in")).to.be.revertedWithCustomError(
      d.governor,
      "GovernorInsufficientProposerVotes"
    );
    await expect(d.workspace.connect(d.lead).admitMember(d.newcomer.address, 1000)).to.be.revertedWithCustomError(d.workspace, "OwnableUnauthorizedAccount");
  });

  it("lets the proposer withdraw a pending proposal, and queues every proposal in the timelock", async function () {
    const d = await loadFixture(dao);
    const a = await action(d.workspace, "setParameters", [0, 0]);
    const desc = "Withdrawn idea";
    await d.governor.connect(d.alice).propose([a.target], [0], [a.data], desc);
    const id = await d.governor.hashProposal([a.target], [0], [a.data], ethers.id(desc));
    expect(await d.governor.proposalNeedsQueuing(id)).to.equal(true);
    await expect(d.governor.connect(d.bob).cancel.staticCall([a.target], [0], [a.data], ethers.id(desc))).to.be.revertedWithCustomError(d.governor, "GovernorUnableToCancel");
    await d.governor.connect(d.alice).cancel([a.target], [0], [a.data], ethers.id(desc));
    expect(await d.governor.state(id)).to.equal(2); // Canceled
  });

  it("decides by vote which blockchains the twins can connect to (L3 link)", async function () {
    const d = await loadFixture(dao);
    const gateway = await ethers.deployContract("L3Gateway", [1001, [ethers.Wallet.createRandom().address], 1]);
    const dnft = await ethers.deployContract("DigitalTwinDNFT", [await gateway.getAddress()]);
    await dnft.transferOwnership(await d.timelock.getAddress());
    const remote = ethers.Wallet.createRandom().address;

    await expect(dnft.setTrustedRemote(2002, remote)).to.be.revertedWithCustomError(dnft, "OwnableUnauthorizedAccount");
    await runProposal(d, d.alice, [await action(dnft, "setTrustedRemote", [2002, remote])], "Connect our twins to chain 2002", [
      { signer: d.lead, support: FOR },
      { signer: d.alice, support: FOR },
    ]);
    expect(await dnft.trustedRemote(2002)).to.equal(remote);
  });
});

// Deploys the twin teams' DAO (D1.2) and runs proposals through their full lifecycle.
// Used by the tests, the DAO demo and the benchmark. Runs inside the Hardhat runtime.
const { ethers } = require("hardhat");
const { mine, time } = require("@nomicfoundation/hardhat-network-helpers");

const DEFAULTS = {
  votingDelay: 1, // blocks
  votingPeriod: 20, // blocks
  proposalThreshold: 10, // reputation points needed to propose
  quorumPercent: 20, // % of total reputation that must vote (for + abstain)
  maxVoteShareBps: 4000, // no member's vote counts for more than 40% of total reputation (0 = no cap)
  minDelay: 3600, // timelock, seconds
  reportBond: ethers.parseEther("0.1"),
  reportReward: 10, // reputation for an upheld report
};

/**
 * @param founders [{ signer, rep }] initial members and their reputation
 * @returns { reputation, timelock, governor, workspace, config }
 */
async function deployDAO(founders, overrides = {}) {
  const config = { ...DEFAULTS, ...overrides };
  const [deployer] = await ethers.getSigners();

  const reputation = await ethers.deployContract("DTReputation");
  for (const f of founders) await reputation.mint(f.signer.address, f.rep);

  const timelock = await ethers.deployContract("TimelockController", [config.minDelay, [], [ethers.ZeroAddress], deployer.address]);
  const governor = await ethers.deployContract("TwinTeamGovernor", [
    await reputation.getAddress(),
    await timelock.getAddress(),
    config.votingDelay,
    config.votingPeriod,
    config.proposalThreshold,
    config.quorumPercent,
    config.maxVoteShareBps,
  ]);
  const workspace = await ethers.deployContract("TwinWorkspace", [
    await reputation.getAddress(),
    await timelock.getAddress(),
    config.reportBond,
    config.reportReward,
  ]);

  // Wiring: only the workspace mints reputation; only the governor schedules on the timelock;
  // anyone may execute a queued proposal; the deployer gives up its admin role.
  await reputation.transferOwnership(await workspace.getAddress());
  await timelock.grantRole(await timelock.PROPOSER_ROLE(), await governor.getAddress());
  await timelock.grantRole(await timelock.CANCELLER_ROLE(), await governor.getAddress());
  await timelock.renounceRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);

  return { reputation, timelock, governor, workspace, config };
}

/** Encode a call for a proposal: { target, value, data }. */
async function action(contract, fn, args = [], value = 0n) {
  return { target: await contract.getAddress(), value, data: contract.interface.encodeFunctionData(fn, args) };
}

/**
 * Propose → wait for the voting delay → vote → wait for the voting period → queue → wait
 * for the timelock → execute. `votes` is [{ signer, support }] with 0 = against, 1 = for, 2 = abstain.
 * Stops early (and returns the state) if the proposal does not succeed.
 */
async function runProposal(dao, proposer, actions, description, votes) {
  const { governor, config } = dao;
  const targets = actions.map((a) => a.target);
  const values = actions.map((a) => a.value);
  const calldatas = actions.map((a) => a.data);
  const descHash = ethers.id(description);

  const gas = { votes: [] };
  const used = async (txp) => Number((await (await txp).wait()).gasUsed);
  gas.propose = await used(governor.connect(proposer).propose(targets, values, calldatas, description));
  const proposalId = await governor.hashProposal(targets, values, calldatas, descHash);
  await mine(config.votingDelay + 1);
  for (const v of votes) gas.votes.push(await used(governor.connect(v.signer).castVote(proposalId, v.support)));
  await mine(config.votingPeriod + 1);

  const STATES = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];
  let state = STATES[Number(await governor.state(proposalId))];
  const [against, forVotes, abstain] = (await governor.proposalVotes(proposalId)).map(Number);
  const tally = { for: forVotes, against, abstain };
  if (state !== "Succeeded") return { proposalId, state, tally, gas };

  gas.queue = await used(governor.queue(targets, values, calldatas, descHash));
  await time.increase(config.minDelay + 1);
  gas.execute = await used(governor.execute(targets, values, calldatas, descHash));
  state = STATES[Number(await governor.state(proposalId))];
  return { proposalId, state, tally, gas };
}

module.exports = { deployDAO, action, runProposal, DEFAULTS };

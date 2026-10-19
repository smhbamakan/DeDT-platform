// Deploys the twin teams' DAO (D1.2) with production governance parameters.
//
//   npx hardhat run scripts/deploy-dao.js                      # in-memory dry run
//   npx hardhat run scripts/deploy-dao.js --network sepolia    # needs .env (see .env.example)
//
// Founding members and their reputation come from FOUNDERS, a JSON list such as
//   FOUNDERS='[{"address":"0xabc…","rep":100},{"address":"0xdef…","rep":60}]'
// (defaults to three local test accounts). Block-based periods assume 12-second blocks;
// override them with the variables below for chains with other block times.
const { ethers, network } = require("hardhat");

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);
const PRODUCTION = {
  votingDelay: Number(env("VOTING_DELAY_BLOCKS", 7200)), // ≈ 1 day
  votingPeriod: Number(env("VOTING_PERIOD_BLOCKS", 50400)), // ≈ 1 week
  proposalThreshold: Number(env("PROPOSAL_THRESHOLD", 10)),
  quorumPercent: Number(env("QUORUM_PERCENT", 20)),
  maxVoteShareBps: Number(env("MAX_VOTE_SHARE_BPS", 4000)), // 40 %
  minDelay: Number(env("TIMELOCK_DELAY_SECONDS", 2 * 24 * 3600)), // 2 days
  reportBond: ethers.parseEther(env("REPORT_BOND_ETH", "0.05")),
  reportReward: Number(env("REPORT_REWARD", 10)),
};

async function main() {
  const [deployer, ...others] = await ethers.getSigners();
  const founders = process.env.FOUNDERS
    ? JSON.parse(process.env.FOUNDERS)
    : [
        { address: others[0].address, rep: 100 },
        { address: others[1].address, rep: 60 },
        { address: others[2].address, rep: 40 },
      ];
  console.log(`Network ${network.name} · deployer ${deployer.address}`);
  console.table(PRODUCTION);

  const reputation = await ethers.deployContract("DTReputation");
  for (const f of founders) await (await reputation.mint(f.address, f.rep)).wait();

  const timelock = await ethers.deployContract("TimelockController", [PRODUCTION.minDelay, [], [ethers.ZeroAddress], deployer.address]);
  const governor = await ethers.deployContract("TwinTeamGovernor", [
    await reputation.getAddress(),
    await timelock.getAddress(),
    PRODUCTION.votingDelay,
    PRODUCTION.votingPeriod,
    PRODUCTION.proposalThreshold,
    PRODUCTION.quorumPercent,
    PRODUCTION.maxVoteShareBps,
  ]);
  const workspace = await ethers.deployContract("TwinWorkspace", [
    await reputation.getAddress(),
    await timelock.getAddress(),
    PRODUCTION.reportBond,
    PRODUCTION.reportReward,
  ]);
  await Promise.all([reputation, timelock, governor, workspace].map((c) => c.waitForDeployment()));

  await (await reputation.transferOwnership(await workspace.getAddress())).wait();
  await (await timelock.grantRole(await timelock.PROPOSER_ROLE(), await governor.getAddress())).wait();
  await (await timelock.grantRole(await timelock.CANCELLER_ROLE(), await governor.getAddress())).wait();
  await (await timelock.renounceRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address)).wait();

  // Post-deployment checks (NFR-SEC-01): nobody but the governance path holds power.
  const checks = {
    "deployer has no timelock admin": !(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address)),
    "workspace owned by timelock": (await workspace.owner()) === (await timelock.getAddress()),
    "reputation owned by workspace": (await reputation.owner()) === (await workspace.getAddress()),
    "governor is the only proposer": await timelock.hasRole(await timelock.PROPOSER_ROLE(), await governor.getAddress()),
  };
  console.table(checks);
  if (Object.values(checks).some((ok) => !ok)) throw new Error("post-deployment check failed");

  console.log("\nDeployed:");
  console.table({
    DTReputation: await reputation.getAddress(),
    TimelockController: await timelock.getAddress(),
    TwinTeamGovernor: await governor.getAddress(),
    TwinWorkspace: await workspace.getAddress(),
  });
  console.log("Next: transfer ownership of the project's DigitalTwinDNFT to the timelock, then fund the workspace.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

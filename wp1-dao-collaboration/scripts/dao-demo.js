// D1.2 walkthrough: three twin teams run their shared workspace as a DAO.
// Prints each step and writes results/dao.json (gas, reputation, votes) for the figures.
// Usage: npm run dao-demo
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployDAO, action, runProposal } = require("../lib/dao");

const ETH = (n) => ethers.parseEther(String(n));
const FOR = 1;
const AGAINST = 0;
const head = (t) => console.log(`\n━━ ${t} ${"━".repeat(Math.max(0, 62 - t.length))}`);
const say = (t) => console.log(`   ${t}`);
const gasOf = async (txp) => Number((await (await txp).wait()).gasUsed);

async function main() {
  const [sponsor, lead, alice, bob, carol] = await ethers.getSigners();
  const names = new Map([
    [lead.address, "Lead (manufacturing lab)"],
    [alice.address, "Alice (data science team)"],
    [bob.address, "Bob (IoT company)"],
    [carol.address, "Carol (university lab)"],
  ]);
  const members = [lead, alice, bob, carol];
  const out = { proposals: [], actions: {}, reputation: [] };

  head("1 · Founding the DAO");
  const dao = await deployDAO([
    { signer: lead, rep: 100 },
    { signer: alice, rep: 60 },
    { signer: bob, rep: 40 },
  ]);
  const { reputation, workspace, timelock } = dao;
  say(`Reputation token, governor, timelock (${dao.config.minDelay}s) and workspace deployed; deployer has no admin rights`);
  say(`Voting: delay ${dao.config.votingDelay} block, period ${dao.config.votingPeriod} blocks, quorum ${dao.config.quorumPercent}%, threshold ${dao.config.proposalThreshold} rep`);

  const gateway = await ethers.deployContract("L3Gateway", [1001, [ethers.Wallet.createRandom().address], 1]);
  const dnft = await ethers.deployContract("DigitalTwinDNFT", [await gateway.getAddress()]);
  await dnft.connect(lead).mint(ethers.id("robot-arm twin v1"), "ipfs://robot-arm");
  await dnft.transferOwnership(await timelock.getAddress());
  say("Robot-arm twin minted as dNFT #1; the dNFT bridge configuration is handed to the DAO");

  await sponsor.sendTransaction({ to: await workspace.getAddress(), value: ETH(5) });
  say("A sponsor funds the treasury with 5 ETH");

  const snapshot = async (stage) => {
    const row = { stage };
    for (const m of members) row[names.get(m.address).split(" ")[0]] = Number(await reputation.balanceOf(m.address));
    out.reputation.push(row);
  };
  await snapshot("Founding");

  const propose = async (title, proposer, actions, votes) => {
    const r = await runProposal(dao, proposer, actions, title, votes);
    out.proposals.push({ title, state: r.state, ...r.tally, gas: r.gas });
    say(`Proposal "${title}" → ${r.state}  (for ${r.tally.for} · against ${r.tally.against} · abstain ${r.tally.abstain})`);
    return r;
  };

  head("2 · Proposal: admit Carol, open the project and fund two parallel tasks");
  const deadline = (await time.latest()) + 30 * 86400;
  const p1 = await propose("Admit Carol, open the robot-arm project, fund two tasks", alice, [
    await action(workspace, "admitMember", [carol.address, 30]),
    await action(workspace, "createProject", ["Robot-arm digital twin", await dnft.getAddress(), 1, lead.address]),
    await action(workspace, "openTask", [0, ethers.id("Train an anomaly detector"), ETH("1.0"), 15, deadline]),
    await action(workspace, "openTask", [0, ethers.id("Calibrate joint-torque sensors"), ETH("0.5"), 10, deadline]),
  ], [{ signer: lead, support: FOR }, { signer: alice, support: FOR }, { signer: bob, support: FOR }]);
  out.actions["Propose"] = p1.gas.propose;
  out.actions["Cast vote"] = Math.round(p1.gas.votes.reduce((a, b) => a + b, 0) / p1.gas.votes.length);
  out.actions["Queue (timelock)"] = p1.gas.queue;
  out.actions["Execute (4 actions)"] = p1.gas.execute;

  head("3 · Parallel work on the twin");
  out.actions["Claim task"] = await gasOf(workspace.connect(alice).claimTask(0));
  await workspace.connect(carol).claimTask(1);
  say("Alice claims task #0, Carol claims task #1 — both run in parallel");
  out.actions["Submit result"] = await gasOf(workspace.connect(alice).submitResult(0, ethers.id("detector v1 + F1 0.94")));
  await workspace.connect(carol).submitResult(1, ethers.id("calibration table"));
  out.actions["Approve task (pays bounty)"] = await gasOf(workspace.connect(lead).approveTask(0));
  await workspace.connect(lead).approveTask(1);
  say("The project lead approves both results: bounties paid, reputation earned");

  out.actions["Submit experiment"] = await gasOf(workspace.connect(alice).submitExperiment(0, ethers.id("LSTM, lr=1e-3, data v4"), ethers.id("F1 0.94")));
  out.actions["Endorse experiment"] = await gasOf(workspace.connect(lead).endorseExperiment(0));
  await workspace.connect(carol).endorseExperiment(0);
  const exp = await workspace.experiment(0);
  say(`Alice records her experiment; ${exp.endorsements} members reproduce and endorse it (weight ${exp.endorsementWeight})`);
  await snapshot("After tasks");

  head("4 · Collective monitoring: a misbehaviour report");
  out.actions["File report (bonded)"] = await gasOf(workspace.connect(carol).fileReport(bob.address, ethers.id("evidence: falsified sensor readings"), { value: ETH("0.1") }));
  say("Carol reports Bob for falsified sensor data and posts a 0.1 ETH bond");
  await propose("Uphold report #0 and slash Bob by 20 reputation", lead, [await action(workspace, "resolveReport", [0, true, 20])], [
    { signer: lead, support: FOR },
    { signer: alice, support: FOR },
    { signer: carol, support: FOR },
    { signer: bob, support: AGAINST },
  ]);
  await snapshot("After report");

  head("5 · The DAO decides which blockchain the twin connects to");
  const remote = ethers.Wallet.createRandom().address;
  await propose("Connect the twin dNFT to chain 2002", carol, [await action(dnft, "setTrustedRemote", [2002, remote])], [
    { signer: lead, support: FOR },
    { signer: carol, support: FOR },
  ]);
  say(`dNFT trusted remote for chain 2002: ${(await dnft.trustedRemote(2002)).slice(0, 10)}…`);

  head("Result");
  const rows = {};
  for (const m of members) {
    rows[names.get(m.address)] = { reputation: Number(await reputation.balanceOf(m.address)), votes: Number(await reputation.getVotes(m.address)) };
  }
  console.table(rows);
  const [projects, tasks, experiments, reports] = await workspace.counts();
  say(`Workspace: ${projects} project · ${tasks} tasks · ${experiments} experiment · ${reports} report · treasury left ${ethers.formatEther(await workspace.availableTreasury())} ETH`);

  const file = path.join(__dirname, "..", "results", "dao.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), ...out }, null, 2));
  say(`saved ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

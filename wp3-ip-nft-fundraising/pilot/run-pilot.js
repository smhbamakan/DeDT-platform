// Technical pilot (D3.3), step 2: run complete DTVF projects end to end on a local Ethereum network,
// driven by KPI evidence computed from twin data (pilot/kpi.py). Agents: a twin team of three
// members, 24 backers, one watcher, one griefer, a licensee paying income, and a QF sponsor.
// Usage: python pilot/kpi.py && npx hardhat run pilot/run-pilot.js   (writes pilot/pilot-results.json)
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const EV = JSON.parse(fs.readFileSync(path.join(__dirname, "evidence.json")));
const E = (n) => ethers.parseUnits(String(n), 6);
const fmt = (x) => Number(ethers.formatUnits(x, 6));
const DAY = 86400;
const N_BACKERS = 24;
const NU = 0.6; // probability that a backer recomputes a disputed KPI before voting

let seed = 20261109;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const advance = async (s) => { await network.provider.send("evm_increaseTime", [s]); await network.provider.send("evm_mine"); };

async function fund(wallets, token, spender) {
  for (const w of wallets) {
    await network.provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);
    await token.mint(w.address, E(1_000_000));
    await token.connect(w).approve(spender, ethers.MaxUint256);
  }
}

async function scenario(name, opts) {
  const [deployer] = await ethers.getSigners();
  const mk = (n) => Array.from({ length: n }, () => ethers.Wallet.createRandom().connect(ethers.provider));
  const [lead, modeller, dataOwner] = mk(3);
  const backers = mk(N_BACKERS);
  const [watcher, griefer, licensee] = mk(3);
  const gas = {}; let txs = 0;
  const send = async (role, p) => { const r = await (await p).wait(); gas[role] = (gas[role] || 0) + Number(r.gasUsed); txs++; return r; };

  const ipnft = await ethers.deployContract("DigitalTwinIPNFT");
  const dtvf = await ethers.deployContract("TwinVerifiedFinancing", [await ipnft.getAddress()]);
  const eur = await ethers.deployContract("MockStablecoin");
  const A = await eur.getAddress();
  const all = [lead, modeller, dataOwner, ...backers, watcher, griefer, licensee];
  await fund(all, eur, await dtvf.getAddress());
  const start = (await ethers.provider.getBlock("latest")).timestamp;

  // 1. register the twin and open the project
  await send("team", ipnft.connect(lead).registerTwin(ethers.id("robot-arm-07 predictive-maintenance twin"), "ipfs://robot-arm-07", "CC-BY-NC-4.0", 250));
  await send("team", ipnft.connect(lead).approve(await dtvf.getAddress(), 1));
  const budgets = [30000, 30000, 20000];
  const ms = EV.milestones.map((m, i) => ({
    budget: E(budgets[i]), duration: 45 * DAY, kpi: EV.kpiIds[m.kpi], target: m.target, reported: 0, evidence: ethers.ZeroHash,
    claimedAt: 0, disputeEnd: 0, challenger: ethers.ZeroAddress, votesFor: 0, votesAgainst: 0, state: 0 }));
  const terms = { fundingDuration: 30 * DAY, challengeWindow: 3 * DAY, voteWindow: 5 * DAY, bondBps: 1500, quorumBps: 2000,
    thetaBps: 3000, capPerBacker: E(15000), advance: E(20000), allowListOnly: true };
  await send("team", dtvf.connect(lead).createProject(1, A, ms, [lead.address, modeller.address, dataOwner.address], [4500, 3500, 2000], terms));
  await send("team", dtvf.connect(lead).setAllowed(0, backers.map((b) => b.address), true));

  // 2. funding: random tickets until the goal of 100,000 is reached
  const goal = 100000; let raised = 0; const contrib = new Map();
  while (raised < goal) {
    for (const b of backers) {
      if (raised >= goal) break;
      const have = contrib.get(b.address) || 0;
      let amt = Math.min(Math.round(500 + rand() * 4500), goal - raised, 15000 - have);
      if (amt <= 0) continue;
      await send("backers", dtvf.connect(b).contribute(0, E(amt)));
      raised += amt; contrib.set(b.address, have + amt);
    }
  }
  await advance(10 * DAY);
  await send("anyone", dtvf.closeFunding(0));

  const timeline = [{ day: 10, released: 20000, event: "funding closed, advance released" }];
  const now = async () => Math.round(((await ethers.provider.getBlock("latest")).timestamp - start) / DAY);
  const released = async () => fmt((await dtvf.project(0)).released);
  const runFor = opts.misconfigured ? EV.runs.misconfigured : EV.runs.published;
  const truth = EV.runs.published; // what anyone recomputes from the anchored data and the committed model

  let outcome = "completed";
  for (let k = 0; k < 3; k++) {
    const m = EV.milestones[k];
    await advance(20 * DAY);
    if (opts.overdueAt === k) { await advance(30 * DAY); await send("watcher", dtvf.connect(watcher).cancelOverdue(0)); outcome = `cancelled: milestone ${k + 1} overdue`; timeline.push({ day: await now(), released: await released(), event: outcome }); break; }
    // team records evidence and claims; a dishonest team reports the published value although its delivered twin achieves less
    const actual = runFor.values[m.kpi];
    const reported = opts.falseClaimAt === k ? truth.values[m.kpi] : actual;
    const evid = opts.falseClaimAt === k ? truth.evidence[m.kpi] : runFor.evidence[m.kpi];
    await send("team", ipnft.connect(lead).recordVersion(1, evid, m.label));
    const vcount = Number(await ipnft.versionCount(1));
    await send("team", dtvf.connect(lead).claim(0, reported, vcount - 1));
    // watcher recomputes the KPI from the delivered twin's data; challenges if it does not meet the claim
    const recomputed = runFor.values[m.kpi];
    const falseClaim = recomputed < reported;
    let disputed = false;
    if (falseClaim) { await send("watcher", dtvf.connect(watcher).challenge(0)); disputed = true; }
    else if (opts.griefAt === k) { await send("griefer", dtvf.connect(griefer).challenge(0)); disputed = true; }
    if (disputed) {
      for (const b of backers) if (rand() < NU) await send("backers", dtvf.connect(b).vote(0, !falseClaim));
      await advance(5 * DAY + 1);
    } else await advance(3 * DAY + 1);
    await send("anyone", dtvf.resolve(0));
    const st = Number((await dtvf.milestone(0, k)).state);
    timeline.push({ day: await now(), released: await released(), event: `M${k + 1} ${disputed ? "disputed, " : ""}${st === 3 ? "accepted" : "rejected"}` });
    if (st === 4) { outcome = `cancelled: milestone ${k + 1} rejected`; break; }
  }

  const p = await dtvf.project(0);
  const phase = Number(p.phase);
  // 3. income (completed or active projects) and settlement
  let income = 0;
  if (phase === 2) {
    for (let q = 0; q < 4; q++) { await advance(90 * DAY); await send("licensee", dtvf.connect(licensee).depositRevenue(0, E(12000))); income += 12000; }
    for (const b of backers) await send("backers", dtvf.connect(b).claimRevenue(0));
  }
  let refunded = 0n;
  if (phase === 3) for (const b of backers) { const before = await eur.balanceOf(b.address); await send("backers", dtvf.connect(b).refund(0)); refunded += (await eur.balanceOf(b.address)) - before; }
  const paid = {};
  for (const [role, w] of [["lead", lead], ["modeller", modeller], ["dataOwner", dataOwner], ["watcher", watcher], ["griefer", griefer], ...backers.map((b, i) => [`b${i}`, b])]) {
    const c = await dtvf.credit(A, w.address);
    if (c > 0n) { await send(role.startsWith("b") && role !== "griefer" ? "backers" : (["lead", "modeller", "dataOwner"].includes(role) ? "team" : role), dtvf.connect(w).withdraw(A)); paid[role] = fmt(c); }
  }
  const dust = await eur.balanceOf(await dtvf.getAddress());
  const backerIncome = Object.entries(paid).filter(([k]) => /^b\d+$/.test(k)).reduce((s, [, v]) => s + v, 0);
  return {
    name, outcome, phaseFinal: ["Funding", "Active", "Completed", "Cancelled"][phase], backers: N_BACKERS, raised,
    releasedToTeam: fmt(p.released), refundedToBackers: fmt(refunded), income, backerIncome,
    teamReceived: (paid.lead || 0) + (paid.modeller || 0) + (paid.dataOwner || 0), split: { lead: paid.lead || 0, modeller: paid.modeller || 0, dataOwner: paid.dataOwner || 0 },
    watcher: paid.watcher || 0, griefer: paid.griefer || 0, dustUnits: Number(dust), conserved: dust < 100n,
    txs, gas, days: await now(), timeline,
  };
}

async function qfRound() {
  const mk = (n) => Array.from({ length: n }, () => ethers.Wallet.createRandom().connect(ethers.provider));
  const [sponsor, r0, r1, r2] = mk(4); const people = mk(15);
  const eur = await ethers.deployContract("MockStablecoin");
  const qf = await ethers.deployContract("QuadraticMatchingPool", [await eur.getAddress(), 14 * DAY]);
  await fund([sponsor, ...people], eur, await qf.getAddress());
  for (const r of [r0, r1, r2]) await qf.addComponent(r.address);
  await qf.setVerified(people.map((p) => p.address), true);
  await qf.connect(sponsor).fundPool(E(5000));
  const plan = [people.slice(0, 12).map(() => 50), people.slice(0, 4).map(() => 200), [800]]; // broad, medium, single donor
  const offchain = [];
  for (let c = 0; c < 3; c++) {
    const xs = plan[c]; let s = 0, t = 0;
    for (let i = 0; i < xs.length; i++) { await qf.connect(people[c === 2 ? 14 : i]).contribute(c, E(xs[i])); s += Math.sqrt(xs[i]); t += xs[i]; }
    offchain.push({ contributions: t, contributors: xs.length, rawMatch: s * s - t });
  }
  await advance(14 * DAY); await qf.close();
  const rows = [];
  for (let c = 0; c < 3; c++) {
    const before = await eur.balanceOf([r0, r1, r2][c].address);
    await qf.payout(c);
    const got = fmt((await eur.balanceOf([r0, r1, r2][c].address)) - before);
    rows.push({ ...offchain[c], rawMatchOnChain: fmt(await qf.rawMatch(c)), matched: fmt(await qf.matchOf(c)), received: got });
  }
  return { pool: 5000, totalRawMatch: fmt(await qf.totalMatchAtClose()), components: rows };
}

async function main() {
  const results = {
    scenarios: [
      await scenario("S1 honest team, unchallenged milestones", {}),
      await scenario("S2 false claim at M2, challenged by watcher", { misconfigured: true, falseClaimAt: 1 }),
      await scenario("S3 frivolous challenge of a true claim at M2", { griefAt: 1 }),
      await scenario("S4 M3 deadline missed", { overdueAt: 2 }),
    ],
    qf: await qfRound(),
    evidence: { runs: Object.fromEntries(Object.entries(EV.runs).map(([k, v]) => [k, v.values])), batches: EV.runs.published.batches, readings: EV.runs.published.readings },
  };
  fs.writeFileSync(path.join(__dirname, "pilot-results.json"), JSON.stringify(results, null, 2));
  for (const s of results.scenarios) console.log(s.name, "|", s.outcome, "| released", s.releasedToTeam, "| refunded", s.refundedToBackers, "| conserved", s.conserved, "| txs", s.txs);
  console.log(JSON.stringify(results.qf));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

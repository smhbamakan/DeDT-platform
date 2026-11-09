// Integration demo, step 4 (WP3): the twin is financed with DTVF.
// The IP-NFT's specification hash is the WP4 birth-certificate commitment; its version trail first
// records the WP1 DAO decision and then the KPI evidence computed from WP2 data. 24 backers fund the
// plan adopted by the DAO; each milestone is claimed with its evidence, passes the challenge window
// and releases the next tranche; a first income payment is shared between backers and team.
// Reads ../integration/out/{twin_trust,dao}.json, writes ../integration/out/funding.json.
// Usage: npx hardhat run scripts/integration-step.js
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const OUT = path.join(__dirname, "..", "..", "integration", "out");
const E = (n) => ethers.parseUnits(String(n), 6);
const DAY = 86400;
const inc = async (s) => { await network.provider.send("evm_increaseTime", [s]); await network.provider.send("evm_mine"); };

async function main() {
  const tt = JSON.parse(fs.readFileSync(path.join(OUT, "twin_trust.json")));
  const dao = JSON.parse(fs.readFileSync(path.join(OUT, "dao.json")));
  if (dao.state !== "Executed") throw new Error("funding plan not adopted by the DAO");
  const plan = tt.fundingPlan;
  const signers = await ethers.getSigners();
  const [lead, modeller, dataOwner, licensee] = signers.slice(1, 5);
  const backers = signers.slice(5, 19); // 14 backers
  const ipnft = await ethers.deployContract("DigitalTwinIPNFT");
  const dtvf = await ethers.deployContract("TwinVerifiedFinancing", [await ipnft.getAddress()]);
  const eur = await ethers.deployContract("MockStablecoin");
  for (const s of [lead, licensee, ...backers]) { await eur.mint(s.address, E(1e6)); await eur.connect(s).approve(await dtvf.getAddress(), ethers.MaxUint256); }

  await ipnft.connect(lead).registerTwin(tt.specHash, "ipfs://robot-arm-07", "CC-BY-NC-4.0", 250);
  await ipnft.connect(lead).recordVersion(1, dao.descriptionHash, "DAO adopted funding plan " + tt.fundingPlanHash);
  await ipnft.connect(lead).approve(await dtvf.getAddress(), 1);
  const ms = plan.milestones.map((m, i) => ({ budget: E(plan.budgets[i]), duration: 45 * DAY, kpi: tt.kpiIds[m.kpi], target: m.target,
    reported: 0, evidence: ethers.ZeroHash, claimedAt: 0, disputeEnd: 0, challenger: ethers.ZeroAddress, votesFor: 0, votesAgainst: 0, state: 0 }));
  const terms = { fundingDuration: 30 * DAY, challengeWindow: 3 * DAY, voteWindow: 5 * DAY, bondBps: plan.bondBps, quorumBps: 2000,
    thetaBps: plan.thetaBps, capPerBacker: 0, advance: E(plan.advance), allowListOnly: false };
  await dtvf.connect(lead).createProject(1, await eur.getAddress(), ms, [lead.address, modeller.address, dataOwner.address],
    [plan.split.lead, plan.split.modeller, plan.split.dataOwner], terms);
  const goal = plan.advance + plan.budgets.reduce((a, b) => a + b, 0);
  const each = goal / backers.length; let left = goal;
  for (let i = 0; i < backers.length; i++) { const a = i === backers.length - 1 ? left : Math.floor(each); left -= a; await dtvf.connect(backers[i]).contribute(0, E(a)); }
  await dtvf.closeFunding(0);
  const log = [];
  for (let k = 0; k < ms.length; k++) {
    const kpi = plan.milestones[k].kpi;
    await inc(20 * DAY);
    await ipnft.connect(lead).recordVersion(1, tt.evidence[kpi], `M${k + 1} evidence: ${kpi}`);
    await dtvf.connect(lead).claim(0, tt.kpis[kpi], Number(await ipnft.versionCount(1)) - 1);
    await inc(3 * DAY + 1);
    await dtvf.resolve(0);
    const m = await dtvf.milestone(0, k);
    log.push({ milestone: k + 1, kpi, reported: tt.kpis[kpi], target: plan.milestones[k].target, evidence: m.evidence, accepted: Number(m.state) === 3 });
    console.log(`[WP3] M${k + 1} ${kpi} = ${tt.kpis[kpi]} (target ${plan.milestones[k].target}) → ${Number(m.state) === 3 ? "accepted" : "rejected"}; released ${ethers.formatUnits((await dtvf.project(0)).released, 6)} mEUR`);
  }
  await dtvf.connect(licensee).depositRevenue(0, E(10000));
  const trail = [];
  for (let i = 0; i < Number(await ipnft.versionCount(1)); i++) { const v = await ipnft.versionAt(1, i); trail.push({ index: i, dataHash: v.dataHash, note: v.note }); }
  const p = await dtvf.project(0);
  const out = { phase: ["Funding", "Active", "Completed", "Cancelled"][Number(p.phase)], raised: goal, released: Number(ethers.formatUnits(p.released, 6)),
    backers: backers.length, milestones: log, incomeToBackers: 3000, firstBackerPending: Number(ethers.formatUnits(await dtvf.pendingRevenue(0, backers[0].address), 6)),
    versionTrail: trail };
  fs.writeFileSync(path.join(OUT, "funding.json"), JSON.stringify(out, null, 2));
  console.log(`[WP3] project ${out.phase}; IP-NFT version trail has ${trail.length} entries (birth, DAO decision, 3 KPI evidences)`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

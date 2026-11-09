// Gas use of the DTVF contracts (TwinVerifiedFinancing, QuadraticMatchingPool) on a local Hardhat network.
// Usage: npx hardhat run scripts/gas-dtvf.js   (prints JSON)
const { ethers, network } = require("hardhat");
const E = (n) => ethers.parseUnits(String(n), 6);
const DAY = 86400;
const inc = async (s) => { await network.provider.send("evm_increaseTime", [s]); await network.provider.send("evm_mine"); };

async function main() {
  const [team, dev, a, b, c] = await ethers.getSigners();
  const out = {};
  const g = async (k, p) => { out[k] = Number((await (await p).wait()).gasUsed); };
  const ipnft = await ethers.deployContract("DigitalTwinIPNFT");
  const dtvf = await ethers.deployContract("TwinVerifiedFinancing", [await ipnft.getAddress()]);
  out.deployDTVF = Number((await dtvf.deploymentTransaction().wait()).gasUsed);
  const eur = await ethers.deployContract("MockStablecoin");
  for (const s of [team, a, b, c]) { await eur.mint(s.address, E(1e6)); await eur.connect(s).approve(await dtvf.getAddress(), ethers.MaxUint256); }
  await ipnft.registerTwin(ethers.id("spec"), "ipfs://x", "CC-BY-4.0", 0);
  await ipnft.approve(await dtvf.getAddress(), 1);
  const m = (bud) => ({ budget: E(bud), duration: 60 * DAY, kpi: ethers.id("k"), target: 90, reported: 0, evidence: ethers.ZeroHash, claimedAt: 0, disputeEnd: 0, challenger: ethers.ZeroAddress, votesFor: 0, votesAgainst: 0, state: 0 });
  const terms = { fundingDuration: 30 * DAY, challengeWindow: 3 * DAY, voteWindow: 5 * DAY, bondBps: 500, quorumBps: 2000, thetaBps: 3000, capPerBacker: 0, advance: E(20), allowListOnly: false };
  await g("createProject_3ms_2members", dtvf.createProject(1, await eur.getAddress(), [m(30), m(30), m(40)], [team.address, dev.address], [7000, 3000], terms));
  await g("contributeFirst", dtvf.connect(a).contribute(0, E(50)));
  await g("contributeRepeat", dtvf.connect(a).contribute(0, E(10)));
  await dtvf.connect(b).contribute(0, E(30));
  await dtvf.connect(c).contribute(0, E(30));
  await g("closeFunding", dtvf.closeFunding(0));
  await g("recordVersion", ipnft.recordVersion(1, ethers.id("ev1"), "kpi"));
  await g("claim", dtvf.claim(0, 95, 1));
  await inc(3 * DAY + 1);
  await g("resolveUnchallenged", dtvf.resolve(0));
  await ipnft.recordVersion(1, ethers.id("ev2"), "kpi");
  await dtvf.claim(0, 95, 2);
  await g("challenge", dtvf.connect(b).challenge(0));
  await g("vote", dtvf.connect(a).vote(0, true));
  await inc(5 * DAY + 1);
  await g("resolveDisputed", dtvf.resolve(0));
  await g("depositRevenue", dtvf.connect(c).depositRevenue(0, E(100)));
  await g("claimRevenue", dtvf.connect(a).claimRevenue(0));
  await g("withdraw", dtvf.connect(a).withdraw(await eur.getAddress()));
  // refund path
  await ipnft.registerTwin(ethers.id("spec2"), "ipfs://y", "CC-BY-4.0", 0);
  await ipnft.approve(await dtvf.getAddress(), 2);
  await dtvf.createProject(2, await eur.getAddress(), [m(10)], [team.address], [10000], { ...terms, advance: 0 });
  await dtvf.connect(a).contribute(1, E(10));
  await dtvf.closeFunding(1);
  await inc(60 * DAY + 1);
  await g("cancelOverdue", dtvf.cancelOverdue(1));
  await g("refund", dtvf.connect(a).refund(1));
  // quadratic matching
  const qf = await ethers.deployContract("QuadraticMatchingPool", [await eur.getAddress(), 14 * DAY]);
  out.deployQF = Number((await qf.deploymentTransaction().wait()).gasUsed);
  for (const s of [team, a, b, c]) await eur.connect(s).approve(await qf.getAddress(), ethers.MaxUint256);
  await g("qfAddComponent", qf.addComponent(dev.address));
  await qf.setVerified([a.address, b.address, c.address], true);
  await g("qfFundPool", qf.connect(team).fundPool(E(1000)));
  await g("qfContributeFirst", qf.connect(a).contribute(0, E(10)));
  await g("qfContributeRepeat", qf.connect(a).contribute(0, E(10)));
  await inc(14 * DAY);
  await g("qfClose", qf.close());
  await g("qfPayout", qf.payout(0));
  console.log(JSON.stringify(out));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

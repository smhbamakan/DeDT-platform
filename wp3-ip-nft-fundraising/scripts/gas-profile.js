// Measures gas used by each step of the WP3 funding flow on a local Hardhat network.
// Usage: npx hardhat run scripts/gas-profile.js   (writes JSON to stdout)
const { ethers, network } = require("hardhat");

async function main() {
  const [team, a, b] = await ethers.getSigners();
  const out = {};
  const rec = async (k, p) => { const r = await (await p).wait(); out[k] = Number(r.gasUsed); };
  const N = await ethers.getContractFactory("DigitalTwinIPNFT");
  const n = await N.deploy(); out.deployIPNFT = Number((await n.deploymentTransaction().wait()).gasUsed);
  const F = await ethers.getContractFactory("TwinFundraiser");
  const f = await F.deploy(await n.getAddress()); out.deployFundraiser = Number((await f.deploymentTransaction().wait()).gasUsed);
  await rec("registerTwin", n.registerTwin(ethers.id("spec"), "ipfs://bafy/turbine.json", "CC-BY-NC-4.0", 500));
  await rec("recordVersion", n.recordVersion(1, ethers.id("v2"), "retrained"));
  await rec("approve", n.approve(await f.getAddress(), 1));
  await rec("createCampaign", f.createCampaign(1, ethers.parseEther("10"), 30 * 86400));
  await rec("contributeFirst", f.connect(a).contribute(0, { value: ethers.parseEther("6") }));
  await rec("contributeRepeat", f.connect(a).contribute(0, { value: ethers.parseEther("1") }));
  await rec("contributeOther", f.connect(b).contribute(0, { value: ethers.parseEther("3") }));
  await network.provider.send("evm_increaseTime", [30 * 86400]); await network.provider.send("evm_mine");
  await rec("withdrawFunds", f.withdrawFunds(0));
  await rec("claimShares", f.connect(a).claimShares(0));
  // failed campaign for refund / reclaim
  await n.registerTwin(ethers.id("spec2"), "ipfs://x", "CC-BY-4.0", 0);
  await n.approve(await f.getAddress(), 2);
  await f.createCampaign(2, ethers.parseEther("10"), 86400);
  await f.connect(a).contribute(1, { value: ethers.parseEther("1") });
  await network.provider.send("evm_increaseTime", [86400]); await network.provider.send("evm_mine");
  await rec("refund", f.connect(a).refund(1));
  await rec("reclaimNFT", f.reclaimNFT(1));
  console.log(JSON.stringify(out));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

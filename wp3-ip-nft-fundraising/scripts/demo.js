// End-to-end walkthrough on an in-memory Hardhat network:
// register a twin → record a version → crowdfund it → withdraw funds → claim IP shares.
// Usage: npm run demo
const { ethers, network } = require("hardhat");

const fmt = (wei) => `${ethers.formatEther(wei)} ETH`;
const step = (n, text) => console.log(`\n[${n}] ${text}`);

async function main() {
  const [team, alice, bob] = await ethers.getSigners();
  const ipnft = await ethers.deployContract("DigitalTwinIPNFT");
  const fundraiser = await ethers.deployContract("TwinFundraiser", [await ipnft.getAddress()]);

  step(1, "Twin team registers its digital twin as an IP-NFT");
  const specification = JSON.stringify({ name: "Wind turbine WT-07 digital twin", sensors: 42, model: "LSTM-v1" });
  const specHash = ethers.keccak256(ethers.toUtf8Bytes(specification));
  await ipnft.registerTwin(specHash, "ipfs://bafy…/turbine.json", "CC-BY-NC-4.0", 500);
  console.log(`    token #1 owner   ${team.address}`);
  console.log(`    birth cert hash  ${specHash}`);
  console.log(`    verifySpec(original)  → ${await ipnft.verifySpec(1, specHash)}`);
  console.log(`    verifySpec(tampered)  → ${await ipnft.verifySpec(1, ethers.id(specification + " "))}`);

  step(2, "The team records a model update in the provenance trail");
  await ipnft.recordVersion(1, ethers.id("LSTM-v2 weights"), "retrained with Q3 sensor data");
  console.log(`    versions: ${await ipnft.versionCount(1)}`);

  step(3, "The team locks the IP-NFT and opens a 30-day campaign with a 10 ETH goal");
  await ipnft.approve(await fundraiser.getAddress(), 1);
  await fundraiser.createCampaign(1, ethers.parseEther("10"), 30 * 24 * 3600);
  const c = await fundraiser.campaign(0);
  console.log(`    share token      ${c.shares}`);

  step(4, "Backers contribute");
  await fundraiser.connect(alice).contribute(0, { value: ethers.parseEther("6") });
  await fundraiser.connect(bob).contribute(0, { value: ethers.parseEther("4") });
  console.log(`    raised ${fmt((await fundraiser.campaign(0)).raised)}`);

  step(5, "Deadline passes → campaign succeeded");
  await network.provider.send("evm_increaseTime", [30 * 24 * 3600]);
  await network.provider.send("evm_mine");
  console.log(`    state: ${["Active", "Succeeded", "Failed"][Number(await fundraiser.state(0))]}`);

  step(6, "Team withdraws funds, backers claim IP shares");
  await fundraiser.withdrawFunds(0);
  await fundraiser.connect(alice).claimShares(0);
  await fundraiser.connect(bob).claimShares(0);
  const shares = await ethers.getContractAt("IPShareToken", c.shares);
  console.table({
    alice: { shares: ethers.formatEther(await shares.balanceOf(alice.address)) },
    bob: { shares: ethers.formatEther(await shares.balanceOf(bob.address)) },
  });
  console.log(`    IP-NFT #1 is now held by the fundraiser as the asset backing ${await shares.symbol()}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

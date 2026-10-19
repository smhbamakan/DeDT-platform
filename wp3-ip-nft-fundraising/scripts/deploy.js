// Deploys DigitalTwinIPNFT and TwinFundraiser.
// Usage: npm run deploy:local   (after `npm run node` in another terminal)
//        npm run deploy:sepolia (needs .env, see .env.example)
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Network: ${network.name}  Deployer: ${deployer.address}`);

  const ipnft = await ethers.deployContract("DigitalTwinIPNFT");
  await ipnft.waitForDeployment();
  console.log(`DigitalTwinIPNFT: ${await ipnft.getAddress()}`);

  const fundraiser = await ethers.deployContract("TwinFundraiser", [await ipnft.getAddress()]);
  await fundraiser.waitForDeployment();
  console.log(`TwinFundraiser:   ${await fundraiser.getAddress()}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

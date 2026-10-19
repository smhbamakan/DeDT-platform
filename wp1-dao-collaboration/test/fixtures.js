const { ethers } = require("hardhat");

const DOMAIN_A = 1001; // e.g. an Ethereum-based chain hosting DT team #1
const DOMAIN_B = 2002; // e.g. a Polygon-based chain hosting DT team #2
const N_VALIDATORS = 5;
const THRESHOLD = 3;

/** Two L3 gateways and two dNFT contracts, one pair per (simulated) blockchain. */
async function twoChains() {
  const [deployer, team1, team2, relayer, outsider] = await ethers.getSigners();
  const validators = Array.from({ length: N_VALIDATORS }, () => ethers.Wallet.createRandom());
  const addrs = validators.map((v) => v.address);

  const gatewayA = await ethers.deployContract("L3Gateway", [DOMAIN_A, addrs, THRESHOLD]);
  const gatewayB = await ethers.deployContract("L3Gateway", [DOMAIN_B, addrs, THRESHOLD]);
  const dnftA = await ethers.deployContract("DigitalTwinDNFT", [await gatewayA.getAddress()]);
  const dnftB = await ethers.deployContract("DigitalTwinDNFT", [await gatewayB.getAddress()]);
  await dnftA.setTrustedRemote(DOMAIN_B, await dnftB.getAddress());
  await dnftB.setTrustedRemote(DOMAIN_A, await dnftA.getAddress());

  return { deployer, team1, team2, relayer, outsider, validators, gatewayA, gatewayB, dnftA, dnftB };
}

module.exports = { twoChains, DOMAIN_A, DOMAIN_B, N_VALIDATORS, THRESHOLD };

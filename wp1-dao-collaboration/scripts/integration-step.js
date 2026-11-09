// Integration demo, step 3 (WP1): the twin team governs its funding plan through the DAO.
// The three team members found the DAO; the robot-arm twin is minted as a dNFT bound to the
// birth-certificate commitment from WP4; a proposal whose description carries the hash of the
// funding plan opens the project in the workspace and is executed through the timelock.
// Reads ../integration/out/twin_trust.json, writes ../integration/out/dao.json.
// Usage: npx hardhat run scripts/integration-step.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { deployDAO, action, runProposal } = require("../lib/dao");

const OUT = path.join(__dirname, "..", "..", "integration", "out");

async function main() {
  const tt = JSON.parse(fs.readFileSync(path.join(OUT, "twin_trust.json")));
  const [, lead, modeller, dataOwner] = await ethers.getSigners();
  const dao = await deployDAO([
    { signer: lead, rep: 45 }, { signer: modeller, rep: 35 }, { signer: dataOwner, rep: 20 },
  ]);
  const gateway = await ethers.deployContract("L3Gateway", [1001, [ethers.Wallet.createRandom().address], 1]);
  const dnft = await ethers.deployContract("DigitalTwinDNFT", [await gateway.getAddress()]);
  await dnft.connect(lead).mint(tt.specHash, "ipfs://robot-arm-07");
  const description = `Adopt DTVF funding plan ${tt.fundingPlanHash} for robot-arm-07`;
  const r = await runProposal(dao, lead, [
    await action(dao.workspace, "createProject", ["robot-arm-07 (DTVF plan " + tt.fundingPlanHash.slice(0, 10) + ")", await dnft.getAddress(), 1, lead.address]),
  ], description, [{ signer: lead, support: 1 }, { signer: modeller, support: 1 }, { signer: dataOwner, support: 0 }]);
  const out = { proposal: description, state: r.state, tally: r.tally, gas: r.gas, fundingPlanHash: tt.fundingPlanHash,
    descriptionHash: ethers.id(description), dnftSpecHash: tt.specHash };
  fs.writeFileSync(path.join(OUT, "dao.json"), JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`[WP1] DAO of 3 team members; proposal "${description.slice(0, 48)}…" → ${r.state} (for ${r.tally.for}, against ${r.tally.against})`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

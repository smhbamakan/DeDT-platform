// Anchors the batches produced by the Python pipeline (out/anchors.json) on a local chain and
// measures the cost; writes ../results/anchor-gas.json for the experiments.
// Usage: python -m dedt_flows.pipeline && cd chain && npm run anchor
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

async function main() {
  const anchors = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "out", "anchors.json"), "utf8"));
  const [owner, edge] = await ethers.getSigners();
  const contract = await ethers.deployContract("DataAnchor");
  const twinId = anchors[0].twinId;
  await (await contract.registerTwin(twinId)).wait();
  await (await contract.setSubmitter(twinId, edge.address, true)).wait();

  const gas = [];
  for (const a of anchors) {
    const rc = await (await contract.connect(edge).anchor(twinId, a.index, a.merkleRoot, a.summaryHash, a.count, a.startMs, a.endMs)).wait();
    gas.push(Number(rc.gasUsed));
    const head = (await contract.twins(twinId)).head;
    if (head !== a.chain) throw new Error(`chain mismatch at batch ${a.index}`);
  }
  // cost of a verification call (view, measured with estimateGas)
  const fixture = require("../test/fixtures/batch.json");
  const r = fixture.readings[0];
  const verifyGas = Number(await contract.verifyReading.estimateGas(twinId, 0, r.sensorId, r.seq, r.tEventMs, r.valueMicro, r.proof));

  const readings = anchors.reduce((s, a) => s + a.count, 0);
  const steady = gas.slice(1); // the first anchor writes to empty storage slots, so its cost differs
  const result = {
    batches: anchors.length,
    readings,
    gasFirstAnchor: gas[0],
    gasPerAnchor: Math.round(steady.reduce((s, g) => s + g, 0) / steady.length),
    gasPerReading: gas.reduce((s, g) => s + g, 0) / readings,
    verifyGas,
    proofLength: r.proof.length,
  };
  const out = path.join(__dirname, "..", "..", "results", "anchor-gas.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.table(result);
  console.log("all", anchors.length, "chain hashes match the Python pipeline");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

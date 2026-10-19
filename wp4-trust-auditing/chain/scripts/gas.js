// Gas of the WP4 contracts on the Hardhat EVM. Writes ../results/gas.json.
// Usage: npm run gas   (needs the Python environment of the module, see README)
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { py } = require("../test/py");

const used = async (p) => Number((await (await p).wait()).gasUsed);

async function dataAuth(out) {
  const [owner] = await ethers.getSigners();
  const nft = await ethers.deployContract("MockTwinNFT");
  const auth = await ethers.deployContract("DataAuthenticator", [await nft.getAddress()]);
  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  const contract = await auth.getAddress();
  const seeds = Array.from({ length: 32 }, (_, i) => `g${i}`);
  const keys = py("signers", { seeds: seeds.join(",") });
  const tree = py("merkle", { records: Array.from({ length: 256 }, (_, i) => `reading ${i}`).join(",") });

  out.dataAuthenticator = { submitBatch: [] };
  for (const k of [1, 2, 4, 8, 16, 32]) {
    const twin = 100 + k;
    await nft.mint(owner.address, twin);
    let add = 0;
    for (let i = 0; i < k; i++) add = await used(auth.addSigner(twin, keys[i].pk1, keys[i].pk2, keys[i].pop));
    if (k === 1) out.dataAuthenticator.addSigner = add;
    await auth.setThreshold(twin, k);
    const s = py("batch", { chainId, contract, twin: String(twin), seq: "0", root: tree.root, seeds: seeds.slice(0, k).join(",") });
    out.dataAuthenticator.submitBatch.push({ signers: k, gas: await used(auth.submitBatch(twin, 0, tree.root, (2 ** k - 1) >>> 0, s.sig, s.apk2)) });
  }
  out.dataAuthenticator.isAuthentic_256_records = Number(await auth.isAuthentic.estimateGas(108, 0, tree.records[17], tree.proofs[17]));

  await auth.depositBond(108, { value: 1n });
  const fork = ethers.id("fork");
  const f = py("batch", { chainId, contract, twin: "108", seq: "0", root: fork, seeds: seeds.slice(0, 8).join(",") });
  out.dataAuthenticator.reportEquivocation_8_signers = await used(auth.reportEquivocation(108, 0, fork, 255, f.sig, f.apk2));
}

async function birth(out) {
  const [alice] = await ethers.getSigners();
  const nft = await ethers.deployContract("MockTwinNFT");
  const cert = JSON.stringify(["wind-turbine/V2", "ACME Turbines s.r.o.", "SN-2026-0042", 20260115, "design", "state"]);
  const Reg = await ethers.getContractFactory("BirthCertificateRegistry");
  const reg = await Reg.deploy(await nft.getAddress(), 6);
  const receipt = await reg.deploymentTransaction().wait();
  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  const contract = await reg.getAddress();
  const o = py("commit", { attrs: cert, seed: "gas" });
  out.birthCertificate = { deploy_6_attributes: Number(receipt.gasUsed), prove: [] };
  await nft.mint(alice.address, 1);
  out.birthCertificate.register = await used(reg.registerBirthCertificate(1, o.commitment));
  for (let shown = 0; shown <= 6; shown++) {
    const mask = (1 << shown) - 1;
    const p = py("prove", { chainId, contract, token: "1", prover: alice.address, attrs: cert, r: o.r, mask: String(mask) });
    out.birthCertificate.prove.push({ disclosed: shown, gas: await used(reg.proveCertificate(1, p)) });
  }
  const rot = py("rotate", { chainId, contract, token: "1", prover: alice.address, attrs: cert, r: o.r });
  out.birthCertificate.rotate = await used(reg.rotateCommitment(1, rot.commitment, rot.t, rot.s));
}

async function keyServers(out) {
  const [dao, , ...ops] = await ethers.getSigners();
  const reg = await ethers.deployContract("KeyServerRegistry", [dao.address]);
  const d = py("keyservers", { n: "5", t: "3", seed: "gas" });
  const servers = d.shares.map((s, i) => ({ operator: ops[i].address, endpoint: `https://ks${i + 1}.example`, publicShare: s }));
  out.keyServerRegistry = { setParameters_5_servers: await used(reg.setParameters(d.masterPublic, 3, servers)) };
}

async function main() {
  const out = { generatedAt: new Date().toISOString() };
  await dataAuth(out);
  await birth(out);
  await keyServers(out);
  const dir = path.join(__dirname, "..", "..", "results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "gas.json"), JSON.stringify(out, null, 2) + "\n");
  console.table(out.dataAuthenticator.submitBatch);
  console.table(out.birthCertificate.prove);
  console.log(JSON.stringify({ ...out, dataAuthenticator: { ...out.dataAuthenticator, submitBatch: undefined }, birthCertificate: { ...out.birthCertificate, prove: undefined } }, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

// Measures on-chain gas of the L3 prototype and writes results/gas.json (used by analysis/make_figures.py).
// Usage: npm run benchmark
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { attest, utsFromEvent } = require("../lib/l3");

const VALIDATOR_COUNTS = [1, 4, 7, 10, 13, 16, 19, 22, 25];
const PAYLOAD_SIZES = [32, 256, 1024, 4096];
const bft = (n) => Math.floor((2 * n) / 3) + 1; // BFT quorum: tolerates f < n/3 faulty validators

async function deliverGas(n) {
  const [sender] = await ethers.getSigners();
  const validators = Array.from({ length: n }, () => ethers.Wallet.createRandom());
  const addrs = validators.map((v) => v.address);
  const t = bft(n);
  const a = await ethers.deployContract("L3Gateway", [1, addrs, t]);
  const b = await ethers.deployContract("L3Gateway", [2, addrs, t]);
  const receiver = await ethers.deployContract("MockReceiver");
  const tx = await a.connect(sender).dispatch(2, await receiver.getAddress(), ethers.hexlify(ethers.randomBytes(32)));
  const ev = (await a.queryFilter(a.filters.MessageDispatched(), tx.blockNumber))[0];
  const sigs = await attest(ev.args.id, validators.slice(0, t));
  const receipt = await (await b.deliver(utsFromEvent(1, ev), sigs)).wait();
  return { validators: n, threshold: t, gas: Number(receipt.gasUsed) };
}

async function dispatchGas(size) {
  const g = await ethers.deployContract("L3Gateway", [1, [ethers.Wallet.createRandom().address], 1]);
  await (await g.dispatch(2, ethers.ZeroAddress, "0x")).wait(); // warm the nonce slot
  const receipt = await (await g.dispatch(2, ethers.ZeroAddress, ethers.hexlify(ethers.randomBytes(size)))).wait();
  return { bytes: size, gas: Number(receipt.gasUsed) };
}

async function workflowGas() {
  const [, team1, team2] = await ethers.getSigners();
  const validators = Array.from({ length: 5 }, () => ethers.Wallet.createRandom());
  const addrs = validators.map((v) => v.address);
  const gA = await ethers.deployContract("L3Gateway", [1, addrs, 3]);
  const gB = await ethers.deployContract("L3Gateway", [2, addrs, 3]);
  const dA = await ethers.deployContract("DigitalTwinDNFT", [await gA.getAddress()]);
  const dB = await ethers.deployContract("DigitalTwinDNFT", [await gB.getAddress()]);
  await dA.setTrustedRemote(2, await dB.getAddress());
  await dB.setTrustedRemote(1, await dA.getAddress());
  const gas = async (p) => Number((await (await p).wait()).gasUsed);
  const relay = async (src, dst, origin) => {
    const evs = await src.queryFilter(src.filters.MessageDispatched());
    const ev = evs[evs.length - 1];
    return gas(dst.deliver(utsFromEvent(origin, ev), await attest(ev.args.id, validators.slice(0, 3))));
  };

  const out = {};
  out["Mint twin dNFT"] = await gas(dA.connect(team1).mint(ethers.id("v1"), "ipfs://twin"));
  out["Update state"] = await gas(dA.connect(team1).updateState(1, ethers.id("v2"), ""));
  out["Share (chain A)"] = await gas(dA.connect(team1).shareTwin(1, 2, team2.address));
  out["Deliver share (chain B)"] = await relay(gA, gB, 1);
  out["Contribute (chain B)"] = await gas(dB.connect(team2).contribute(1, ethers.id("v3"), ""));
  out["Deliver contribution (chain A)"] = await relay(gB, gA, 2);

  const htlc = await ethers.deployContract("HashTimeLock");
  const hashlock = ethers.keccak256(ethers.ZeroHash);
  const later = Math.floor(Date.now() / 1000) + 86400 * 365;
  await (await dA.connect(team1).approve(await htlc.getAddress(), 1)).wait();
  const lockTx = htlc.connect(team1).lockNFT(team2.address, await dA.getAddress(), 1, hashlock, later);
  out["HTLC lock dNFT"] = await gas(lockTx);
  const id = (await htlc.queryFilter(htlc.filters.Locked()))[0].args.id;
  out["HTLC claim"] = await gas(htlc.claim(id, ethers.ZeroHash));
  return out;
}

async function main() {
  const results = { generatedAt: new Date().toISOString(), deliver: [], dispatch: [], workflow: {} };
  for (const n of VALIDATOR_COUNTS) results.deliver.push(await deliverGas(n));
  for (const s of PAYLOAD_SIZES) results.dispatch.push(await dispatchGas(s));
  results.workflow = await workflowGas();

  const out = path.join(__dirname, "..", "results", "gas.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.table(results.deliver);
  console.table(results.dispatch);
  console.table(results.workflow);
  console.log(`saved ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

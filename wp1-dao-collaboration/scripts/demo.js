// Walkthrough of the generic L3 framework (Banaeian Far & Hosseini Bamakan, 2025, Fig. 3):
// two digital twin teams on two blockchains collaborate on one twin without a central authority.
// Usage: npm run demo
const { ethers } = require("hardhat");
const { attest, utsFromEvent } = require("../lib/l3");

const DOMAIN_A = 1001;
const DOMAIN_B = 2002;
const short = (x) => `${x.slice(0, 10)}…`;
const phase = (t) => console.log(`\n━━ ${t} ${"━".repeat(Math.max(0, 60 - t.length))}`);
const step = (n, t) => console.log(`[Step ${String(n).padStart(2)}] ${t}`);

async function relay(source, dest, validators, relayer) {
  const origin = await source.localDomain();
  const threshold = Number(await dest.threshold());
  const events = await source.queryFilter(source.filters.MessageDispatched(null, await dest.localDomain()));
  for (const ev of events) {
    if (await dest.delivered(ev.args.id)) continue;
    const sigs = await attest(ev.args.id, validators.slice(0, threshold), dest);
    console.log(`           ${threshold}/${validators.length} validators attest ${short(ev.args.id)}; relayer delivers it`);
    const receipt = await (await dest.connect(relayer).deliver(utsFromEvent(origin, ev), sigs)).wait();
    console.log(`           delivered on domain ${await dest.localDomain()} (gas ${receipt.gasUsed})`);
  }
}

async function main() {
  const [, team1, team2, relayer] = await ethers.getSigners();
  const validators = Array.from({ length: 5 }, () => ethers.Wallet.createRandom());

  phase("Phase 1 · Initialization");
  step(1, "DT team #1 launches its project as a dNFT on public blockchain A");
  const gatewayA = await ethers.deployContract("L3Gateway", [DOMAIN_A, validators.map((v) => v.address), 3]);
  const dnftA = await ethers.deployContract("DigitalTwinDNFT", [await gatewayA.getAddress()]);
  await dnftA.connect(team1).mint(ethers.id("robot-arm twin v1"), "ipfs://robot-arm");
  step(2, "Team #1 develops the twin (new state version)");
  await dnftA.connect(team1).updateState(1, ethers.id("robot-arm twin v2"), "");
  console.log(`           twin #1 version ${(await dnftA.twin(1)).version}`);
  step(3, "L3 developers collect the protocols of blockchains A and B");
  step(4, "Algorithm 1: launch the L3 network — 5 validators, quorum 3, no admin");
  const gatewayB = await ethers.deployContract("L3Gateway", [DOMAIN_B, validators.map((v) => v.address), 3]);
  const dnftB = await ethers.deployContract("DigitalTwinDNFT", [await gatewayB.getAddress()]);
  step(5, "Deploy the L3 smart contracts on A and B and link the dNFT apps");
  await dnftA.setTrustedRemote(DOMAIN_B, await dnftB.getAddress());
  await dnftB.setTrustedRemote(DOMAIN_A, await dnftA.getAddress());
  console.log(`           gateway A ${short(await gatewayA.getAddress())}  gateway B ${short(await gatewayB.getAddress())}`);

  phase("Phase 2 · Data sharing");
  step(6, "Team #1 asks team #2 to collaborate (off-chain agreement)");
  step(7, "Team #1 looks up the L3 mechanism on blockchain A");
  step(8, "Team #1 submits the L3 request: shareTwin(#1 → team #2 on B)");
  step(9, "Algorithm 3: gateway A encodes the UTS and derives the message ID");
  await dnftA.connect(team1).shareTwin(1, DOMAIN_B, team2.address);
  step(10, "The L3 transaction is emitted for the validators");
  step(11, "Algorithm 4: validators verify and sign it");
  step(12, "Relayer submits it to blockchain B");
  await relay(gatewayA, gatewayB, validators, relayer);
  const mirrorId = await dnftB.mirrorOf(DOMAIN_A, 1, team2.address);
  console.log(`           team #2 now holds mirror dNFT #${mirrorId} on B`);

  phase("Phase 3 · Data using");
  step(13, "Team #2 modifies the shared twin; the change flows back to A");
  await dnftB.connect(team2).contribute(mirrorId, ethers.id("robot-arm twin v3 (team #2)"), "");
  await relay(gatewayB, gatewayA, validators, relayer);

  const n = await dnftA.historyLength(1);
  console.log("\n  Provenance of twin #1 on blockchain A:");
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = await dnftA.revisionAt(1, i);
    rows.push({ version: i + 1, author: r.author === team1.address ? "team #1" : "team #2", chain: Number(r.authorDomain) === DOMAIN_A ? "A" : "B", stateHash: short(r.stateHash) });
  }
  console.table(rows);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

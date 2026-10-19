// Off-chain side of the L3 network: validators attest dispatched messages, and a
// permissionless relayer delivers them to the destination gateway (paper Steps 9–12).
//
// `source` and `dest` are ethers Contract instances of L3Gateway. They can be connected to
// two different RPC endpoints (two real blockchains) or to the same in-memory Hardhat network.
const { ethers } = require("ethers");

/** Rebuild the Universal Transaction Schema from a MessageDispatched event. */
function utsFromEvent(originDomain, ev) {
  const { destDomain, nonce, sender, recipient, payload } = ev.args;
  return { originDomain, destDomain, nonce, sender, recipient, payload };
}

/**
 * Each validator signs the destination gateway's attestation digest (EIP-191) for a message ID.
 * The digest binds the destination chain ID and gateway address, so the signatures are valid
 * only on `dest` (an ethers Contract of the destination L3Gateway).
 */
async function attest(id, validators, dest) {
  const provider = dest.runner.provider ?? dest.runner;
  const { chainId } = await provider.getNetwork();
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "bytes32"],
      [ethers.keccak256(ethers.toUtf8Bytes("DeDT-L3/attest/v2")), chainId, await dest.getAddress(), id]
    )
  );
  const sigs = await Promise.all(
    validators.map(async (v) => ({ signer: (await v.getAddress()).toLowerCase(), sig: await v.signMessage(ethers.getBytes(inner)) }))
  );
  return sortBySigner(sigs);
}

/** The gateway requires signatures ordered by ascending signer address (rejects duplicates). */
function sortBySigner(sigs) {
  return sigs.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1)).map((s) => s.sig);
}

/**
 * Find every message dispatched on `source` for `dest` that has not been delivered yet,
 * collect a quorum of attestations and deliver it. Returns the delivered message IDs.
 */
async function relayPending({ source, dest, validators, relayer, fromBlock = 0 }) {
  const originDomain = await source.localDomain();
  const destDomain = await dest.localDomain();
  const threshold = Number(await dest.threshold());
  const events = await source.queryFilter(source.filters.MessageDispatched(null, destDomain), fromBlock);

  const deliveredIds = [];
  for (const ev of events) {
    const id = ev.args.id;
    if (await dest.delivered(id)) continue;
    const signatures = await attest(id, validators.slice(0, threshold), dest);
    const tx = await dest.connect(relayer).deliver(utsFromEvent(originDomain, ev), signatures);
    await tx.wait();
    deliveredIds.push(id);
  }
  return deliveredIds;
}

module.exports = { attest, relayPending, sortBySigner, utsFromEvent };

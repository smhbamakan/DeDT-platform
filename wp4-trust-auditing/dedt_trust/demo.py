"""End-to-end scenario of WP4 (T4.4): encryption and validity methods applied to the
interconnection of two twin teams. Usage: python -m dedt_trust.demo

  1. Key servers elected by the DAO run a distributed key generation (no central PKG).
  2. Team 1 shares a twin with team 2 on another chain; the twin package is IBE-encrypted to
     team 2's identity, so team 1 needs no public key or certificate of team 2.
  3. Team 2 collects partial keys from 3 of 5 servers (one offline, one cheating) and decrypts.
  4. The twin's sensors co-sign data batches; anyone can judge a record; an equivocation is caught.
  5. The twin NFT carries a commitment to the birth certificate; the holder proves it in zero
     knowledge, disclosing only the manufacturer; after a sale the commitment is rotated.
"""
from __future__ import annotations

import random
import time

from . import bls, dkg, ibe, merkle, zkp
from .bn254 import G1, add, keccak

CHAIN_A, CHAIN_B = 1001, 2002
TEAM1, TEAM2 = "0x" + "a1" * 20, "0x" + "b2" * 20
EPOCH = "2026-10"


def phase(title: str) -> None:
    print(f"\n━━ {title} {'━' * max(0, 66 - len(title))}")


def step(text: str, t0: float | None = None) -> None:
    print(f"  • {text}" + (f"  ({(time.perf_counter() - t0) * 1000:,.0f} ms)" if t0 is not None else ""))


def main() -> None:
    rng = random.Random(2026)

    phase("1 · Distributed key generation (5 key servers, any 3 suffice)")
    t0 = time.perf_counter()
    net = dkg.KeyServerNetwork.setup(5, 3, rng)
    step(f"Joint-Feldman DKG finished; qualified servers {net.qualified}", t0)
    step("master public key published in KeyServerRegistry (owned by the DAO timelock)")

    phase("2 · Team 1 shares an encrypted twin with team 2")
    package = b'{"twin":"wind-turbine/V2","stateHash":"0x9f..","model":"<5 MB of design data>"}'
    bob = ibe.team_identity(CHAIN_B, TEAM2, EPOCH)
    t0 = time.perf_counter()
    ct = ibe.encrypt(net.master_public, bob, package, aad=b"twin#1")
    step(f"encrypted to identity '{bob}'", t0)
    step(f"ciphertext {len(ct)} B = payload {len(package)} B + {ibe.OVERHEAD_BYTES} B; its hash and URI travel in the D1.3 Share message")

    phase("3 · Team 2 obtains its key from the servers and decrypts")
    honest = net.server(4).extract_partial
    net.server(4).extract_partial = lambda identity, credential=None: add(honest(identity), G1)  # cheating server
    offline = {2}
    t0 = time.perf_counter()
    partials = {}
    for j in (1, 2, 4, 3, 5):
        if j in offline:
            step(f"server {j}: offline")
            continue
        d_j = net.server(j).extract_partial(bob)
        ok = dkg.verify_partial(net, j, bob, d_j)
        step(f"server {j}: partial key {'verified' if ok else 'INVALID — discarded'}")
        if ok:
            partials[j] = d_j
        if len(partials) == net.t:
            break
    d = dkg.combine(partials)
    step(f"combined servers {sorted(partials)}; key valid: {ibe.verify_private_key(net.master_public, bob, d)}", t0)
    step(f"decrypted: {ibe.decrypt(d, bob, ct, aad=b'twin#1')[:40].decode()}…")

    phase("4 · Self-judging authentication of the twin's sensor data")
    sensors = [bls.Signer.from_seed(f"turbine-sensor-{i}") for i in range(4)]
    step(f"4 sensors registered with proofs of possession: {all(bls.verify_pop(s.pk1, s.pk2, s.proof_of_possession()) for s in sensors)}")
    records = [keccak(f"t={i} rpm={1480 + i} vib={0.02 + i / 1000:.3f}".encode()) for i in range(8)]
    levels = merkle.build([merkle.leaf(r) for r in records])
    root = merkle.root(levels)
    msg = bls.batch_message(CHAIN_A, "0x" + "da" * 20, 1, 0, root)
    t0 = time.perf_counter()
    ms = bls.multisign(sensors[:3], msg)
    step(f"batch 0 (8 readings) co-signed by sensors 0,1,2; valid: {bls.verify_dual(ms['sig'], ms['apk1'], ms['apk2'], msg)}", t0)
    step(f"record 5 judged authentic: {merkle.verify(merkle.proof(levels, 5), root, merkle.leaf(records[5]))}; "
         f"altered record: {merkle.verify(merkle.proof(levels, 5), root, merkle.leaf(keccak(b'forged')))}")
    fork = bls.batch_message(CHAIN_A, "0x" + "da" * 20, 1, 0, keccak(b"rewritten"))
    ms2 = bls.multisign(sensors[1:], fork)
    if bls.verify_dual(ms2["sig"], ms2["apk1"], ms2["apk2"], fork):
        step("sensors 1 and 2 also signed a different root for batch 0 → equivocation proven: "
             "they are revoked, the feed is frozen, the bond goes to the reporter")

    phase("5 · Zero-knowledge link between the twin NFT and its birth certificate")
    cert = ["wind-turbine/V2", "ACME Turbines s.r.o.", "SN-2026-0042", 20260115, b"design-spec", b"initial-state"]
    m = [zkp.attribute(v) for v in cert]
    r = rng.getrandbits(250)
    c = zkp.commit(m, r)
    step("commitment to 6 attributes stored on NFT #7 at minting")
    ctx = {"chain_id": CHAIN_A, "contract": "0x" + "bc" * 20, "token_id": 7, "prover": TEAM1}
    t0 = time.perf_counter()
    p = zkp.prove_certificate(m, r, 0b000010, ctx, rng)
    step(f"team 1 proves the certificate, disclosing only the manufacturer: {zkp.verify_certificate(c, 6, p, ctx)}", t0)
    step(f"the same proof replayed by team 2: {zkp.verify_certificate(c, 6, p, {**ctx, 'prover': TEAM2})}")
    ctx2 = {**ctx, "prover": TEAM2}
    r2, c2, rot = zkp.rotate(m, r, ctx2, rng)  # team 2 bought the twin and received the opening
    step(f"NFT sold to team 2, which rotates the commitment: {zkp.verify_rotation(c, c2, rot, ctx2, 6)}")
    step(f"team 1 (old opening) can still prove: {zkp.verify_certificate(c2, 6, zkp.prove_certificate(m, r, 0, ctx), ctx)}; "
         f"team 2 can: {zkp.verify_certificate(c2, 6, zkp.prove_certificate(m, r2, 0, ctx2), ctx2)}")
    print()


if __name__ == "__main__":
    main()

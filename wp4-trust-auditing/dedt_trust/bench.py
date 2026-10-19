"""Benchmarks of the WP4 protocols (pure-Python prototype). Usage: python -m dedt_trust.bench

Writes results/bench.json. Times are medians over repetitions on the machine that runs the script.
The pairing library (py_ecc) is pure Python and roughly three orders of magnitude slower than
native ones, so the report also gives operation counts, which do not depend on the implementation.
"""
from __future__ import annotations

import json
import os
import platform
import random
import statistics
import time
from pathlib import Path

from . import baseline, bls, dkg, ibe, zkp
from .bn254 import G1, G2, multiply, pairing

OUT = Path(__file__).resolve().parent.parent / "results"


def timeit(fn, reps: int) -> float:
    ts = []
    for _ in range(reps):
        t0 = time.perf_counter()
        fn()
        ts.append(time.perf_counter() - t0)
    return statistics.median(ts) * 1000  # ms


def main(reps: int = 5) -> dict:
    rng = random.Random(7)
    res: dict = {"python": platform.python_version(), "machine": platform.processor() or platform.machine(), "reps": reps}

    # primitives
    res["primitives_ms"] = {
        "pairing": timeit(lambda: pairing(G2, G1), reps),
        "G1 scalar mult": timeit(lambda: multiply(G1, rng.getrandbits(254)), reps * 4),
        "G2 scalar mult": timeit(lambda: multiply(G2, rng.getrandbits(254)), reps * 4),
    }

    # IBE vs ECIES
    net = dkg.KeyServerNetwork.setup(5, 3, rng)
    ident = ibe.team_identity(2002, "0x" + "b2" * 20, "2026-10")
    d = dkg.obtain_key(net, ident, [1, 2, 3])
    payload = os.urandom(1024)
    ct = ibe.encrypt(net.master_public, ident, payload)
    sk, pk = baseline.generate_keypair()
    ect = baseline.encrypt(pk, payload)
    res["encryption_ms"] = {
        "IBE encrypt": timeit(lambda: ibe.encrypt(net.master_public, ident, payload), reps),
        "IBE decrypt": timeit(lambda: ibe.decrypt(d, ident, ct), reps),
        "ECIES encrypt": timeit(lambda: baseline.encrypt(pk, payload), reps * 20),
        "ECIES decrypt": timeit(lambda: baseline.decrypt(sk, ect), reps * 20),
        "partial key (1 server)": timeit(lambda: net.server(1).extract_partial(ident), reps),
        "verify partial key": timeit(lambda: dkg.verify_partial(net, 1, ident, net.server(1).extract_partial(ident)), reps),
        "obtain key (t = 3, verified)": timeit(lambda: dkg.obtain_key(net, ident, [1, 2, 3]), max(2, reps // 2)),
    }
    res["overhead_bytes"] = {"IBE": ibe.OVERHEAD_BYTES, "ECIES": baseline.OVERHEAD_BYTES}
    res["operation_counts"] = {
        "IBE encrypt": {"pairings": 1, "G1 mult": 1, "G2 mult": 1, "hash to G1": 1},
        "IBE decrypt": {"pairings": 1, "G2 mult": 1},
        "partial key": {"G1 mult": 1, "hash to G1": 1},
        "verify partial key": {"pairings": 2},
        "ECIES encrypt": {"EC mult (secp256k1)": 2},
        "ECIES decrypt": {"EC mult (secp256k1)": 1},
    }

    # DKG scaling
    res["dkg_ms"] = {}
    for n in (3, 5, 7, 9):
        t = 2 * n // 3 + 1
        res["dkg_ms"][n] = {"t": t, "ms": timeit(lambda: dkg.KeyServerNetwork.setup(n, t, rng), 1)}

    # BLS
    signers = [bls.Signer.from_seed(f"b{i}") for i in range(8)]
    msg = bls.batch_message(31337, "0x" + "11" * 20, 1, 0, b"\x01" * 32)
    sigs = [s.sign(msg) for s in signers]
    ms = bls.multisign(signers[:3], msg)
    res["bls_ms"] = {
        "sign": timeit(lambda: signers[0].sign(msg), reps),
        "aggregate 8 signatures": timeit(lambda: bls.aggregate(sigs), reps),
        "verify aggregate (dual check)": timeit(lambda: bls.verify_dual(ms["sig"], ms["apk1"], ms["apk2"], msg), max(2, reps // 2)),
    }

    # ZKP
    cert = [zkp.attribute(f"attr-{i}") for i in range(6)]
    r = rng.getrandbits(250)
    ctx = {"chain_id": 1, "contract": "0x" + "22" * 20, "token_id": 1, "prover": "0x" + "33" * 20}
    c = zkp.commit(cert, r)
    res["zkp_ms"] = {}
    for shown in range(0, 7, 2):
        mask = (1 << shown) - 1
        p = zkp.prove_certificate(cert, r, mask, ctx, rng)
        res["zkp_ms"][shown] = {
            "prove": timeit(lambda: zkp.prove_certificate(cert, r, mask, ctx, rng), reps),
            "verify": timeit(lambda: zkp.verify_certificate(c, 6, p, ctx), reps),
        }
    res["zkp_proof_bytes"] = {str(s): 64 + 32 + 32 * (6 - s) + 32 * s + 32 for s in range(7)}  # T, s_r, s_hidden, disclosed, mask

    OUT.mkdir(exist_ok=True)
    (OUT / "bench.json").write_text(json.dumps(res, indent=2))
    return res


if __name__ == "__main__":
    print(json.dumps(main(), indent=1))

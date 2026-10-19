"""JSON command-line interface to dedt_trust, used by the Hardhat tests and scripts.

The contracts bind signatures and proofs to the chain ID and their own address, which are only
known after deployment, so the tests call this CLI with those values. Keys derived from seeds
and the seeded random generator are for tests and demos only.

    python -m dedt_trust.cli signers  --seeds a,b,c
    python -m dedt_trust.cli batch    --chain-id 31337 --contract 0x.. --twin 1 --seq 0 --root 0x.. --seeds a,b
    python -m dedt_trust.cli merkle   --records r1,r2,r3
    python -m dedt_trust.cli commit   --attrs '["turbine", 20260101, ...]' --seed s
    python -m dedt_trust.cli prove    --chain-id .. --contract .. --token 1 --prover 0x.. --attrs '[..]' --r N --mask 2 --seed s
    python -m dedt_trust.cli rotate   --chain-id .. --contract .. --token 1 --prover 0x.. --attrs '[..]' --r N --seed s
    python -m dedt_trust.cli keyservers --n 5 --t 3 --seed s
"""
from __future__ import annotations

import argparse
import json
import random
import sys

from . import bls, dkg, merkle, zkp
from .bn254 import g1_to_ints, g2_to_ints, keccak


def _s(xs):
    """Big integers as decimal strings (exact in JavaScript)."""
    return [str(x) for x in xs]


def _g1(p):
    x, y = g1_to_ints(p)
    return {"x": str(x), "y": str(y)}


def _g2(p):
    xi, xr, yi, yr = g2_to_ints(p)
    return {"x": [str(xi), str(xr)], "y": [str(yi), str(yr)]}


def _attrs(text: str) -> list[int]:
    return [zkp.attribute(v) for v in json.loads(text)]


def _ctx(a) -> dict:
    return {"chain_id": a.chain_id, "contract": a.contract, "token_id": a.token, "prover": a.prover}


def cmd_signers(a):
    out = []
    for seed in a.seeds.split(","):
        s = bls.Signer.from_seed(seed)
        out.append({"seed": seed, "pk1": _g1(s.pk1), "pk2": _g2(s.pk2), "pop": _g1(s.proof_of_possession())})
    return out


def cmd_batch(a):
    msg = bls.batch_message(a.chain_id, a.contract, a.twin, a.seq, bytes.fromhex(a.root[2:]))
    ms = bls.multisign([bls.Signer.from_seed(x) for x in a.seeds.split(",")], msg)
    return {"message": "0x" + msg.hex(), "sig": _g1(ms["sig"]), "apk1": _g1(ms["apk1"]), "apk2": _g2(ms["apk2"])}


def cmd_merkle(a):
    records = [keccak(r.encode()) for r in a.records.split(",")]
    levels = merkle.build([merkle.leaf(r) for r in records])
    return {
        "root": "0x" + merkle.root(levels).hex(),
        "records": ["0x" + r.hex() for r in records],
        "proofs": [["0x" + p.hex() for p in merkle.proof(levels, i)] for i in range(len(records))],
    }


def cmd_commit(a):
    rng = random.Random(a.seed)
    m = _attrs(a.attrs)
    r = rng.getrandbits(250) + 1
    return {"attrs": _s(m), "r": str(r), "commitment": _g1(zkp.commit(m, r))}


def cmd_prove(a):
    m = _attrs(a.attrs)
    p = zkp.prove_certificate(m, int(a.r), a.mask, _ctx(a), random.Random(a.seed))
    return {"mask": str(p.mask), "disclosed": _s(p.disclosed), "t": _g1(p.t), "sHidden": _s(p.s_hidden), "sR": str(p.s_r)}


def cmd_rotate(a):
    m = _attrs(a.attrs)
    r_new, c_new, (t, s) = zkp.rotate(m, int(a.r), _ctx(a), random.Random(a.seed))
    return {"r": str(r_new), "commitment": _g1(c_new), "t": _g1(t), "s": str(s)}


def cmd_keyservers(a):
    net = dkg.KeyServerNetwork.setup(a.n, a.t, random.Random(a.seed))
    return {"masterPublic": _g2(net.master_public), "shares": [_g2(net.public_shares[j]) for j in range(1, a.n + 1)]}


def main(argv=None):
    ap = argparse.ArgumentParser(prog="dedt_trust.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("signers")
    p.add_argument("--seeds", required=True)
    p = sub.add_parser("batch")
    for k in ("--chain-id", "--twin", "--seq"):
        p.add_argument(k, type=int, required=True)
    for k in ("--contract", "--root", "--seeds"):
        p.add_argument(k, required=True)
    p = sub.add_parser("merkle")
    p.add_argument("--records", required=True)
    p = sub.add_parser("commit")
    p.add_argument("--attrs", required=True)
    p.add_argument("--seed", default="commit")
    for name in ("prove", "rotate"):
        p = sub.add_parser(name)
        p.add_argument("--chain-id", type=int, required=True)
        p.add_argument("--token", type=int, required=True)
        p.add_argument("--contract", required=True)
        p.add_argument("--prover", required=True)
        p.add_argument("--attrs", required=True)
        p.add_argument("--r", required=True)
        p.add_argument("--seed", default=name)
        if name == "prove":
            p.add_argument("--mask", type=int, default=0)
    p = sub.add_parser("keyservers")
    p.add_argument("--n", type=int, required=True)
    p.add_argument("--t", type=int, required=True)
    p.add_argument("--seed", default="dkg")
    a = ap.parse_args(argv)
    json.dump(globals()[f"cmd_{a.cmd}"](a), sys.stdout)


if __name__ == "__main__":
    main()

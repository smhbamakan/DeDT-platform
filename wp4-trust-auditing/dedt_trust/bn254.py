"""BN254 (alt_bn128) helpers shared by every WP4 protocol.

BN254 is the pairing-friendly curve that the EVM supports natively (EIP-196 point addition and
scalar multiplication on G1, EIP-197 pairing check), so everything built on it can be verified by
smart contracts. Security level: about 100 bits after the exTNFS improvements (Kim and Barbulescu,
2016); see the README for the discussion.

Conventions shared with contracts/BN254.sol:
  * hashes are keccak-256 over ABI-encoded 32-byte words;
  * G1 points are (x, y) integers, G2 points are encoded as EIP-197 expects,
    [x_imag, x_real, y_imag, y_real];
  * hash_to_g1 is try-and-increment: x = keccak(abi.encode(dst, msg, ctr)) mod p, until
    x^3 + 3 is a square; y = (x^3 + 3)^((p+1)/4). The cofactor of G1 is 1, so every curve point
    is in the prime-order group.
"""
from __future__ import annotations

import secrets
from typing import Iterable, Sequence

from Crypto.Hash import keccak as _keccak
from py_ecc.optimized_bn128 import (
    FQ,
    FQ2,
    FQ12,
    G1,
    G2,
    Z1,
    Z2,
    add,
    curve_order,
    eq,
    field_modulus,
    is_inf,
    multiply,
    neg,
    normalize,
    pairing,
)

P = field_modulus  # base field
Q = curve_order  # prime order of G1, G2, GT

__all__ = [
    "P", "Q", "G1", "G2", "Z1", "Z2", "add", "eq", "neg", "multiply", "pairing", "is_inf",
    "keccak", "word", "address_word", "abi_encode", "hash_to_scalar", "random_scalar",
    "hash_to_g1", "g1_to_ints", "g1_from_ints", "g2_to_ints", "g2_from_ints", "gt_bytes",
    "g1_sum", "g2_sum", "lin_comb_g1", "lagrange_at_zero",
]


def keccak(data: bytes) -> bytes:
    h = _keccak.new(digest_bits=256)
    h.update(data)
    return h.digest()


def word(x: int | bytes) -> bytes:
    """One ABI word: an unsigned integer or a bytes32 value."""
    if isinstance(x, (bytes, bytearray)):
        if len(x) != 32:
            raise ValueError("bytes32 expected")
        return bytes(x)
    if x < 0 or x >= 2**256:
        raise ValueError("uint256 out of range")
    return int(x).to_bytes(32, "big")


def address_word(addr: str) -> bytes:
    raw = bytes.fromhex(addr[2:] if addr.startswith("0x") else addr)
    if len(raw) != 20:
        raise ValueError("20-byte address expected")
    return b"\x00" * 12 + raw


def abi_encode(*words: int | bytes) -> bytes:
    """abi.encode of static types already converted to words (ints, bytes32 or address words)."""
    return b"".join(w if isinstance(w, (bytes, bytearray)) and len(w) == 32 else word(w) for w in words)


def hash_to_scalar(data: bytes) -> int:
    return int.from_bytes(keccak(data), "big") % Q


def random_scalar(rng=None) -> int:
    """Uniform non-zero scalar. `rng` (random.Random) is only for reproducible test fixtures."""
    while True:
        k = (rng.getrandbits(256) if rng is not None else secrets.randbits(256)) % Q
        if k:
            return k


def hash_to_g1(dst: bytes, msg: bytes):
    """Deterministic map of (domain tag, 32-byte message) to G1, identical to BN254.hashToG1."""
    ctr = 0
    while True:
        x = int.from_bytes(keccak(abi_encode(dst, msg, ctr)), "big") % P
        rhs = (pow(x, 3, P) + 3) % P
        y = pow(rhs, (P + 1) // 4, P)
        if y * y % P == rhs:
            return (FQ(x), FQ(y), FQ(1))
        ctr += 1


# ------------------------------------------------------------------ encodings


def g1_to_ints(pt) -> list[int]:
    if is_inf(pt):
        return [0, 0]
    x, y = normalize(pt)
    return [int(x), int(y)]


def g1_from_ints(xy: Sequence[int]):
    x, y = (int(v) for v in xy)
    if x == 0 and y == 0:
        return Z1
    pt = (FQ(x), FQ(y), FQ(1))
    if (y * y - x * x * x - 3) % P:
        raise ValueError("not a G1 point")
    return pt


def g2_to_ints(pt) -> list[int]:
    """EIP-197 encoding: [x_imag, x_real, y_imag, y_real]."""
    x, y = normalize(pt)
    xr, xi = (int(c) for c in x.coeffs)
    yr, yi = (int(c) for c in y.coeffs)
    return [xi, xr, yi, yr]


def g2_from_ints(v: Sequence[int]):
    xi, xr, yi, yr = (int(c) for c in v)
    pt = (FQ2([xr, xi]), FQ2([yr, yi]), FQ2.one())
    # subgroup check: the twist has a large cofactor, so on-curve is not enough
    if not is_inf(multiply(pt, Q)):
        raise ValueError("not a G2 point of order q")
    return pt


def gt_bytes(e: FQ12) -> bytes:
    return b"".join(int(c).to_bytes(32, "big") for c in e.coeffs)


# ------------------------------------------------------------------ group arithmetic


def g1_sum(points: Iterable):
    acc = Z1
    for p in points:
        acc = add(acc, p)
    return acc


def g2_sum(points: Iterable):
    acc = Z2
    for p in points:
        acc = add(acc, p)
    return acc


def lin_comb_g1(scalars: Sequence[int], points: Sequence):
    return g1_sum(multiply(p, s % Q) for s, p in zip(scalars, points) if s % Q)


def lagrange_at_zero(indices: Sequence[int]) -> list[int]:
    """Lagrange coefficients λ_i for interpolating f(0) from f(i), i in `indices` (distinct, non-zero)."""
    lams = []
    for i in indices:
        num, den = 1, 1
        for j in indices:
            if j != i:
                num = num * j % Q
                den = den * (j - i) % Q
        lams.append(num * pow(den, -1, Q) % Q)
    return lams

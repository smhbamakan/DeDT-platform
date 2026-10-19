"""Zero-knowledge link between a digital twin's birth certificate and its NFT (T4.3).

A twin's *birth certificate* is the set of attributes fixed when the physical asset and its twin
were created (asset type, manufacturer, serial number, date of birth, design-specification hash,
first state hash, ...). At minting, the owner stores on the NFT only a Pedersen vector
commitment to it,

    C = m_1·G_1 + ... + m_k·G_k + r·H                     (G1 of BN254)

with independent generators obtained by hashing to the curve (nobody knows their discrete logs).
C is perfectly hiding and computationally binding (discrete logarithm).

Proof of certificate (selective disclosure). The holder proves, without revealing the hidden
attributes, that it knows an opening of C in which the disclosed attributes D have the stated
values. With C' = C - Σ_{j∈D} v_j·G_j the statement is knowledge of (m_j)_{j∉D}, r such that
C' = Σ_{j∉D} m_j·G_j + r·H — a Schnorr/Okamoto Σ-protocol made non-interactive with Fiat–Shamir:

    T = Σ k_j·G_j + k_r·H,   c = H(ctx, C, D, v, T),   s_j = k_j + c·m_j,   s_r = k_r + c·r
    verify:  Σ s_j·G_j + s_r·H  =  T + c·C'

ctx binds the chain, the verifier contract, the token and the prover's address, so a proof
observed in the mempool cannot be replayed by anyone else.

Commitment rotation. When the NFT is sold, the seller hands the opening to the buyer (e.g.
IBE-encrypted to the buyer's identity). The buyer then replaces C by C_new = C - (r - r')·H, a
commitment to the same attributes with fresh randomness r', proving knowledge of Δ = r - r' with
C - C_new = Δ·H (Schnorr). The seller, who does not know r', can no longer prove anything.

The EVM verifies both proofs with the BN254 precompiles only (no trusted setup, no circuit).
Range or set predicates on hidden attributes ("born after 2020") need a SNARK; D4.3 proposes a
Groth16 circuit for that extension.
"""
from __future__ import annotations

from dataclasses import dataclass

from .bn254 import (
    Q,
    Z1,
    abi_encode,
    add,
    address_word,
    eq,
    g1_sum,
    g1_to_ints,
    hash_to_g1,
    hash_to_scalar,
    keccak,
    multiply,
    neg,
    random_scalar,
    word,
)

DST_GEN = keccak(b"DeDT-ZK/generator/v1")
PROOF_TAG = keccak(b"DeDT-ZK/birth-certificate/v1")
ROTATE_TAG = keccak(b"DeDT-ZK/rotate/v1")
H_INDEX = 2**32  # generator index reserved for H

BIRTH_CERTIFICATE_FIELDS = ["assetType", "manufacturer", "serialNumber", "birthDate", "designSpecHash", "initialStateHash"]


def generators(k: int):
    return [hash_to_g1(DST_GEN, word(j)) for j in range(k)], hash_to_g1(DST_GEN, word(H_INDEX))


def attribute(value: str | int | bytes) -> int:
    """Map an attribute to Z_q: integers as such, strings and bytes by keccak."""
    if isinstance(value, int):
        return value % Q
    data = value.encode() if isinstance(value, str) else value
    return int.from_bytes(keccak(data), "big") % Q


def commit(m: list[int], r: int):
    gs, h = generators(len(m))
    return add(g1_sum(multiply(g, x % Q) for g, x in zip(gs, m) if x % Q), multiply(h, r))


def _values_hash(values: list[int]) -> bytes:
    return keccak(b"".join(word(v % Q) for v in values))


def _challenge(ctx: dict, c_pt, mask: int, values: list[int], t_pt) -> int:
    return hash_to_scalar(
        abi_encode(
            PROOF_TAG, ctx["chain_id"], address_word(ctx["contract"]), ctx["token_id"], address_word(ctx["prover"]),
            *g1_to_ints(c_pt), mask, _values_hash(values), *g1_to_ints(t_pt),
        )
    )


@dataclass
class CertificateProof:
    mask: int  # bit j set = attribute j disclosed
    disclosed: list[int]  # values of the disclosed attributes, in index order
    t: tuple  # commitment T (G1)
    s_hidden: list[int]  # responses for the hidden attributes, in index order
    s_r: int


def prove_certificate(m: list[int], r: int, mask: int, ctx: dict, rng=None) -> CertificateProof:
    k = len(m)
    gs, h = generators(k)
    hidden = [j for j in range(k) if not mask >> j & 1]
    disclosed = [m[j] % Q for j in range(k) if mask >> j & 1]
    ks = {j: random_scalar(rng) for j in hidden}
    k_r = random_scalar(rng)
    t_pt = add(g1_sum(multiply(gs[j], ks[j]) for j in hidden), multiply(h, k_r))
    c = _challenge(ctx, commit(m, r), mask, disclosed, t_pt)
    return CertificateProof(mask, disclosed, t_pt, [(ks[j] + c * m[j]) % Q for j in hidden], (k_r + c * r) % Q)


def verify_certificate(c_pt, k: int, proof: CertificateProof, ctx: dict) -> bool:
    gs, h = generators(k)
    if proof.mask >> k:
        return False
    hidden = [j for j in range(k) if not proof.mask >> j & 1]
    shown = [j for j in range(k) if proof.mask >> j & 1]
    if len(hidden) != len(proof.s_hidden) or len(shown) != len(proof.disclosed):
        return False
    c = _challenge(ctx, c_pt, proof.mask, proof.disclosed, proof.t)
    c_rest = add(c_pt, neg(g1_sum(multiply(gs[j], v % Q) for j, v in zip(shown, proof.disclosed) if v % Q)))
    lhs = add(g1_sum(multiply(gs[j], s) for j, s in zip(hidden, proof.s_hidden) if s), multiply(h, proof.s_r))
    rhs = add(proof.t, multiply(c_rest, c))
    return eq(lhs, rhs)


# ------------------------------------------------------------------ rotation


def _rotate_challenge(ctx: dict, c_old, c_new, t_pt) -> int:
    return hash_to_scalar(
        abi_encode(
            ROTATE_TAG, ctx["chain_id"], address_word(ctx["contract"]), ctx["token_id"], address_word(ctx["prover"]),
            *g1_to_ints(c_old), *g1_to_ints(c_new), *g1_to_ints(t_pt),
        )
    )


def rotate(m: list[int], r_old: int, ctx: dict, rng=None):
    """New randomness r' and a proof that C_new commits to the same attributes as C_old."""
    _, h = generators(len(m))
    r_new = random_scalar(rng)
    c_old, c_new = commit(m, r_old), commit(m, r_new)
    k = random_scalar(rng)
    t_pt = multiply(h, k)
    c = _rotate_challenge(ctx, c_old, c_new, t_pt)
    return r_new, c_new, (t_pt, (k + c * (r_old - r_new)) % Q)


def verify_rotation(c_old, c_new, proof, ctx: dict, k_attrs: int) -> bool:
    _, h = generators(k_attrs)
    t_pt, s = proof
    c = _rotate_challenge(ctx, c_old, c_new, t_pt)
    return eq(multiply(h, s) if s else Z1, add(t_pt, multiply(add(c_old, neg(c_new)), c)))

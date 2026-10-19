"""BLS multi-signatures for self-judging data authentication (T4.2).

Boneh–Lynn–Shacham signatures (2001) on BN254 with signatures in G1. Each signer (a sensor, an
edge gateway or a witness of a twin team) holds sk and publishes the pair
    pk1 = sk·g1 (G1)   and   pk2 = sk·g2 (G2).
The EVM can add G1 points but not G2 points, so a contract aggregates the signers' pk1 and
checks the caller-supplied aggregate apk2 with the same pairing check as the signature
(the "dual-key" technique):

    γ = H(σ, apk1, apk2, H(m))
    e(σ + γ·apk1, g2) = e(H(m) + γ·g1, apk2)

For an honest aggregate this is e(σ, g2)·e(apk1, g2)^γ = e(H(m), apk2)·e(g1, apk2)^γ, which holds
because σ = Σ sk_i·H(m), apk1 = Σ sk_i·g1, apk2 = Σ sk_i·g2. A random γ makes both equalities
hold separately except with negligible probability. Cost on-chain: one 2-pair pairing check,
independent of the number of signers, plus one G1 addition per signer.

Rogue-key attacks are prevented by a proof of possession (PoP) checked at registration:
a signature by sk on (pk1), with a separate hash domain.
"""
from __future__ import annotations

from dataclasses import dataclass

from .bn254 import (
    G1,
    G2,
    Q,
    abi_encode,
    add,
    address_word,
    g1_sum,
    g1_to_ints,
    g2_sum,
    g2_to_ints,
    hash_to_g1,
    hash_to_scalar,
    keccak,
    multiply,
    pairing,
    random_scalar,
)

DST_SIG = keccak(b"DeDT-BLS/sig/v1")
DST_POP = keccak(b"DeDT-BLS/pop/v1")
BATCH_TAG = keccak(b"DeDT-DataAuth/batch/v1")


@dataclass(frozen=True)
class Signer:
    sk: int

    @classmethod
    def generate(cls, rng=None) -> "Signer":
        return cls(random_scalar(rng))

    @classmethod
    def from_seed(cls, seed: str) -> "Signer":
        """Deterministic key for tests and demos only."""
        return cls(hash_to_scalar(b"DeDT-test-key/" + seed.encode()) or 1)

    @property
    def pk1(self):
        return multiply(G1, self.sk)

    @property
    def pk2(self):
        return multiply(G2, self.sk)

    def sign(self, msg32: bytes, dst: bytes = DST_SIG):
        return multiply(hash_to_g1(dst, msg32), self.sk)

    def proof_of_possession(self):
        return self.sign(pop_message(self.pk1), DST_POP)


def pop_message(pk1) -> bytes:
    return keccak(abi_encode(*g1_to_ints(pk1)))


def batch_message(chain_id: int, contract: str, twin_id: int, seq: int, root: bytes) -> bytes:
    """What the signers of a data batch sign (bound to chain, contract, twin and sequence)."""
    return keccak(abi_encode(BATCH_TAG, chain_id, address_word(contract), twin_id, seq, root))


def aggregate(sigs):
    return g1_sum(sigs)


def _gamma(sig, apk1, apk2, hm) -> int:
    return hash_to_scalar(abi_encode(*g1_to_ints(sig), *g1_to_ints(apk1), *g2_to_ints(apk2), *g1_to_ints(hm)))


def verify_dual(sig, apk1, apk2, msg32: bytes, dst: bytes = DST_SIG) -> bool:
    """The check performed by DataAuthenticator.sol (and by anyone off-chain)."""
    hm = hash_to_g1(dst, msg32)
    g = _gamma(sig, apk1, apk2, hm)
    return pairing(G2, add(sig, multiply(apk1, g))) == pairing(apk2, add(hm, multiply(G1, g)))


def verify_pop(pk1, pk2, pop) -> bool:
    return verify_dual(pop, pk1, pk2, pop_message(pk1), DST_POP)


def multisign(signers: list[Signer], msg32: bytes) -> dict:
    """Aggregate signature of several signers on one message, as submitted on-chain."""
    sig = aggregate(s.sign(msg32) for s in signers)
    apk1 = g1_sum(s.pk1 for s in signers)
    apk2 = g2_sum(s.pk2 for s in signers)
    return {"sig": sig, "apk1": apk1, "apk2": apk2}

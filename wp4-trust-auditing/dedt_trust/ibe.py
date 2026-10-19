"""Identity-based encryption for twin teams (T4.1).

Boneh–Franklin IBE (CRYPTO 2001) on the asymmetric BN254 pairing e: G1 x G2 -> GT, in its
FullIdent form (Fujisaki–Okamoto transform), used as a key-encapsulation mechanism (KEM) whose
key encrypts the payload with AES-256-GCM.

    master key   s in Z_q,            master public key  P_pub = s·g2          (G2)
    identity     Q_ID = H1(ID)        private key        d_ID  = s·Q_ID        (G1)

    Encaps(P_pub, ID):  σ <- {0,1}^256,  r = H3(σ, ID),  U = r·g2,
                        V = σ XOR H2(e(r·Q_ID, P_pub)),     K = H4(σ, U, V)
    Decaps(d_ID, U, V): σ = V XOR H2(e(d_ID, U)),  r = H3(σ, ID),  reject unless U = r·g2,
                        K = H4(σ, U, V)

Correctness: e(d_ID, U) = e(s·Q_ID, r·g2) = e(r·Q_ID, s·g2).
The re-encryption check is what makes FullIdent IND-ID-CCA secure in the random-oracle model
under the bilinear Diffie–Hellman assumption.

Nobody needs the recipient's public key: a team encrypts to an *identity string* that it can
build from public facts (chain, address, epoch). The private key is issued by key servers;
dkg.py removes the single key-generation centre by sharing s among n servers (t-of-n).
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .bn254 import (
    G2,
    Q,
    eq,
    g1_from_ints,
    g1_to_ints,
    g2_from_ints,
    g2_to_ints,
    gt_bytes,
    hash_to_g1,
    keccak,
    multiply,
    pairing,
    random_scalar,
)

DST_ID = keccak(b"DeDT-IBE/H1/v1")


def team_identity(chain_id: int, address: str, epoch: str, role: str = "team") -> str:
    """Canonical identity of a twin team. The epoch (e.g. '2026-10') makes keys expire."""
    return f"dedt/v1|chain={int(chain_id)}|{role}={address.lower()}|epoch={epoch}"


def identity_point(identity: str):
    return hash_to_g1(DST_ID, keccak(identity.encode()))


def _h3(sigma: bytes, identity: str) -> int:
    r = int.from_bytes(keccak(b"DeDT-IBE/H3" + sigma + identity.encode()), "big") % Q
    return r or 1


def _h2(g) -> bytes:
    return keccak(b"DeDT-IBE/H2" + gt_bytes(g))


def _h4(sigma: bytes, u_bytes: bytes, v: bytes) -> bytes:
    return keccak(b"DeDT-IBE/H4" + sigma + u_bytes + v)


def _u_bytes(u) -> bytes:
    return b"".join(c.to_bytes(32, "big") for c in g2_to_ints(u))


def _xor(a: bytes, b: bytes) -> bytes:
    return bytes(x ^ y for x, y in zip(a, b))


# ------------------------------------------------------------------ keys


@dataclass(frozen=True)
class MasterKey:
    """Single-authority master key. Used as the reference; production uses dkg.KeyServerNetwork."""

    s: int

    @classmethod
    def generate(cls, rng=None) -> "MasterKey":
        return cls(random_scalar(rng))

    @property
    def public(self):
        return multiply(G2, self.s)

    def extract(self, identity: str):
        return multiply(identity_point(identity), self.s)


def verify_private_key(master_public, identity: str, d_id) -> bool:
    """e(d_ID, g2) == e(Q_ID, P_pub): a team can check the key it received before using it."""
    return pairing(G2, d_id) == pairing(master_public, identity_point(identity))


# ------------------------------------------------------------------ KEM


@dataclass(frozen=True)
class Encapsulation:
    u: tuple  # G2 point
    v: bytes  # 32 bytes

    def to_bytes(self) -> bytes:
        return _u_bytes(self.u) + self.v

    @classmethod
    def from_bytes(cls, data: bytes) -> "Encapsulation":
        if len(data) != 160:
            raise ValueError("encapsulation must be 160 bytes")
        ints = [int.from_bytes(data[i : i + 32], "big") for i in range(0, 128, 32)]
        return cls(g2_from_ints(ints), data[128:])


def encapsulate(master_public, identity: str, sigma: bytes | None = None) -> tuple[bytes, Encapsulation]:
    sigma = sigma or os.urandom(32)
    r = _h3(sigma, identity)
    u = multiply(G2, r)
    g = pairing(master_public, multiply(identity_point(identity), r))
    v = _xor(sigma, _h2(g))
    return _h4(sigma, _u_bytes(u), v), Encapsulation(u, v)


def decapsulate(d_id, identity: str, enc: Encapsulation) -> bytes:
    sigma = _xor(enc.v, _h2(pairing(enc.u, d_id)))
    r = _h3(sigma, identity)
    if not eq(multiply(G2, r), enc.u):
        raise ValueError("invalid encapsulation")  # FO check: wrong key, wrong identity or tampering
    return _h4(sigma, _u_bytes(enc.u), enc.v)


# ------------------------------------------------------------------ hybrid encryption


def encrypt(master_public, identity: str, plaintext: bytes, aad: bytes = b"") -> bytes:
    """Ciphertext = U (128 B) || V (32 B) || nonce (12 B) || AES-256-GCM(plaintext) with tag (16 B)."""
    key, enc = encapsulate(master_public, identity)
    head = enc.to_bytes()
    nonce = os.urandom(12)
    return head + nonce + AESGCM(key).encrypt(nonce, plaintext, head + identity.encode() + aad)


def decrypt(d_id, identity: str, ciphertext: bytes, aad: bytes = b"") -> bytes:
    head, nonce, body = ciphertext[:160], ciphertext[160:172], ciphertext[172:]
    key = decapsulate(d_id, identity, Encapsulation.from_bytes(head))
    return AESGCM(key).decrypt(nonce, body, head + identity.encode() + aad)


OVERHEAD_BYTES = 160 + 12 + 16

__all__ = [
    "MasterKey", "Encapsulation", "team_identity", "identity_point", "verify_private_key",
    "encapsulate", "decapsulate", "encrypt", "decrypt", "OVERHEAD_BYTES", "g1_to_ints", "g1_from_ints",
]

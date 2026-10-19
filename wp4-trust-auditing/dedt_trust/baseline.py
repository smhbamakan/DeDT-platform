"""Conventional public-key baseline for the IBE evaluation (D4.2).

ECIES on secp256k1 — the curve of the teams' Ethereum keys — with ephemeral-static ECDH,
HKDF-SHA256 and AES-256-GCM (SEC 1 v2 / ISO 18033-2 style). Unlike IBE, the sender must first
obtain the recipient's *authentic public key* (from a certificate, a key directory or a past
signed transaction), and revoking a key requires a revocation list or a directory update.
"""
from __future__ import annotations

import os

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

CURVE = ec.SECP256K1()
_PT = serialization.Encoding.X962
_FMT = serialization.PublicFormat.CompressedPoint


def generate_keypair():
    sk = ec.generate_private_key(CURVE)
    return sk, sk.public_key()


def _pub_bytes(pk) -> bytes:
    return pk.public_bytes(_PT, _FMT)


def _kdf(shared: bytes, eph: bytes, rcpt: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"DeDT-ECIES/v1" + eph + rcpt).derive(shared)


def encrypt(recipient_pk, plaintext: bytes, aad: bytes = b"") -> bytes:
    """Ciphertext = ephemeral key (33 B) || nonce (12 B) || AES-256-GCM(plaintext) with tag (16 B)."""
    eph_sk = ec.generate_private_key(CURVE)
    eph = _pub_bytes(eph_sk.public_key())
    key = _kdf(eph_sk.exchange(ec.ECDH(), recipient_pk), eph, _pub_bytes(recipient_pk))
    nonce = os.urandom(12)
    return eph + nonce + AESGCM(key).encrypt(nonce, plaintext, eph + aad)


def decrypt(recipient_sk, ciphertext: bytes, aad: bytes = b"") -> bytes:
    eph, nonce, body = ciphertext[:33], ciphertext[33:45], ciphertext[45:]
    eph_pk = ec.EllipticCurvePublicKey.from_encoded_point(CURVE, eph)
    key = _kdf(recipient_sk.exchange(ec.ECDH(), eph_pk), eph, _pub_bytes(recipient_sk.public_key()))
    return AESGCM(key).decrypt(nonce, body, eph + aad)


OVERHEAD_BYTES = 33 + 12 + 16

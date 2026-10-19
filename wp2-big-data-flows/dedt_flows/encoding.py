"""Hashing and canonical encoding shared with the Solidity `DataAnchor` contract.

A sensor reading is encoded exactly like Solidity's `abi.encode(bytes32 twin, bytes32 sensor,
uint64 seq, uint64 tEventMs, int256 valueMicro)`: five 32-byte big-endian words. Values are fixed
point with six decimals (micro-units), so the encoding is exact and identical on both sides.
"""
from __future__ import annotations

from Crypto.Hash import keccak

VALUE_SCALE = 1_000_000  # six decimals


def keccak256(data: bytes) -> bytes:
    h = keccak.new(digest_bits=256)
    h.update(data)
    return h.digest()


def name_id(name: str) -> bytes:
    """bytes32 identifier of a twin or sensor name (keccak256 of its UTF-8 bytes)."""
    return keccak256(name.encode("utf-8"))


def uint_word(x: int) -> bytes:
    if x < 0 or x >= 1 << 256:
        raise ValueError("uint out of range")
    return x.to_bytes(32, "big")


def int_word(x: int) -> bytes:
    if not -(1 << 255) <= x < 1 << 255:
        raise ValueError("int out of range")
    return (x % (1 << 256)).to_bytes(32, "big")


def to_micro(value: float) -> int:
    return round(value * VALUE_SCALE)


def encode_reading(twin: bytes, sensor: bytes, seq: int, t_event_ms: int, value_micro: int) -> bytes:
    if len(twin) != 32 or len(sensor) != 32:
        raise ValueError("twin and sensor ids must be 32 bytes")
    return twin + sensor + uint_word(seq) + uint_word(t_event_ms) + int_word(value_micro)


def leaf_hash(encoded: bytes) -> bytes:
    """OpenZeppelin StandardMerkleTree leaf: keccak256(bytes.concat(keccak256(abi.encode(...))))."""
    return keccak256(keccak256(encoded))

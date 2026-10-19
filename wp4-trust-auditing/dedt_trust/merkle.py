"""Merkle tree compatible with OpenZeppelin MerkleProof (sorted pairs, double-hashed leaves), as in WP2."""
from __future__ import annotations

from .bn254 import keccak, word


def leaf(record_hash: bytes) -> bytes:
    """leaf = keccak(keccak(abi.encode(bytes32 recordHash))) — the second hash prevents
    second-preimage attacks that pass an inner node off as a leaf."""
    return keccak(keccak(word(record_hash)))


def _pair(a: bytes, b: bytes) -> bytes:
    return keccak(a + b if a < b else b + a)


def build(leaves: list[bytes]) -> list[list[bytes]]:
    if not leaves:
        raise ValueError("empty tree")
    levels = [list(leaves)]
    while len(levels[-1]) > 1:
        cur = levels[-1]
        nxt = [_pair(cur[i], cur[i + 1]) for i in range(0, len(cur) - 1, 2)]
        if len(cur) % 2:
            nxt.append(cur[-1])  # odd node is promoted unchanged
        levels.append(nxt)
    return levels


def root(levels) -> bytes:
    return levels[-1][0]


def proof(levels, index: int) -> list[bytes]:
    out = []
    for level in levels[:-1]:
        sib = index ^ 1
        if sib < len(level):
            out.append(level[sib])
        index //= 2
    return out


def verify(proof_: list[bytes], root_: bytes, leaf_: bytes) -> bool:
    h = leaf_
    for p in proof_:
        h = _pair(h, p)
    return h == root_

"""Merkle tree compatible with OpenZeppelin `MerkleProof.verify` (commutative keccak256 pairs).

Internal nodes hash the sorted pair H(min(a, b) || max(a, b)), so a proof is just the list of
siblings; an unpaired node at the end of a level is promoted unchanged. Proof length is
ceil(log2 n) hashes, i.e. 32 * ceil(log2 n) bytes.
"""
from __future__ import annotations

from dataclasses import dataclass

from .encoding import keccak256


def hash_pair(a: bytes, b: bytes) -> bytes:
    return keccak256(a + b) if a < b else keccak256(b + a)


@dataclass
class MerkleTree:
    levels: list[list[bytes]]  # levels[0] = leaves, levels[-1] = [root]

    @classmethod
    def build(cls, leaves: list[bytes]) -> "MerkleTree":
        if not leaves:
            raise ValueError("a Merkle tree needs at least one leaf")
        levels = [list(leaves)]
        while len(levels[-1]) > 1:
            cur = levels[-1]
            nxt = [hash_pair(cur[i], cur[i + 1]) for i in range(0, len(cur) - 1, 2)]
            if len(cur) % 2:
                nxt.append(cur[-1])
            levels.append(nxt)
        return cls(levels)

    @property
    def root(self) -> bytes:
        return self.levels[-1][0]

    def proof(self, index: int) -> list[bytes]:
        if not 0 <= index < len(self.levels[0]):
            raise IndexError(index)
        out = []
        for level in self.levels[:-1]:
            sibling = index ^ 1
            if sibling < len(level):
                out.append(level[sibling])
            index //= 2
        return out


def verify(proof: list[bytes], root: bytes, leaf: bytes) -> bool:
    node = leaf
    for sibling in proof:
        node = hash_pair(node, sibling)
    return node == root

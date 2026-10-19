"""Integrity of twin data flows with Merkle batching and a hash chain (proposal T2.2).

The edge node seals the readings it *received* into batches (by count or by time, whichever comes
first). For each batch it computes

  root_k  = Merkle root over the leaves H(H(abi.encode(reading))), sorted for determinism
  chain_k = H(abi.encode(chain_{k-1}, root_k, summaryHash_k, k, count_k, start_k, end_k))

and anchors (root_k, summaryHash_k, …) on-chain with `DataAnchor.anchor`, which recomputes chain_k.
Anyone holding the raw log can later recompute every root and the chain; a single reading can be
proven with ~log2(n) hashes against the anchored root, on- or off-chain.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field

from .encoding import keccak256, leaf_hash, name_id, uint_word
from .merkle import MerkleTree, verify
from .simulator import Reading

ZERO = bytes(32)


@dataclass
class Batch:
    index: int
    start_ms: int  # first arrival
    end_ms: int  # last arrival
    readings: list[Reading]
    root: bytes
    summary_hash: bytes
    prev_chain: bytes
    chain: bytes
    tree: MerkleTree = field(repr=False)
    order: list[int] = field(repr=False)  # leaf position of each reading

    @property
    def count(self) -> int:
        return len(self.readings)

    def proof(self, i: int) -> list[bytes]:
        """Merkle proof for self.readings[i]."""
        return self.tree.proof(self.order[i])

    def to_anchor(self, twin: str) -> dict:
        return {
            "twinId": "0x" + name_id(twin).hex(),
            "index": self.index,
            "merkleRoot": "0x" + self.root.hex(),
            "summaryHash": "0x" + self.summary_hash.hex(),
            "count": self.count,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
            "chain": "0x" + self.chain.hex(),
        }


def chain_hash(prev: bytes, root: bytes, summary_hash: bytes, index: int, count: int, start: int, end: int) -> bytes:
    return keccak256(prev + root + summary_hash + uint_word(index) + uint_word(count) + uint_word(start) + uint_word(end))


def seal(index: int, readings: list[Reading], summaries: list, prev_chain: bytes) -> Batch:
    leaves = [leaf_hash(r.encode()) for r in readings]
    order_sorted = sorted(range(len(leaves)), key=lambda i: leaves[i])
    position = {i: p for p, i in enumerate(order_sorted)}
    tree = MerkleTree.build([leaves[i] for i in order_sorted])
    summary_hash = keccak256(json.dumps([asdict(s) for s in summaries], sort_keys=True, default=str).encode()) if summaries else ZERO
    start, end = readings[0].t_arrival_ms, readings[-1].t_arrival_ms
    chain = chain_hash(prev_chain, tree.root, summary_hash, index, len(readings), start, end)
    return Batch(index, start, end, list(readings), tree.root, summary_hash, prev_chain, chain, tree, [position[i] for i in range(len(readings))])


class BatchBuilder:
    """Seals received readings into batches of at most `max_readings` or `max_interval_ms`."""

    def __init__(self, max_readings: int = 1024, max_interval_ms: int = 1000):
        self.max_readings = max_readings
        self.max_interval_ms = max_interval_ms
        self.batches: list[Batch] = []
        self._pending: list[Reading] = []
        self._summaries: list = []
        self._head = ZERO

    def add(self, r: Reading, summaries: list | None = None) -> Batch | None:
        self._pending.append(r)
        self._summaries.extend(summaries or [])
        full = len(self._pending) >= self.max_readings
        old = r.t_arrival_ms - self._pending[0].t_arrival_ms >= self.max_interval_ms
        return self._seal() if full or old else None

    def flush(self, summaries: list | None = None) -> Batch | None:
        self._summaries.extend(summaries or [])
        return self._seal() if self._pending else None

    def _seal(self) -> Batch:
        b = seal(len(self.batches), self._pending, self._summaries, self._head)
        self.batches.append(b)
        self._head = b.chain
        self._pending, self._summaries = [], []
        return b


@dataclass
class AuditResult:
    ok: bool
    chain_ok: bool
    bad_batches: list[int]


def audit(log: list[list[Reading]], anchored: list[dict]) -> AuditResult:
    """Recompute every batch root and the hash chain from a stored raw log and compare them with
    the anchored records. Returns the indices of batches whose content no longer matches."""
    bad = []
    prev = ZERO
    chain_ok = len(log) == len(anchored)
    for k, (readings, a) in enumerate(zip(log, anchored)):
        root = MerkleTree.build(sorted(leaf_hash(r.encode()) for r in readings)).root if readings else ZERO
        if "0x" + root.hex() != a["merkleRoot"] or len(readings) != a["count"]:
            bad.append(k)
        summary = bytes.fromhex(a["summaryHash"][2:])
        chain = chain_hash(prev, bytes.fromhex(a["merkleRoot"][2:]), summary, a["index"], a["count"], a["startMs"], a["endMs"])
        if "0x" + chain.hex() != a["chain"]:
            chain_ok = False
        prev = chain
    return AuditResult(ok=not bad and chain_ok, chain_ok=chain_ok, bad_batches=bad)


def verify_reading(r: Reading, proof: list[bytes], root: bytes) -> bool:
    return verify(proof, root, leaf_hash(r.encode()))

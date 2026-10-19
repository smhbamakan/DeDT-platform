import random

import pytest

from dedt_flows.encoding import encode_reading, int_word, keccak256, leaf_hash, name_id, to_micro
from dedt_flows.merkle import MerkleTree, hash_pair, verify


def leaves(n, seed=0):
    rng = random.Random(seed)
    return [keccak256(rng.randbytes(32)) for _ in range(n)]


def test_keccak_known_vector():
    # keccak256 of the empty string, as used by Ethereum
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"


def test_abi_encoding_of_negative_values_is_twos_complement():
    assert int_word(-1) == b"\xff" * 32
    assert to_micro(-1.5) == -1_500_000
    enc = encode_reading(name_id("t"), name_id("s"), 3, 1000, -1)
    assert len(enc) == 160 and enc[-32:] == b"\xff" * 32


def test_pairs_are_commutative():
    a, b = leaves(2)
    assert hash_pair(a, b) == hash_pair(b, a)


@pytest.mark.parametrize("n", [1, 2, 3, 5, 8, 13, 64, 1000])
def test_every_leaf_has_a_valid_proof(n):
    ls = leaves(n, n)
    t = MerkleTree.build(ls)
    for i, leaf in enumerate(ls):
        p = t.proof(i)
        assert verify(p, t.root, leaf)
        assert len(p) <= max(1, (n - 1).bit_length())


def test_proofs_reject_wrong_leaf_or_root():
    ls = leaves(16)
    t = MerkleTree.build(ls)
    p = t.proof(5)
    assert not verify(p, t.root, ls[6])
    assert not verify(p, keccak256(b"other"), ls[5])
    assert not verify(p[:-1], t.root, ls[5])


def test_single_leaf_tree_and_errors():
    (leaf,) = leaves(1)
    t = MerkleTree.build([leaf])
    assert t.root == leaf and t.proof(0) == []
    with pytest.raises(ValueError):
        MerkleTree.build([])
    with pytest.raises(IndexError):
        t.proof(1)


def test_leaf_is_double_hashed():
    enc = encode_reading(name_id("t"), name_id("s"), 0, 0, 0)
    assert leaf_hash(enc) == keccak256(keccak256(enc))

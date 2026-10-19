"""Unit tests of the WP4 cryptography (IBE, DKG, BLS, ZKP, Merkle, encodings)."""
import random

import pytest

from dedt_trust import baseline, bls, dkg, ibe, merkle, zkp
from dedt_trust.bn254 import (
    G1, G2, P, Q, add, eq, g1_from_ints, g1_to_ints, g2_from_ints, g2_to_ints, hash_to_g1, keccak,
    lagrange_at_zero, multiply, neg,
)

ALICE = ibe.team_identity(1001, "0x" + "a1" * 20, "2026-10")
BOB = ibe.team_identity(2002, "0x" + "b2" * 20, "2026-10")


@pytest.fixture(scope="module")
def net():
    return dkg.KeyServerNetwork.setup(5, 3, random.Random(1))


# ------------------------------------------------------------------ BN254 layer


def test_hash_to_g1_is_on_curve_and_deterministic():
    for i in range(5):
        x, y = g1_to_ints(hash_to_g1(b"\x01" * 32, i.to_bytes(32, "big")))
        assert (y * y - x**3 - 3) % P == 0
    assert g1_to_ints(hash_to_g1(b"\x01" * 32, b"\x00" * 32)) == g1_to_ints(hash_to_g1(b"\x01" * 32, b"\x00" * 32))


def test_point_encodings_round_trip_and_validate():
    p1 = multiply(G1, 12345)
    assert eq(g1_from_ints(g1_to_ints(p1)), p1)
    p2 = multiply(G2, 6789)
    assert eq(g2_from_ints(g2_to_ints(p2)), p2)
    with pytest.raises(ValueError):
        g1_from_ints([1, 3])
    bad = g2_to_ints(p2)
    bad[3] = (bad[3] + 1) % P
    with pytest.raises(ValueError):
        g2_from_ints(bad)


def test_lagrange_interpolates_the_constant_term():
    f = lambda x: (7 + 3 * x + 5 * x * x) % Q  # noqa: E731
    for idx in ([1, 2, 3], [2, 4, 5], [1, 3, 5]):
        assert sum(l * f(i) for l, i in zip(lagrange_at_zero(idx), idx)) % Q == 7


# ------------------------------------------------------------------ IBE


def test_ibe_round_trip_and_key_check():
    mk = ibe.MasterKey.generate(random.Random(2))
    d = mk.extract(BOB)
    assert ibe.verify_private_key(mk.public, BOB, d)
    assert not ibe.verify_private_key(mk.public, ALICE, d)
    ct = ibe.encrypt(mk.public, BOB, b"twin package v3", aad=b"twin#1")
    assert len(ct) == len(b"twin package v3") + ibe.OVERHEAD_BYTES
    assert ibe.decrypt(d, BOB, ct, aad=b"twin#1") == b"twin package v3"


def test_ibe_rejects_wrong_key_identity_epoch_and_tampering():
    mk = ibe.MasterKey.generate(random.Random(3))
    ct = ibe.encrypt(mk.public, BOB, b"secret", aad=b"a")
    with pytest.raises(ValueError):
        ibe.decrypt(mk.extract(ALICE), BOB, ct, aad=b"a")  # another team's key
    old = ibe.team_identity(2002, "0x" + "b2" * 20, "2026-09")
    with pytest.raises(ValueError):
        ibe.decrypt(mk.extract(old), BOB, ct, aad=b"a")  # expired epoch key
    with pytest.raises(Exception):
        ibe.decrypt(mk.extract(BOB), BOB, ct, aad=b"b")  # different associated data
    for pos in (130, 165, len(ct) - 1):  # V, nonce, tag/body
        t = bytearray(ct)
        t[pos] ^= 1
        with pytest.raises(Exception):
            ibe.decrypt(mk.extract(BOB), BOB, bytes(t), aad=b"a")


def test_encapsulation_is_fo_checked():
    mk = ibe.MasterKey.generate(random.Random(4))
    key, enc = ibe.encapsulate(mk.public, BOB)
    assert ibe.decapsulate(mk.extract(BOB), BOB, ibe.Encapsulation.from_bytes(enc.to_bytes())) == key
    mauled = ibe.Encapsulation(multiply(enc.u, 2), enc.v)
    with pytest.raises(ValueError):
        ibe.decapsulate(mk.extract(BOB), BOB, mauled)


# ------------------------------------------------------------------ DKG and threshold extraction


def test_any_t_servers_issue_the_same_valid_key(net, monkeypatch):
    keys = [dkg.obtain_key(net, BOB, ids) for ids in ([1, 2, 3], [2, 4, 5], [5, 3, 1])]
    assert all(eq(keys[0], k) for k in keys[1:])
    assert ibe.verify_private_key(net.master_public, BOB, keys[0])
    ct = ibe.encrypt(net.master_public, BOB, b"hello from team 1")
    assert ibe.decrypt(keys[1], BOB, ct) == b"hello from team 1"


def test_fewer_than_t_servers_cannot_issue_a_key(net):
    with pytest.raises(RuntimeError):
        dkg.obtain_key(net, BOB, [1, 2])
    partial = dkg.combine({1: net.server(1).extract_partial(BOB), 2: net.server(2).extract_partial(BOB)})
    assert not ibe.verify_private_key(net.master_public, BOB, partial)


def test_a_cheating_server_is_detected_and_skipped(net, monkeypatch):
    honest = net.server(2).extract_partial
    monkeypatch.setattr(net.server(2), "extract_partial", lambda identity, credential=None: add(honest(identity), G1))
    assert not dkg.verify_partial(net, 2, BOB, net.server(2).extract_partial(BOB))
    d = dkg.obtain_key(net, BOB, [1, 2, 3, 4])  # 2 is rejected, 1, 3, 4 used
    assert ibe.verify_private_key(net.master_public, BOB, d)


def test_servers_enforce_their_issuing_policy(net, monkeypatch):
    for j in (1, 2):
        monkeypatch.setattr(net.server(j), "policy", lambda identity, credential: credential == "member")
    with pytest.raises(PermissionError):
        net.server(1).extract_partial(BOB, "stranger")
    with pytest.raises(RuntimeError):
        dkg.obtain_key(net, BOB, [1, 2, 3, 4], credential="stranger")  # only 3 and 4 answer
    assert dkg.obtain_key(net, BOB, [1, 2, 3], credential="member")


def test_dkg_disqualifies_a_dealer_with_a_wrong_share():
    net = dkg.KeyServerNetwork.setup(4, 2, random.Random(5), corrupt_dealers={3})
    assert net.qualified == [1, 2, 4]
    d = dkg.obtain_key(net, ALICE, [3, 4])
    assert ibe.verify_private_key(net.master_public, ALICE, d)
    with pytest.raises(ValueError):
        dkg.KeyServerNetwork.setup(2, 3)


# ------------------------------------------------------------------ baseline


def test_ecies_baseline_round_trip():
    sk, pk = baseline.generate_keypair()
    ct = baseline.encrypt(pk, b"payload", b"aad")
    assert len(ct) == 7 + baseline.OVERHEAD_BYTES
    assert baseline.decrypt(sk, ct, b"aad") == b"payload"
    with pytest.raises(Exception):
        baseline.decrypt(baseline.generate_keypair()[0], ct, b"aad")


# ------------------------------------------------------------------ BLS


MSG = bls.batch_message(31337, "0x" + "11" * 20, 1, 0, keccak(b"root"))


def test_bls_multisignature_and_pop():
    signers = [bls.Signer.from_seed(f"s{i}") for i in range(4)]
    assert all(bls.verify_pop(s.pk1, s.pk2, s.proof_of_possession()) for s in signers)
    ms = bls.multisign(signers[:3], MSG)
    assert bls.verify_dual(ms["sig"], ms["apk1"], ms["apk2"], MSG)
    other = bls.batch_message(31337, "0x" + "11" * 20, 1, 1, keccak(b"root"))
    assert not bls.verify_dual(ms["sig"], ms["apk1"], ms["apk2"], other)
    # inconsistent G2 aggregate (signer set differs) is caught by the dual check
    assert not bls.verify_dual(ms["sig"], ms["apk1"], bls.multisign(signers[1:], MSG)["apk2"], MSG)
    # a signature is not a proof of possession and vice versa (separate hash domains)
    s = signers[0]
    assert not bls.verify_pop(s.pk1, s.pk2, s.sign(bls.pop_message(s.pk1)))


def test_proof_of_possession_blocks_the_rogue_key_attack():
    honest = bls.Signer.from_seed("honest")
    x = 987654321
    rogue1 = add(multiply(G1, x), neg(honest.pk1))  # attacker cancels the honest key
    rogue2 = add(multiply(G2, x), neg(honest.pk2))
    forged = multiply(hash_to_g1(bls.DST_SIG, MSG), x)  # honest signer never signed
    apk1, apk2 = add(honest.pk1, rogue1), add(honest.pk2, rogue2)
    assert bls.verify_dual(forged, apk1, apk2, MSG)  # without PoP the forgery would pass
    # but the attacker cannot sign with the rogue key, so it cannot pass registration
    fake_pop = multiply(hash_to_g1(bls.DST_POP, bls.pop_message(rogue1)), x)
    assert not bls.verify_pop(rogue1, rogue2, fake_pop)


# ------------------------------------------------------------------ ZKP


CERT = [zkp.attribute(v) for v in ["wind-turbine/V2", "ACME", "SN-1", 20260115, b"spec", b"state"]]
CTX = {"chain_id": 31337, "contract": "0x" + "22" * 20, "token_id": 7, "prover": "0x" + "33" * 20}


def test_commitments_hide_the_certificate():
    assert not eq(zkp.commit(CERT, 1), zkp.commit(CERT, 2))
    gs, h = zkp.generators(6)
    pts = [g1_to_ints(g) for g in gs + [h]]
    assert len({tuple(p) for p in pts}) == 7


@pytest.mark.parametrize("mask", [0, 0b000001, 0b001010, 0b111110, 0b111111])
def test_certificate_proofs_with_selective_disclosure(mask):
    rng = random.Random(mask)
    r = 424242
    c = zkp.commit(CERT, r)
    p = zkp.prove_certificate(CERT, r, mask, CTX, rng)
    assert p.disclosed == [CERT[j] for j in range(6) if mask >> j & 1]
    assert zkp.verify_certificate(c, 6, p, CTX)
    for k, v in [("prover", "0x" + "44" * 20), ("token_id", 8), ("contract", "0x" + "55" * 20), ("chain_id", 1)]:
        assert not zkp.verify_certificate(c, 6, p, {**CTX, k: v})


def test_certificate_proof_rejects_lies_and_ignorance():
    r = 99
    c = zkp.commit(CERT, r)
    p = zkp.prove_certificate(CERT, r, 0b1000, CTX)
    p.disclosed = [20200101]
    assert not zkp.verify_certificate(c, 6, p, CTX)
    assert not zkp.verify_certificate(c, 6, zkp.prove_certificate(CERT, r + 1, 0, CTX), CTX)
    assert not zkp.verify_certificate(c, 6, zkp.prove_certificate(CERT, r, 1 << 6, CTX), CTX)


def test_rotation_proves_same_attributes_and_locks_out_the_seller():
    r = 5
    c_old = zkp.commit(CERT, r)
    r_new, c_new, proof = zkp.rotate(CERT, r, CTX)
    assert eq(c_new, zkp.commit(CERT, r_new))
    assert zkp.verify_rotation(c_old, c_new, proof, CTX, 6)
    assert not zkp.verify_rotation(c_old, c_new, proof, {**CTX, "prover": "0x" + "44" * 20}, 6)
    other = zkp.commit([CERT[0] + 1] + CERT[1:], r_new)  # different attributes
    assert not zkp.verify_rotation(c_old, other, proof, CTX, 6)
    assert not zkp.verify_certificate(c_new, 6, zkp.prove_certificate(CERT, r, 0, CTX), CTX)


# ------------------------------------------------------------------ Merkle


@pytest.mark.parametrize("n", [1, 2, 3, 5, 8, 9])
def test_merkle_proofs(n):
    leaves = [merkle.leaf(keccak(bytes([i]))) for i in range(n)]
    levels = merkle.build(leaves)
    for i in range(n):
        assert merkle.verify(merkle.proof(levels, i), merkle.root(levels), leaves[i])
    if n > 1:
        assert not merkle.verify(merkle.proof(levels, 0), merkle.root(levels), leaves[1 % n] if n > 2 else merkle.leaf(b"\x00" * 32))

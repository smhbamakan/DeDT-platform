"""Distributed key generation and threshold key extraction for IBE (T4.1, T4.4).

Plain IBE has a private-key generator (PKG) that knows every team's key — a central authority,
which DeDT rules out (D1.1, NFR-SEC-01). As suggested by Boneh and Franklin themselves, the
master key s is shared among n key servers with Shamir's scheme so that any t servers can issue
a key and no t-1 servers learn anything about s.

The sharing is generated without a dealer by Joint-Feldman DKG (Pedersen 1991):
  1. every server i picks f_i(z) = a_i0 + a_i1 z + ... + a_i,t-1 z^(t-1) and publishes the
     commitments A_ik = a_ik·g2;
  2. it sends s_ij = f_i(j) privately to server j, who checks  s_ij·g2 = Σ_k j^k·A_ik
     (Feldman verification) and complains otherwise; a dealer with a valid complaint is
     disqualified;
  3. s = Σ_{i∈QUAL} a_i0 is never assembled; server j keeps s_j = Σ_i s_ij and the public share
     S_j = s_j·g2 can be computed by anyone from the commitments; P_pub = Σ_i A_i0.

Extraction: server j returns d_j = s_j·Q_ID. The team verifies e(d_j, g2) = e(Q_ID, S_j) and
combines any t valid partial keys: d_ID = Σ λ_j d_j = s·Q_ID (Lagrange interpolation at 0).

Known limitation: a rushing adversary can bias the distribution of P_pub in Joint-Feldman
(Gennaro, Jarecki, Krawczyk and Rabin, 1999/2007). For IBE this does not help it to decrypt,
but the README discusses the Pedersen-VSS-based alternative.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from .bn254 import G2, Q, Z2, add, eq, g1_sum, g2_sum, lagrange_at_zero, multiply, pairing, random_scalar
from .ibe import identity_point


def _eval(coeffs: list[int], x: int) -> int:
    acc = 0
    for c in reversed(coeffs):
        acc = (acc * x + c) % Q
    return acc


def _commitment_eval(commitments: list, j: int):
    """Σ_k j^k·A_k in G2 (Horner)."""
    acc = Z2
    for a in reversed(commitments):
        acc = add(multiply(acc, j), a)
    return acc


@dataclass
class Dealing:
    dealer: int
    commitments: list  # A_i0..A_i,t-1 in G2 (public)
    shares: dict[int, int]  # j -> f_i(j) (sent privately to j)


@dataclass
class KeyServer:
    index: int  # 1..n (the Shamir x-coordinate)
    secret_share: int = 0
    received: dict[int, int] = field(default_factory=dict)
    complaints: set[int] = field(default_factory=set)
    # who may obtain which identity key; in a deployment: an EIP-191 signature by the team's
    # address plus a check of its membership in the DAO (D1.2)
    policy: Callable[[str, object], bool] = lambda identity, credential: True

    def deal(self, n: int, t: int, rng=None) -> Dealing:
        coeffs = [random_scalar(rng) for _ in range(t)]
        return Dealing(self.index, [multiply(G2, a) for a in coeffs], {j: _eval(coeffs, j) for j in range(1, n + 1)})

    def receive(self, d: Dealing) -> bool:
        s = d.shares[self.index]
        ok = eq(multiply(G2, s), _commitment_eval(d.commitments, self.index))
        if ok:
            self.received[d.dealer] = s
        else:
            self.complaints.add(d.dealer)
        return ok

    def extract_partial(self, identity: str, credential=None):
        if not self.policy(identity, credential):
            raise PermissionError(f"server {self.index} refuses to issue a key for {identity}")
        return multiply(identity_point(identity), self.secret_share)


@dataclass
class KeyServerNetwork:
    n: int
    t: int
    servers: list[KeyServer]
    qualified: list[int]
    master_public: tuple
    public_shares: dict[int, tuple]  # j -> S_j = s_j·g2

    @classmethod
    def setup(cls, n: int, t: int, rng=None, corrupt_dealers: set[int] = frozenset()) -> "KeyServerNetwork":
        """Run Joint-Feldman DKG. `corrupt_dealers` send one wrong share (used in tests)."""
        if not 1 <= t <= n:
            raise ValueError("need 1 <= t <= n")
        servers = [KeyServer(i) for i in range(1, n + 1)]
        dealings = [s.deal(n, t, rng) for s in servers]
        for d in dealings:
            if d.dealer in corrupt_dealers:
                victim = 1 if d.dealer != 1 else 2
                d.shares[victim] = (d.shares[victim] + 1) % Q
        for s in servers:
            for d in dealings:
                s.receive(d)
        # complaints are broadcast; a dealer with any valid complaint is disqualified
        disqualified = set().union(*(s.complaints for s in servers))
        qual = [d.dealer for d in dealings if d.dealer not in disqualified]
        if len(qual) < t:
            raise RuntimeError("too few qualified dealers")
        for s in servers:
            s.secret_share = sum(s.received[i] for i in qual) % Q
        comm = {d.dealer: d.commitments for d in dealings}
        master_public = g2_sum(comm[i][0] for i in qual)
        public_shares = {s.index: g2_sum(_commitment_eval(comm[i], s.index) for i in qual) for s in servers}
        return cls(n, t, servers, qual, master_public, public_shares)

    def server(self, j: int) -> KeyServer:
        return self.servers[j - 1]


def verify_partial(net: KeyServerNetwork, j: int, identity: str, d_j) -> bool:
    return pairing(G2, d_j) == pairing(net.public_shares[j], identity_point(identity))


def combine(partials: dict[int, object]):
    """Lagrange-combine t verified partial keys {j: d_j} into d_ID."""
    idx = sorted(partials)
    lams = lagrange_at_zero(idx)
    return g1_sum(multiply(partials[j], lam) for j, lam in zip(idx, lams))


def obtain_key(net: KeyServerNetwork, identity: str, server_ids: list[int], credential=None, verify: bool = True):
    """What a team does: ask servers, keep the first t partial keys that verify, combine them."""
    good = {}
    for j in server_ids:
        try:
            d_j = net.server(j).extract_partial(identity, credential)
        except PermissionError:
            continue
        if not verify or verify_partial(net, j, identity, d_j):
            good[j] = d_j
        if len(good) == net.t:
            return combine(good)
    raise RuntimeError(f"only {len(good)} valid partial keys, {net.t} needed")

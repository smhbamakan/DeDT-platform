"""dedt_trust — trust and auditing for decentralised digital twin collaboration (DeDT WP4).

Modules
  bn254     curve, hashing and encodings shared with the Solidity contracts
  ibe       Boneh–Franklin identity-based encryption (FullIdent KEM + AES-256-GCM)       T4.1
  dkg       distributed key generation and t-of-n key extraction (no central PKG)       T4.1, T4.4
  baseline  ECIES on secp256k1, the conventional comparison for D4.2
  bls       BLS multi-signatures with on-chain-friendly dual-key verification            T4.2
  merkle    OpenZeppelin-compatible Merkle trees (as in WP2)                             T4.2
  zkp       commitments and zero-knowledge proofs for twin birth certificates            T4.3
  cli       JSON interface used by the Hardhat tests
  demo      end-to-end scenario across two teams                                         T4.4
"""
__version__ = "0.1.0"

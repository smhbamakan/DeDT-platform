// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {BN254} from "./BN254.sol";

/// @title BirthCertificateRegistry
/// @notice Zero-knowledge link between a digital twin NFT and the twin's birth certificate (DeDT T4.3).
///
///   The owner of a twin NFT registers a Pedersen commitment C = Σ m_j·G_j + r·H to the
///   attributes of the twin's birth certificate. Later the holder proves — without revealing
///   the hidden attributes — that it knows the certificate behind the NFT, optionally disclosing
///   chosen attributes (selective disclosure). When the NFT changes hands, the new owner rotates
///   the commitment to fresh randomness, so the previous owner can no longer produce proofs.
///   All proofs are Schnorr/Okamoto Σ-protocols with Fiat–Shamir challenges bound to the chain,
///   this contract, the token and the prover, verified with the BN254 precompiles only.
/// @dev Mirrors dedt_trust/zkp.py.
contract BirthCertificateRegistry {
    using BN254 for BN254.G1Point;

    bytes32 public constant DST_GEN = keccak256("DeDT-ZK/generator/v1");
    bytes32 public constant PROOF_TAG = keccak256("DeDT-ZK/birth-certificate/v1");
    bytes32 public constant ROTATE_TAG = keccak256("DeDT-ZK/rotate/v1");
    uint256 public constant H_INDEX = 2 ** 32;

    IERC721 public immutable twins;
    uint256 public immutable attributeCount;
    BN254.G1Point[] private _gens;
    BN254.G1Point private _h;

    mapping(uint256 => BN254.G1Point) private _commitment;
    mapping(uint256 => uint64) public commitmentVersion;

    event BirthCertificateRegistered(uint256 indexed tokenId, uint256 cx, uint256 cy);
    event CommitmentRotated(uint256 indexed tokenId, uint64 version, uint256 cx, uint256 cy);
    event CertificateProven(uint256 indexed tokenId, address indexed holder, uint256 mask, uint256[] disclosed);

    error NotTwinOwner();
    error AlreadyRegistered();
    error NotRegistered();
    error InvalidCommitment();
    error InvalidProof();
    error BadAttributeCount();

    struct CertificateProof {
        uint256 mask; // bit j set = attribute j disclosed
        uint256[] disclosed; // disclosed values, in index order
        BN254.G1Point t;
        uint256[] sHidden; // responses for hidden attributes, in index order
        uint256 sR;
    }

    constructor(IERC721 twins_, uint256 k) {
        if (k == 0 || k > 16) revert BadAttributeCount();
        twins = twins_;
        attributeCount = k;
        for (uint256 j; j < k; ++j) {
            _gens.push(BN254.hashToG1(DST_GEN, bytes32(j)));
        }
        _h = BN254.hashToG1(DST_GEN, bytes32(H_INDEX));
    }

    modifier onlyTwinOwner(uint256 tokenId) {
        if (twins.ownerOf(tokenId) != msg.sender) revert NotTwinOwner();
        _;
    }

    // ------------------------------------------------------------------ registration

    function registerBirthCertificate(uint256 tokenId, BN254.G1Point calldata c) external onlyTwinOwner(tokenId) {
        if (commitmentVersion[tokenId] != 0) revert AlreadyRegistered();
        _setCommitment(tokenId, c);
        emit BirthCertificateRegistered(tokenId, c.x, c.y);
    }

    /// @notice New owner re-randomises the commitment: proof of knowledge of Δ with C_old − C_new = Δ·H.
    function rotateCommitment(uint256 tokenId, BN254.G1Point calldata cNew, BN254.G1Point calldata t, uint256 s)
        external
        onlyTwinOwner(tokenId)
    {
        if (commitmentVersion[tokenId] == 0) revert NotRegistered();
        BN254.G1Point memory cOld = _commitment[tokenId];
        if (!cNew.isOnCurve() || !t.isOnCurve()) revert InvalidProof();
        uint256 c = uint256(
            keccak256(
                abi.encode(ROTATE_TAG, block.chainid, address(this), tokenId, msg.sender, cOld.x, cOld.y, cNew.x, cNew.y, t.x, t.y)
            )
        ) % BN254.Q;
        BN254.G1Point memory lhs = _h.mul(s);
        BN254.G1Point memory rhs = t.add(cOld.add(BN254.neg(cNew)).mul(c));
        if (lhs.x != rhs.x || lhs.y != rhs.y) revert InvalidProof();
        _setCommitment(tokenId, cNew);
        emit CommitmentRotated(tokenId, commitmentVersion[tokenId], cNew.x, cNew.y);
    }

    // ------------------------------------------------------------------ proofs

    /// @notice Check a certificate proof made by `prover` (view; anyone can audit).
    function verifyCertificate(uint256 tokenId, address prover, CertificateProof calldata p) public view returns (bool) {
        if (commitmentVersion[tokenId] == 0) return false;
        uint256 k = attributeCount;
        if (p.mask >> k != 0 || !p.t.isOnCurve()) return false;
        uint256 shown = _popcount(p.mask);
        if (p.disclosed.length != shown || p.sHidden.length != k - shown) return false;
        for (uint256 i; i < shown; ++i) {
            if (p.disclosed[i] >= BN254.Q) return false;
        }

        BN254.G1Point memory cmt = _commitment[tokenId];
        uint256 c = _challenge(tokenId, prover, cmt, p);
        (BN254.G1Point memory lhs, BN254.G1Point memory rest) = _combine(cmt, p);
        BN254.G1Point memory rhs = p.t.add(rest.mul(c));
        return lhs.x == rhs.x && lhs.y == rhs.y;
    }

    function _challenge(uint256 tokenId, address prover, BN254.G1Point memory cmt, CertificateProof calldata p)
        private
        view
        returns (uint256)
    {
        bytes32 values = keccak256(abi.encodePacked(p.disclosed));
        return uint256(
            keccak256(
                abi.encode(PROOF_TAG, block.chainid, address(this), tokenId, prover, cmt.x, cmt.y, p.mask, values, p.t.x, p.t.y)
            )
        ) % BN254.Q;
    }

    /// @dev lhs = Σ_{hidden} s_j·G_j + s_r·H ;  rest = C − Σ_{shown} v_j·G_j
    function _combine(BN254.G1Point memory cmt, CertificateProof calldata p)
        private
        view
        returns (BN254.G1Point memory lhs, BN254.G1Point memory rest)
    {
        lhs = _h.mul(p.sR);
        rest = cmt;
        uint256 hi;
        uint256 si;
        for (uint256 j; j < attributeCount; ++j) {
            if (p.mask >> j & 1 == 1) {
                rest = rest.add(BN254.neg(_gens[j].mul(p.disclosed[si++])));
            } else {
                lhs = lhs.add(_gens[j].mul(p.sHidden[hi++]));
            }
        }
    }

    /// @notice The current owner proves that it holds the twin's birth certificate; the disclosed
    ///         attributes are published in the event.
    function proveCertificate(uint256 tokenId, CertificateProof calldata p) external onlyTwinOwner(tokenId) {
        if (!verifyCertificate(tokenId, msg.sender, p)) revert InvalidProof();
        emit CertificateProven(tokenId, msg.sender, p.mask, p.disclosed);
    }

    // ------------------------------------------------------------------ views and helpers

    function commitmentOf(uint256 tokenId) external view returns (BN254.G1Point memory) {
        return _commitment[tokenId];
    }

    function generators() external view returns (BN254.G1Point[] memory gens, BN254.G1Point memory h) {
        return (_gens, _h);
    }

    function _setCommitment(uint256 tokenId, BN254.G1Point calldata c) private {
        if (!c.isOnCurve() || (c.x == 0 && c.y == 0)) revert InvalidCommitment();
        _commitment[tokenId] = c;
        ++commitmentVersion[tokenId];
    }

    function _popcount(uint256 x) private pure returns (uint256 n) {
        for (; x != 0; x &= x - 1) ++n;
    }
}

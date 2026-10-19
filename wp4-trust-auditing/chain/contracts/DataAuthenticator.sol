// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BN254} from "./BN254.sol";

/// @title DataAuthenticator
/// @notice Self-judging data authentication for digital twins (DeDT T4.2).
///
///   The data feed of a twin is signed by a set of signers (sensors, edge gateways or witnesses of
///   the twin team) registered by the twin's owner. Every batch of readings is summarised by a
///   Merkle root (WP2) and co-signed by at least `threshold` signers with one aggregated BLS
///   signature. The contract itself is the judge:
///     - it accepts a batch only with a valid t-of-n multi-signature (constant pairing cost);
///     - anyone can ask it whether a single record is authentic (Merkle proof), without
///       trusting the twin team or a third party;
///     - two different roots signed for the same (twin, sequence) are cryptographic proof of
///       equivocation: the contract revokes the signers that signed both, freezes the feed and
///       pays the owner's bond to the reporter — no human arbiter is involved.
///
/// @dev Public keys are kept in G1 so that they can be aggregated with the 0x06 precompile; the
///      caller supplies the G2 aggregate, which is checked within the same pairing equation
///      ("dual-key" check, see dedt_trust/bls.py). Rogue-key attacks are prevented by a proof of
///      possession at registration.
contract DataAuthenticator is ReentrancyGuard {
    using BN254 for BN254.G1Point;

    bytes32 public constant DST_SIG = keccak256("DeDT-BLS/sig/v1");
    bytes32 public constant DST_POP = keccak256("DeDT-BLS/pop/v1");
    bytes32 public constant BATCH_TAG = keccak256("DeDT-DataAuth/batch/v1");
    uint256 public constant MAX_SIGNERS = 32;

    struct Feed {
        uint8 signerCount;
        uint8 threshold;
        bool frozen;
        uint32 revoked; // bitmap of revoked signers
        uint256 bond; // wei backing the honesty of the feed
    }

    struct Batch {
        bytes32 root;
        uint32 signers; // bitmap of the signers of the accepted batch
    }

    IERC721 public immutable twins;
    mapping(uint256 => Feed) public feeds;
    mapping(uint256 => mapping(uint256 => BN254.G1Point)) private _signerKey;
    mapping(uint256 => mapping(uint64 => Batch)) public batches;

    event SignerAdded(uint256 indexed twinId, uint256 indexed index, uint256 pkX, uint256 pkY);
    event ThresholdSet(uint256 indexed twinId, uint8 threshold);
    event BondDeposited(uint256 indexed twinId, address indexed from, uint256 amount);
    event BatchAuthenticated(uint256 indexed twinId, uint64 indexed seq, bytes32 root, uint32 signers, address submitter);
    event EquivocationProven(uint256 indexed twinId, uint64 indexed seq, uint32 culprits, address reporter, uint256 reward);
    event FeedResumed(uint256 indexed twinId);

    error NotTwinOwner();
    error TooManySigners();
    error InvalidProofOfPossession();
    error InvalidThreshold();
    error FeedFrozen();
    error InvalidSignerSet();
    error InvalidSignature();
    error AlreadySubmitted();
    error EmptyRoot();
    error NoConflict();
    error NoCommonSigner();
    error StillUnsafe();
    error TransferFailed();

    constructor(IERC721 twins_) {
        twins = twins_;
    }

    modifier onlyTwinOwner(uint256 twinId) {
        if (twins.ownerOf(twinId) != msg.sender) revert NotTwinOwner();
        _;
    }

    // ------------------------------------------------------------ feed setup (twin owner)

    /// @notice Register a signer with its keys in G1 and G2 and a proof of possession of sk.
    function addSigner(uint256 twinId, BN254.G1Point calldata pk1, BN254.G2Point calldata pk2, BN254.G1Point calldata pop)
        external
        onlyTwinOwner(twinId)
        returns (uint256 index)
    {
        Feed storage f = feeds[twinId];
        if (f.signerCount >= MAX_SIGNERS) revert TooManySigners();
        if (!_verify(pop, pk1, pk2, DST_POP, keccak256(abi.encode(pk1.x, pk1.y)))) revert InvalidProofOfPossession();
        index = f.signerCount++;
        _signerKey[twinId][index] = pk1;
        emit SignerAdded(twinId, index, pk1.x, pk1.y);
    }

    function setThreshold(uint256 twinId, uint8 threshold) external onlyTwinOwner(twinId) {
        if (threshold == 0 || threshold > feeds[twinId].signerCount) revert InvalidThreshold();
        feeds[twinId].threshold = threshold;
        emit ThresholdSet(twinId, threshold);
    }

    /// @notice Stake backing the feed's honesty; paid to whoever proves an equivocation.
    function depositBond(uint256 twinId) external payable {
        feeds[twinId].bond += msg.value;
        emit BondDeposited(twinId, msg.sender, msg.value);
    }

    /// @notice After an equivocation the owner may resume the feed if enough honest signers remain.
    function resume(uint256 twinId) external onlyTwinOwner(twinId) {
        Feed storage f = feeds[twinId];
        uint256 active = _popcount(_allSigners(f.signerCount) & ~uint256(f.revoked));
        if (active < f.threshold) revert StillUnsafe();
        f.frozen = false;
        emit FeedResumed(twinId);
    }

    // ------------------------------------------------------------ data batches (anyone relays)

    function submitBatch(
        uint256 twinId,
        uint64 seq,
        bytes32 root,
        uint32 signers,
        BN254.G1Point calldata sig,
        BN254.G2Point calldata apk2
    ) external {
        Feed storage f = feeds[twinId];
        if (f.frozen) revert FeedFrozen();
        if (f.threshold == 0) revert InvalidThreshold();
        if (root == bytes32(0)) revert EmptyRoot();
        if (batches[twinId][seq].root != bytes32(0)) revert AlreadySubmitted();
        if (signers & f.revoked != 0 || _popcount(signers) < f.threshold) revert InvalidSignerSet();
        if (!_verifyBatch(twinId, seq, root, signers, sig, apk2)) revert InvalidSignature();
        batches[twinId][seq] = Batch(root, signers);
        emit BatchAuthenticated(twinId, seq, root, signers, msg.sender);
    }

    /// @notice The judgement any party can request: is this record part of an authenticated batch?
    function isAuthentic(uint256 twinId, uint64 seq, bytes32 recordHash, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        bytes32 root = batches[twinId][seq].root;
        if (root == bytes32(0)) return false;
        return MerkleProof.verify(proof, root, keccak256(bytes.concat(keccak256(abi.encode(recordHash)))));
    }

    /// @notice Prove that signers of an accepted batch also signed a different root for the same
    ///         sequence number. The common signers are revoked, the feed is frozen and the bond goes
    ///         to the reporter.
    function reportEquivocation(
        uint256 twinId,
        uint64 seq,
        bytes32 otherRoot,
        uint32 signers,
        BN254.G1Point calldata sig,
        BN254.G2Point calldata apk2
    ) external nonReentrant {
        Batch storage b = batches[twinId][seq];
        if (b.root == bytes32(0) || otherRoot == b.root || otherRoot == bytes32(0)) revert NoConflict();
        uint32 culprits = b.signers & signers;
        if (culprits == 0) revert NoCommonSigner();
        if (!_verifyBatch(twinId, seq, otherRoot, signers, sig, apk2)) revert InvalidSignature();

        Feed storage f = feeds[twinId];
        f.revoked |= culprits;
        f.frozen = true;
        uint256 reward = f.bond;
        f.bond = 0;
        emit EquivocationProven(twinId, seq, culprits, msg.sender, reward);
        if (reward > 0) {
            (bool ok,) = msg.sender.call{value: reward}("");
            if (!ok) revert TransferFailed();
        }
    }

    // ------------------------------------------------------------ views and helpers

    function signerKey(uint256 twinId, uint256 index) external view returns (BN254.G1Point memory) {
        return _signerKey[twinId][index];
    }

    function batchMessage(uint256 twinId, uint64 seq, bytes32 root) public view returns (bytes32) {
        return keccak256(abi.encode(BATCH_TAG, block.chainid, address(this), twinId, seq, root));
    }

    function _verifyBatch(
        uint256 twinId,
        uint64 seq,
        bytes32 root,
        uint32 signers,
        BN254.G1Point calldata sig,
        BN254.G2Point calldata apk2
    ) private view returns (bool) {
        uint256 n = feeds[twinId].signerCount;
        if (signers == 0 || uint256(signers) >> n != 0) revert InvalidSignerSet();
        BN254.G1Point memory apk1 = BN254.G1Point(0, 0);
        for (uint256 i; i < n; ++i) {
            if (signers & (uint32(1) << i) != 0) apk1 = apk1.add(_signerKey[twinId][i]);
        }
        return _verify(sig, apk1, apk2, DST_SIG, batchMessage(twinId, seq, root));
    }

    /// @dev e(σ + γ·apk1, g2) == e(H(m) + γ·g1, apk2), checked as e(σ + γ·apk1, -g2)·e(H(m) + γ·g1, apk2) == 1.
    function _verify(
        BN254.G1Point memory sig,
        BN254.G1Point memory apk1,
        BN254.G2Point memory apk2,
        bytes32 dst,
        bytes32 message
    ) private view returns (bool) {
        if (!sig.isOnCurve() || !apk1.isOnCurve()) return false;
        BN254.G1Point memory hm = BN254.hashToG1(dst, message);
        uint256 gamma = uint256(
            keccak256(
                abi.encode(sig.x, sig.y, apk1.x, apk1.y, apk2.x[0], apk2.x[1], apk2.y[0], apk2.y[1], hm.x, hm.y)
            )
        ) % BN254.Q;
        return BN254.pairing2(sig.add(apk1.mul(gamma)), BN254.negG2(), hm.add(BN254.g1().mul(gamma)), apk2);
    }

    function _allSigners(uint256 n) private pure returns (uint256) {
        return (uint256(1) << n) - 1;
    }

    function _popcount(uint256 x) private pure returns (uint256 c) {
        for (; x != 0; x &= x - 1) ++c;
    }
}

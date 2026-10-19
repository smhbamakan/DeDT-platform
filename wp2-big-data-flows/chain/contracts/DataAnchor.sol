// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title DataAnchor
/// @notice Anchors the integrity of digital twin data flows (DeDT WP2, task T2.2).
///         An edge node seals the sensor readings it received into batches and submits, for each
///         batch, the Merkle root of the readings and a hash of the window summaries it computed.
///         The contract links the batches in a hash chain, so that a stored raw log can later be
///         audited for modification, deletion, insertion or reordering, and any single reading can
///         be proven against its batch root with O(log n) hashes.
/// @dev Leaves and chain hashes are computed exactly as in the Python package `dedt_flows`:
///      leaf  = keccak256(bytes.concat(keccak256(abi.encode(twin, sensor, seq, tEventMs, valueMicro))))
///      chain = keccak256(abi.encode(prevChain, root, summaryHash, index, count, startMs, endMs))
contract DataAnchor {
    struct Twin {
        address owner;
        uint64 nextIndex;
        bytes32 head; // chain hash of the last anchored batch
    }

    struct BatchRecord {
        bytes32 root;
        bytes32 summaryHash;
        bytes32 chain;
        uint32 count;
        uint64 startMs;
        uint64 endMs;
        uint64 anchoredAt;
    }

    mapping(bytes32 => Twin) public twins;
    mapping(bytes32 => mapping(address => bool)) public isSubmitter; // edge nodes per twin
    mapping(bytes32 => mapping(uint64 => BatchRecord)) private _batches;

    event TwinRegistered(bytes32 indexed twinId, address indexed owner);
    event SubmitterSet(bytes32 indexed twinId, address indexed submitter, bool allowed);
    event BatchAnchored(bytes32 indexed twinId, uint64 indexed index, bytes32 root, bytes32 summaryHash, bytes32 chain, uint32 count);

    error AlreadyRegistered();
    error NotOwner();
    error NotSubmitter();
    error WrongIndex(uint64 expected, uint64 got);
    error EmptyBatch();
    error UnknownBatch();

    function registerTwin(bytes32 twinId) external {
        if (twins[twinId].owner != address(0)) revert AlreadyRegistered();
        twins[twinId].owner = msg.sender;
        emit TwinRegistered(twinId, msg.sender);
    }

    /// @notice The twin owner authorises (or removes) an edge node that may anchor batches.
    function setSubmitter(bytes32 twinId, address submitter, bool allowed) external {
        if (twins[twinId].owner != msg.sender) revert NotOwner();
        isSubmitter[twinId][submitter] = allowed;
        emit SubmitterSet(twinId, submitter, allowed);
    }

    /// @notice Anchor the next batch of a twin's data flow. Batches must arrive in order.
    function anchor(bytes32 twinId, uint64 index, bytes32 root, bytes32 summaryHash, uint32 count, uint64 startMs, uint64 endMs)
        external
        returns (bytes32 chain)
    {
        Twin storage t = twins[twinId];
        if (!isSubmitter[twinId][msg.sender]) revert NotSubmitter();
        if (index != t.nextIndex) revert WrongIndex(t.nextIndex, index);
        if (count == 0) revert EmptyBatch();

        chain = keccak256(abi.encode(t.head, root, summaryHash, index, count, startMs, endMs));
        _batches[twinId][index] = BatchRecord(root, summaryHash, chain, count, startMs, endMs, uint64(block.timestamp));
        t.head = chain;
        t.nextIndex = index + 1;
        emit BatchAnchored(twinId, index, root, summaryHash, chain, count);
    }

    /// @notice Is this reading part of the anchored batch?
    function verifyReading(
        bytes32 twinId,
        uint64 index,
        bytes32 sensor,
        uint64 seq,
        uint64 tEventMs,
        int256 valueMicro,
        bytes32[] calldata proof
    ) external view returns (bool) {
        BatchRecord storage b = _batches[twinId][index];
        if (b.count == 0) revert UnknownBatch();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(twinId, sensor, seq, tEventMs, valueMicro))));
        return MerkleProof.verifyCalldata(proof, b.root, leaf);
    }

    function batch(bytes32 twinId, uint64 index) external view returns (BatchRecord memory) {
        return _batches[twinId][index];
    }
}

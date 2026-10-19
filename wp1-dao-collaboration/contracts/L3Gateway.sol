// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IL3Receiver} from "./interfaces/IL3Receiver.sol";

/// @title L3Gateway
/// @notice The on-chain end of the "L3 network" of Banaeian Far & Hosseini Bamakan (2025),
///         Advanced Engineering Informatics 68, 103616, Fig. 3 and Table 14.
///         One gateway is deployed per blockchain ("domain"). Digital twin teams dispatch
///         messages in a Universal Transaction Schema (UTS); a decentralized validator set
///         attests to them; anyone can relay the attested message to the destination gateway.
///
/// @dev Differences from the paper's pseudocode (Table 14), made to remove the central authority:
///      - no `admin`: delivery requires a k-of-n quorum of validator signatures;
///      - message IDs are derived by the gateway from (domains, nonce, sender, recipient, payload),
///        not chosen by users, so they cannot collide or be front-run;
///      - IDs are bound to origin and destination domains, so a message cannot be replayed
///        on another chain, and each ID can be delivered only once;
///      - attestations are bound to the destination chain ID and gateway address, so a signature
///        collected for one gateway is useless on any other deployment (even with the same domain);
///      - delivery actually executes the message on the recipient contract;
///      - the validator set is rotated by a quorum of the current validators.
contract L3Gateway {
    /// @notice Universal Transaction Schema (paper, Algorithm 1 step 2 and Algorithm 3).
    struct UTS {
        uint32 originDomain;
        uint32 destDomain;
        uint64 nonce;
        address sender;
        address recipient;
        bytes payload;
    }

    bytes32 public constant ATTESTATION_TAG = keccak256("DeDT-L3/attest/v2");
    bytes32 public constant VALSET_TAG = keccak256("DeDT-L3/validator-set/v1");

    uint32 public immutable localDomain;
    uint64 public outboundNonce;
    mapping(bytes32 => bool) public delivered;

    address[] private _validators;
    mapping(address => bool) public isValidator;
    uint256 public threshold;
    uint256 public validatorSetVersion;

    event MessageDispatched(
        bytes32 indexed id,
        uint32 indexed destDomain,
        uint64 nonce,
        address sender,
        address recipient,
        bytes payload
    );
    event MessageDelivered(bytes32 indexed id, uint32 indexed originDomain, address recipient, address relayer);
    event ValidatorSetUpdated(uint256 indexed version, address[] validators, uint256 threshold);

    error WrongDomain(uint32 domain);
    error AlreadyDelivered(bytes32 id);
    error InvalidValidatorSet();
    error UnsortedOrDuplicateSigner(address signer);
    error UnknownValidator(address signer);
    error InsufficientSignatures(uint256 valid, uint256 required);

    constructor(uint32 domain, address[] memory initialValidators, uint256 threshold_) {
        localDomain = domain;
        _setValidators(initialValidators, threshold_);
    }

    // ---------------------------------------------------------------- outbound

    /// @notice Algorithm 3: encode the data in a UTS and emit it for the L3 network.
    ///         The sender is authenticated by the transaction signature itself.
    function dispatch(uint32 destDomain, address recipient, bytes calldata payload) external returns (bytes32 id) {
        if (destDomain == localDomain) revert WrongDomain(destDomain);
        uint64 nonce = outboundNonce++;
        id = messageId(UTS(localDomain, destDomain, nonce, msg.sender, recipient, payload));
        emit MessageDispatched(id, destDomain, nonce, msg.sender, recipient, payload);
    }

    // ----------------------------------------------------------------- inbound

    /// @notice Algorithm 4: verify the quorum attestation and execute the message.
    /// @param signatures Validator signatures over `attestationDigest(id)`, sorted by signer address.
    /// @dev If the recipient reverts, the whole call reverts and the message can be relayed again.
    function deliver(UTS calldata m, bytes[] calldata signatures) external {
        if (m.destDomain != localDomain) revert WrongDomain(m.destDomain);
        bytes32 id = messageId(m);
        if (delivered[id]) revert AlreadyDelivered(id);
        _checkQuorum(attestationDigest(id), signatures);

        delivered[id] = true;
        IL3Receiver(m.recipient).handleL3Message(m.originDomain, m.sender, m.payload);
        emit MessageDelivered(id, m.originDomain, m.recipient, msg.sender);
    }

    // -------------------------------------------------------------- governance

    /// @notice Replace the validator set; must be signed by a quorum of the current set.
    function updateValidators(address[] calldata newValidators, uint256 newThreshold, bytes[] calldata signatures)
        external
    {
        _checkQuorum(validatorSetDigest(newValidators, newThreshold), signatures);
        _setValidators(newValidators, newThreshold);
    }

    // ------------------------------------------------------------------- views

    function messageId(UTS memory m) public pure returns (bytes32) {
        return keccak256(
            abi.encode(m.originDomain, m.destDomain, m.nonce, m.sender, m.recipient, keccak256(m.payload))
        );
    }

    /// @notice What validators sign (EIP-191 personal message) to attest a message for delivery
    ///         on *this* gateway: the digest binds the chain ID and the gateway address.
    function attestationDigest(bytes32 id) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(ATTESTATION_TAG, block.chainid, address(this), id))
        );
    }

    /// @notice What validators sign to approve a new validator set on this gateway.
    function validatorSetDigest(address[] calldata newValidators, uint256 newThreshold) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(VALSET_TAG, localDomain, address(this), validatorSetVersion, newValidators, newThreshold))
        );
    }

    function validators() external view returns (address[] memory) {
        return _validators;
    }

    // ----------------------------------------------------------------- helpers

    function _checkQuorum(bytes32 digest, bytes[] calldata signatures) private view {
        address last;
        uint256 n = signatures.length;
        for (uint256 i; i < n; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer <= last) revert UnsortedOrDuplicateSigner(signer);
            if (!isValidator[signer]) revert UnknownValidator(signer);
            last = signer;
        }
        if (n < threshold) revert InsufficientSignatures(n, threshold);
    }

    function _setValidators(address[] memory validators_, uint256 threshold_) private {
        if (validators_.length == 0 || threshold_ == 0 || threshold_ > validators_.length) revert InvalidValidatorSet();
        for (uint256 i; i < _validators.length; ++i) isValidator[_validators[i]] = false;
        for (uint256 i; i < validators_.length; ++i) {
            address v = validators_[i];
            if (v == address(0) || isValidator[v]) revert InvalidValidatorSet();
            isValidator[v] = true;
        }
        _validators = validators_;
        threshold = threshold_;
        emit ValidatorSetUpdated(++validatorSetVersion, validators_, threshold_);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title HashTimeLock
/// @notice Hash time-locked contract (HTLC) for trustless cross-chain atomic swaps of
///         digital twin dNFTs and ETH, following the model in Banaeian Far & Hosseini Bamakan
///         (2025), §3.1.1: Alice locks x on chain A under H(s); Bob locks y on chain B under the
///         same H(s); Alice claims y by revealing s, which lets Bob claim x. Either both
///         transfers happen or, after the timelocks expire, both parties are refunded.
/// @dev No validators are involved: security rests on the hash function and the timelocks.
///      The party who reveals s must use the *longer* timelock on its own lock.
contract HashTimeLock is ReentrancyGuard {
    struct Lock {
        address sender;
        address receiver;
        address token; // address(0) for ETH, else an ERC-721 contract
        uint256 value; // wei for ETH, tokenId for ERC-721
        bytes32 hashlock; // keccak256(abi.encodePacked(preimage))
        uint64 timelock; // unix time after which the sender may refund
        bool settled;
    }

    mapping(bytes32 => Lock) public locks;
    uint256 private _counter;

    event Locked(bytes32 indexed id, address indexed sender, address indexed receiver, address token, uint256 value, bytes32 hashlock, uint64 timelock);
    event Claimed(bytes32 indexed id, bytes32 preimage);
    event Refunded(bytes32 indexed id);

    error InvalidLock();
    error AlreadySettled();
    error WrongPreimage();
    error Expired();
    error NotExpired();
    error NotSender();
    error TransferFailed();

    function lockETH(address receiver, bytes32 hashlock, uint64 timelock) external payable returns (bytes32 id) {
        if (msg.value == 0) revert InvalidLock();
        id = _create(receiver, address(0), msg.value, hashlock, timelock);
    }

    /// @dev Caller must have approved this contract for `tokenId`.
    function lockNFT(address receiver, address token, uint256 tokenId, bytes32 hashlock, uint64 timelock)
        external
        returns (bytes32 id)
    {
        if (token == address(0)) revert InvalidLock();
        id = _create(receiver, token, tokenId, hashlock, timelock);
        IERC721(token).transferFrom(msg.sender, address(this), tokenId);
    }

    /// @notice Anyone may claim on the receiver's behalf; the preimage becomes public in the event.
    function claim(bytes32 id, bytes32 preimage) external nonReentrant {
        Lock storage l = locks[id];
        if (l.sender == address(0)) revert InvalidLock();
        if (l.settled) revert AlreadySettled();
        if (block.timestamp >= l.timelock) revert Expired();
        if (keccak256(abi.encodePacked(preimage)) != l.hashlock) revert WrongPreimage();
        l.settled = true;
        _payout(l, l.receiver);
        emit Claimed(id, preimage);
    }

    function refund(bytes32 id) external nonReentrant {
        Lock storage l = locks[id];
        if (l.sender == address(0)) revert InvalidLock();
        if (l.settled) revert AlreadySettled();
        if (msg.sender != l.sender) revert NotSender();
        if (block.timestamp < l.timelock) revert NotExpired();
        l.settled = true;
        _payout(l, l.sender);
        emit Refunded(id);
    }

    function _create(address receiver, address token, uint256 value, bytes32 hashlock, uint64 timelock)
        private
        returns (bytes32 id)
    {
        if (receiver == address(0) || hashlock == bytes32(0) || timelock <= block.timestamp) revert InvalidLock();
        id = keccak256(abi.encode(msg.sender, receiver, token, value, hashlock, timelock, _counter++));
        locks[id] = Lock(msg.sender, receiver, token, value, hashlock, timelock, false);
        emit Locked(id, msg.sender, receiver, token, value, hashlock, timelock);
    }

    function _payout(Lock storage l, address to) private {
        if (l.token == address(0)) {
            (bool ok,) = to.call{value: l.value}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC721(l.token).transferFrom(address(this), to, l.value);
        }
    }
}

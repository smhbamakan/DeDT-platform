// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Implemented by applications that receive messages from an L3Gateway.
interface IL3Receiver {
    /// @param originDomain L3 domain of the chain the message came from.
    /// @param sender       Contract on the origin chain that dispatched the message.
    /// @param payload      Application-defined data.
    function handleL3Message(uint32 originDomain, address sender, bytes calldata payload) external;
}

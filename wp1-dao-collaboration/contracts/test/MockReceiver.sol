// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IL3Receiver} from "../interfaces/IL3Receiver.sol";

/// @dev Test helper: records the last message and can be told to fail.
contract MockReceiver is IL3Receiver {
    uint32 public lastOrigin;
    address public lastSender;
    bytes public lastPayload;
    bool public fail;

    function setFail(bool fail_) external {
        fail = fail_;
    }

    function handleL3Message(uint32 originDomain, address sender, bytes calldata payload) external {
        require(!fail, "receiver failed");
        lastOrigin = originDomain;
        lastSender = sender;
        lastPayload = payload;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BN254} from "./BN254.sol";

/// @title KeyServerRegistry
/// @notice Public parameters of the distributed IBE key service of the DeDT teams (T4.1, T4.4).
///         Teams read the master public key P_pub here to encrypt to any identity, and the
///         servers' public shares S_j to verify the partial keys they receive. The owner is the
///         DAO timelock (D1.2), so the key-server set changes only by vote.
/// @dev Every G2 point is validated by the pairing precompile, which rejects points that are not
///      on the twist or not in the order-q subgroup.
contract KeyServerRegistry is Ownable {
    struct Server {
        address operator;
        string endpoint;
        BN254.G2Point publicShare; // S_j = s_j·g2
    }

    uint256 public version;
    uint256 public threshold;
    BN254.G2Point private _masterPublic;
    Server[] private _servers;

    event ParametersUpdated(uint256 indexed version, uint256 threshold, uint256 servers);

    error InvalidParameters();

    constructor(address dao) Ownable(dao) {}

    function setParameters(BN254.G2Point calldata masterPublic, uint256 threshold_, Server[] calldata servers)
        external
        onlyOwner
    {
        if (threshold_ == 0 || threshold_ > servers.length) revert InvalidParameters();
        _checkG2(masterPublic);
        delete _servers;
        for (uint256 i; i < servers.length; ++i) {
            if (servers[i].operator == address(0)) revert InvalidParameters();
            _checkG2(servers[i].publicShare);
            _servers.push(servers[i]);
        }
        _masterPublic = masterPublic;
        threshold = threshold_;
        emit ParametersUpdated(++version, threshold_, servers.length);
    }

    function masterPublicKey() external view returns (BN254.G2Point memory) {
        return _masterPublic;
    }

    function servers() external view returns (Server[] memory) {
        return _servers;
    }

    /// @dev e(g1, X)·e(-g1, X) == 1 holds for every valid X; the precompile reverts otherwise.
    function _checkG2(BN254.G2Point calldata x) private view {
        if (!BN254.pairing2(BN254.g1(), x, BN254.neg(BN254.g1()), x)) revert InvalidParameters();
    }
}

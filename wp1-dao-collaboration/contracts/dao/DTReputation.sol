// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title DTReputation
/// @notice Non-transferable reputation of twin team members, used as voting power in the DAO.
///         It is earned (tasks, reports, admission by vote) and lost (upheld misbehaviour
///         reports, expulsion); it cannot be bought or moved, so votes reflect contributions.
/// @dev Owned by TwinWorkspace, which is the only account that mints and burns.
///      Holders are self-delegated automatically so their reputation counts as votes at once.
contract DTReputation is ERC20, ERC20Votes, Ownable {
    error NonTransferable();

    constructor() ERC20("DeDT Twin Team Reputation", "DTREP") EIP712("DeDT Twin Team Reputation", "1") Ownable(msg.sender) {}

    /// @notice Reputation is counted in whole points.
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        if (from != address(0) && to != address(0)) revert NonTransferable();
        super._update(from, to, value);
        if (to != address(0) && delegates(to) == address(0)) _delegate(to, to);
    }
}

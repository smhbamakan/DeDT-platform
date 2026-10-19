// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title IPShareToken
/// @notice Fungible shares of one IP-NFT, issued to the backers of a successful campaign.
///         Deployed by TwinFundraiser, which is the only account allowed to mint.
contract IPShareToken is ERC20 {
    address public immutable minter;
    uint256 public immutable ipTokenId;

    error OnlyMinter();

    constructor(string memory name_, string memory symbol_, uint256 ipTokenId_) ERC20(name_, symbol_) {
        minter = msg.sender;
        ipTokenId = ipTokenId_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert OnlyMinter();
        _mint(to, amount);
    }
}

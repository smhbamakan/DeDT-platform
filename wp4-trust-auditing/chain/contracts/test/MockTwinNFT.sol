// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Stand-in for the WP1 DigitalTwinDNFT in tests: any ERC-721 works with the WP4 contracts.
contract MockTwinNFT is ERC721 {
    constructor() ERC721("Twin", "TWIN") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

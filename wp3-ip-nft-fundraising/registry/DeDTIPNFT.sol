// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts@5.0.2/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts@5.0.2/access/Ownable.sol";

/// @title DeDT IP-NFT registry
/// @notice Records research outputs of the DeDT project (MSCAfellow7_MUNI) as IP-NFTs.
///         Each token stores its metadata URI and the SHA-256 digest of the published document.
contract DeDTIPNFT is ERC721URIStorage, Ownable {
    uint256 private _nextId = 1;

    /// SHA-256 digest of the document registered by each token
    mapping(uint256 => bytes32) public documentDigest;
    /// DOI of the document registered by each token
    mapping(uint256 => string) public documentDOI;

    event DocumentRegistered(uint256 indexed tokenId, bytes32 digest, string doi, string uri);

    constructor() ERC721("DeDT IP-NFT", "DEDTIP") Ownable(msg.sender) {}

    function register(address to, string calldata uri, bytes32 digest, string calldata doi)
        external onlyOwner returns (uint256 id)
    {
        id = _nextId++;
        _safeMint(to, id);
        _setTokenURI(id, uri);
        documentDigest[id] = digest;
        documentDOI[id] = doi;
        emit DocumentRegistered(id, digest, doi, uri);
    }
}

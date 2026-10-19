// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";

/// @title DigitalTwinIPNFT
/// @notice Registers a digital twin as an Intellectual Property NFT (IP-NFT).
///         Each token carries an immutable "birth certificate" (hash of the twin's
///         specification) and an append-only provenance trail of model/data versions.
/// @dev    Only hashes are stored on-chain; the confidential twin details stay off-chain
///         (e.g. encrypted on IPFS). See WP3 in the DeDT proposal.
contract DigitalTwinIPNFT is ERC721URIStorage, ERC2981 {
    struct BirthCertificate {
        bytes32 specHash; // hash of the twin's specification at registration
        address creator; // twin team that registered the IP
        uint64 createdAt;
        string license; // licence terms, e.g. "CC-BY-NC-4.0" or a URI
    }

    struct Version {
        bytes32 dataHash; // hash of the model / dataset snapshot
        uint64 timestamp;
        string note;
    }

    uint256 private _nextTokenId = 1;
    mapping(uint256 => BirthCertificate) private _certificates;
    mapping(uint256 => Version[]) private _versions;

    /// @notice specHash => tokenId (0 if unregistered). Prevents registering the same twin twice.
    mapping(bytes32 => uint256) public tokenOfSpec;

    event TwinRegistered(uint256 indexed tokenId, address indexed creator, bytes32 specHash, string uri);
    event VersionRecorded(uint256 indexed tokenId, uint256 indexed index, bytes32 dataHash, string note);

    error EmptyHash();
    error SpecAlreadyRegistered(uint256 tokenId);
    error NotOwnerOrCreator();

    constructor() ERC721("DeDT Digital Twin IP-NFT", "DTIP") {}

    /// @notice Register a new digital twin and mint its IP-NFT to the caller.
    /// @param specHash   keccak256 of the twin specification (its "birth certificate").
    /// @param uri        Metadata URI (e.g. ipfs://...) describing the twin publicly.
    /// @param license    Licence terms under which the IP may be used.
    /// @param royaltyBps Secondary-sale royalty for the creator, in basis points (max 10000).
    function registerTwin(bytes32 specHash, string calldata uri, string calldata license, uint96 royaltyBps)
        external
        returns (uint256 tokenId)
    {
        if (specHash == bytes32(0)) revert EmptyHash();
        if (tokenOfSpec[specHash] != 0) revert SpecAlreadyRegistered(tokenOfSpec[specHash]);

        tokenId = _nextTokenId++;
        tokenOfSpec[specHash] = tokenId;
        _certificates[tokenId] = BirthCertificate(specHash, msg.sender, uint64(block.timestamp), license);
        _versions[tokenId].push(Version(specHash, uint64(block.timestamp), "genesis"));

        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, uri);
        if (royaltyBps > 0) _setTokenRoyalty(tokenId, msg.sender, royaltyBps);

        emit TwinRegistered(tokenId, msg.sender, specHash, uri);
        emit VersionRecorded(tokenId, 0, specHash, "genesis");
    }

    /// @notice Append a new version (model update, dataset snapshot…) to the provenance trail.
    /// @dev Allowed for the current owner and the original creator, so the twin team can keep
    ///      recording versions while the NFT is locked in a fundraising campaign.
    function recordVersion(uint256 tokenId, bytes32 dataHash, string calldata note) external {
        if (dataHash == bytes32(0)) revert EmptyHash();
        if (msg.sender != ownerOf(tokenId) && msg.sender != _certificates[tokenId].creator) {
            revert NotOwnerOrCreator();
        }
        _versions[tokenId].push(Version(dataHash, uint64(block.timestamp), note));
        emit VersionRecorded(tokenId, _versions[tokenId].length - 1, dataHash, note);
    }

    // ------------------------------------------------------------------ views

    function birthCertificate(uint256 tokenId) external view returns (BirthCertificate memory) {
        _requireOwned(tokenId);
        return _certificates[tokenId];
    }

    function versionCount(uint256 tokenId) external view returns (uint256) {
        _requireOwned(tokenId);
        return _versions[tokenId].length;
    }

    function versionAt(uint256 tokenId, uint256 index) external view returns (Version memory) {
        _requireOwned(tokenId);
        return _versions[tokenId][index];
    }

    /// @notice Check an off-chain specification against the registered birth certificate.
    function verifySpec(uint256 tokenId, bytes32 specHash) external view returns (bool) {
        _requireOwned(tokenId);
        return _certificates[tokenId].specHash == specHash;
    }

    function totalRegistered() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721URIStorage, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}

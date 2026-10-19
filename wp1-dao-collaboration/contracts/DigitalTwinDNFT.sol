// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IL3Receiver} from "./interfaces/IL3Receiver.sol";
import {L3Gateway} from "./L3Gateway.sol";

/// @title DigitalTwinDNFT
/// @notice A digital twin project as a dynamic NFT (dNFT) whose state evolves over time,
///         S(t+1) = f(S(t), C), and which can be shared with twin teams on other blockchains
///         through the L3 network (Banaeian Far & Hosseini Bamakan, 2025, Fig. 3).
///
///   - Native twin: minted here; the owner and its collaborators update its state.
///   - Share:      the owner shares the twin with a team on another chain; that team receives a
///                 non-transferable *mirror* dNFT (Steps 6–12 of the paper).
///   - Contribute: the remote team updates its mirror; the update is sent back and recorded in the
///                 native twin's history with the contributor's address and chain (Step 13).
///   - Sync / Revoke: the owner pushes its latest state to a mirror, or withdraws access.
///   - Ordered channels: every message carries a sequence number per channel
///                 (twin, partner chain, team, direction) and is applied strictly in order, so a
///                 Revoke and a later re-Share can never take effect in the wrong order.
///
/// @dev Only hashes and URIs are stored; the twin data itself stays off-chain.
///      The same contract is deployed on every chain and trusts its peers via `trustedRemote`.
contract DigitalTwinDNFT is ERC721, Ownable, IL3Receiver {
    enum MsgKind {
        Share,
        Sync,
        Contribute,
        Revoke
    }

    struct TwinMsg {
        MsgKind kind;
        uint256 originTokenId;
        address team; // receiving team (Share/Sync/Revoke) or contributor (Contribute)
        address author;
        bytes32 stateHash;
        string uri;
        uint64 seq; // position in its channel, see channelId
    }

    struct Twin {
        bytes32 stateHash;
        uint64 version;
        uint32 originDomain; // 0 for native twins
        uint256 originTokenId;
        bool revoked;
        string uri;
    }

    struct Revision {
        bytes32 stateHash;
        address author;
        uint32 authorDomain;
        uint64 timestamp;
    }

    L3Gateway public immutable gateway;
    uint32 public immutable localDomain;
    mapping(uint32 => address) public trustedRemote;

    uint256 private _nextTokenId = 1;
    mapping(uint256 => Twin) private _twins;
    mapping(uint256 => Revision[]) private _history;
    mapping(uint256 => mapping(address => bool)) public isCollaborator;
    /// native tokenId => destination domain => team => shared
    mapping(uint256 => mapping(uint32 => mapping(address => bool))) public sharedWith;
    /// origin domain => origin tokenId => team => local mirror tokenId
    mapping(uint32 => mapping(uint256 => mapping(address => uint256))) public mirrorOf;
    /// channel => sequence number of the next message to send / to accept
    mapping(bytes32 => uint64) public nextOutSeq;
    mapping(bytes32 => uint64) public nextInSeq;

    event TwinMinted(uint256 indexed tokenId, address indexed owner, bytes32 stateHash);
    event StateUpdated(uint256 indexed tokenId, uint64 version, bytes32 stateHash, address author, uint32 authorDomain);
    event TwinShared(uint256 indexed tokenId, uint32 indexed destDomain, address indexed team, bytes32 messageId);
    event ShareRevoked(uint256 indexed tokenId, uint32 indexed destDomain, address indexed team);
    event MirrorCreated(uint256 indexed mirrorId, uint32 originDomain, uint256 originTokenId, address team);
    event TrustedRemoteSet(uint32 indexed domain, address remote);
    event ContributionRejected(uint256 indexed tokenId, uint32 indexed fromDomain, address indexed team, uint64 seq);

    error NotAuthorized();
    error NotNative(uint256 tokenId);
    error NotMirror(uint256 tokenId);
    error NotShared();
    error MirrorRevoked(uint256 tokenId);
    error MirrorNotTransferable();
    error OnlyGateway();
    error UntrustedRemote(uint32 domain, address sender);
    error UnknownMirror();
    error OutOfOrder(bytes32 channel, uint64 expected, uint64 received);

    constructor(L3Gateway gateway_) ERC721("DeDT Digital Twin dNFT", "DTWIN") Ownable(msg.sender) {
        gateway = gateway_;
        localDomain = gateway_.localDomain();
    }

    /// @notice Register the peer contract on another chain (deployment-time configuration).
    function setTrustedRemote(uint32 domain, address remote) external onlyOwner {
        trustedRemote[domain] = remote;
        emit TrustedRemoteSet(domain, remote);
    }

    // ------------------------------------------------------------ native twins

    /// @notice Step 1: a twin team launches its project as a dNFT.
    function mint(bytes32 stateHash, string calldata uri) external returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _twins[tokenId].uri = uri;
        _mint(msg.sender, tokenId);
        _applyState(tokenId, stateHash, "", msg.sender, localDomain);
        emit TwinMinted(tokenId, msg.sender, stateHash);
    }

    /// @notice Step 2: the team (owner or collaborators) develops the twin.
    function updateState(uint256 tokenId, bytes32 stateHash, string calldata uri) external {
        _requireNative(tokenId);
        if (msg.sender != ownerOf(tokenId) && !isCollaborator[tokenId][msg.sender]) revert NotAuthorized();
        _applyState(tokenId, stateHash, uri, msg.sender, localDomain);
    }

    function setCollaborator(uint256 tokenId, address account, bool allowed) external {
        if (msg.sender != ownerOf(tokenId)) revert NotAuthorized();
        isCollaborator[tokenId][account] = allowed;
    }

    /// @notice Steps 6–10: share the twin with `team` on `destDomain` through the L3 network.
    function shareTwin(uint256 tokenId, uint32 destDomain, address team) external returns (bytes32 id) {
        _requireNativeOwner(tokenId);
        sharedWith[tokenId][destDomain][team] = true;
        id = _send(destDomain, MsgKind.Share, tokenId, team);
        emit TwinShared(tokenId, destDomain, team, id);
    }

    /// @notice Push the latest native state to a team's mirror.
    function syncTwin(uint256 tokenId, uint32 destDomain, address team) external returns (bytes32) {
        _requireNativeOwner(tokenId);
        if (!sharedWith[tokenId][destDomain][team]) revert NotShared();
        return _send(destDomain, MsgKind.Sync, tokenId, team);
    }

    /// @notice Withdraw a team's access. Contributions still in flight will be rejected.
    function revokeShare(uint256 tokenId, uint32 destDomain, address team) external returns (bytes32) {
        _requireNativeOwner(tokenId);
        if (!sharedWith[tokenId][destDomain][team]) revert NotShared();
        sharedWith[tokenId][destDomain][team] = false;
        emit ShareRevoked(tokenId, destDomain, team);
        return _send(destDomain, MsgKind.Revoke, tokenId, team);
    }

    // ------------------------------------------------------------ mirror twins

    /// @notice Step 13: the receiving team modifies the shared twin; the change goes back to the origin.
    function contribute(uint256 mirrorId, bytes32 stateHash, string calldata uri) external returns (bytes32) {
        Twin storage t = _twins[mirrorId];
        if (t.originDomain == 0) revert NotMirror(mirrorId);
        if (msg.sender != ownerOf(mirrorId)) revert NotAuthorized();
        if (t.revoked) revert MirrorRevoked(mirrorId);
        _applyState(mirrorId, stateHash, uri, msg.sender, localDomain);

        bytes32 ch = channelId(t.originDomain, t.originTokenId, localDomain, msg.sender, true);
        TwinMsg memory m = TwinMsg(MsgKind.Contribute, t.originTokenId, msg.sender, msg.sender, stateHash, uri, nextOutSeq[ch]++);
        return gateway.dispatch(t.originDomain, trustedRemote[t.originDomain], abi.encode(m));
    }

    // ------------------------------------------------------------ L3 receiver

    function handleL3Message(uint32 originDomain, address sender, bytes calldata payload) external {
        if (msg.sender != address(gateway)) revert OnlyGateway();
        if (originDomain == 0 || sender != trustedRemote[originDomain]) revert UntrustedRemote(originDomain, sender);
        TwinMsg memory m = abi.decode(payload, (TwinMsg));
        bool up = m.kind == MsgKind.Contribute;
        bytes32 ch = up
            ? channelId(localDomain, m.originTokenId, originDomain, m.team, true)
            : channelId(originDomain, m.originTokenId, localDomain, m.team, false);
        // An early message reverts and stays deliverable (the gateway lets it be relayed again).
        if (m.seq != nextInSeq[ch]) revert OutOfOrder(ch, nextInSeq[ch], m.seq);
        nextInSeq[ch] = m.seq + 1;

        if (m.kind == MsgKind.Share) {
            _receiveShare(originDomain, m);
        } else if (up) {
            // Access was revoked while the contribution was in flight: consume it without effect,
            // so that the channel is not blocked for later contributions after a re-share.
            if (!sharedWith[m.originTokenId][originDomain][m.team]) {
                emit ContributionRejected(m.originTokenId, originDomain, m.team, m.seq);
                return;
            }
            _applyState(m.originTokenId, m.stateHash, m.uri, m.author, originDomain);
        } else {
            uint256 mirrorId = mirrorOf[originDomain][m.originTokenId][m.team];
            if (mirrorId == 0) revert UnknownMirror();
            // In-order delivery guarantees a Sync never follows a Revoke without a re-Share between them.
            if (m.kind == MsgKind.Revoke) _twins[mirrorId].revoked = true;
            else _applyState(mirrorId, m.stateHash, m.uri, m.author, originDomain);
        }
    }

    // ------------------------------------------------------------------ views

    function twin(uint256 tokenId) external view returns (Twin memory) {
        _requireOwned(tokenId);
        return _twins[tokenId];
    }

    function historyLength(uint256 tokenId) external view returns (uint256) {
        return _history[tokenId].length;
    }

    function revisionAt(uint256 tokenId, uint256 index) external view returns (Revision memory) {
        return _history[tokenId][index];
    }

    /// @notice Identifier of the channel between a native twin and one team on a mirror chain.
    /// @param up true for mirror → native (Contribute), false for native → mirror (Share, Sync, Revoke).
    function channelId(uint32 nativeDomain, uint256 nativeTokenId, uint32 mirrorDomain, address team, bool up)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(nativeDomain, nativeTokenId, mirrorDomain, team, up));
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _twins[tokenId].uri;
    }

    // ---------------------------------------------------------------- helpers

    function _receiveShare(uint32 originDomain, TwinMsg memory m) private {
        uint256 mirrorId = mirrorOf[originDomain][m.originTokenId][m.team];
        if (mirrorId == 0) {
            mirrorId = _nextTokenId++;
            mirrorOf[originDomain][m.originTokenId][m.team] = mirrorId;
            Twin storage t = _twins[mirrorId];
            t.originDomain = originDomain;
            t.originTokenId = m.originTokenId;
            _mint(m.team, mirrorId);
            emit MirrorCreated(mirrorId, originDomain, m.originTokenId, m.team);
        } else {
            _twins[mirrorId].revoked = false; // re-shared after a revoke
        }
        _applyState(mirrorId, m.stateHash, m.uri, m.author, originDomain);
    }

    function _send(uint32 destDomain, MsgKind kind, uint256 tokenId, address team) private returns (bytes32) {
        Twin storage t = _twins[tokenId];
        bytes32 ch = channelId(localDomain, tokenId, destDomain, team, false);
        TwinMsg memory m = TwinMsg(kind, tokenId, team, msg.sender, t.stateHash, t.uri, nextOutSeq[ch]++);
        return gateway.dispatch(destDomain, trustedRemote[destDomain], abi.encode(m));
    }

    function _applyState(uint256 tokenId, bytes32 stateHash, string memory uri, address author, uint32 domain)
        private
    {
        Twin storage t = _twins[tokenId];
        t.stateHash = stateHash;
        uint64 version = ++t.version;
        if (bytes(uri).length > 0) t.uri = uri;
        _history[tokenId].push(Revision(stateHash, author, domain, uint64(block.timestamp)));
        emit StateUpdated(tokenId, version, stateHash, author, domain);
    }

    function _requireNative(uint256 tokenId) private view {
        _requireOwned(tokenId);
        if (_twins[tokenId].originDomain != 0) revert NotNative(tokenId);
    }

    function _requireNativeOwner(uint256 tokenId) private view {
        _requireNative(tokenId);
        if (msg.sender != ownerOf(tokenId)) revert NotAuthorized();
    }

    /// @dev Mirrors grant access to one specific team, so they cannot be transferred.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && _twins[tokenId].originDomain != 0) {
            revert MirrorNotTransferable();
        }
        return super._update(to, tokenId, auth);
    }
}

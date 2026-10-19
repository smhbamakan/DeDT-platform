// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {DigitalTwinIPNFT} from "./DigitalTwinIPNFT.sol";
import {IPShareToken} from "./IPShareToken.sol";

/// @title TwinFundraiser
/// @notice All-or-nothing crowdfunding for digital twin projects, backed by their IP-NFT.
///
///   1. The twin team locks its IP-NFT and opens a campaign (goal + deadline).
///   2. Backers contribute ETH while the campaign is active.
///   3. After the deadline:
///        - Succeeded (raised >= goal): the team withdraws the funds, backers claim
///          IPShareToken 1:1 with their contribution; the IP-NFT stays locked as the
///          asset backing those shares.
///        - Failed: backers are refunded and the team takes its IP-NFT back.
///
/// @dev Uses pull payments and ReentrancyGuard; no loops over backers.
contract TwinFundraiser is IERC721Receiver, ReentrancyGuard {
    using Strings for uint256;

    enum State {
        Active,
        Succeeded,
        Failed
    }

    struct Campaign {
        uint256 tokenId;
        address creator;
        uint256 goal;
        uint64 deadline;
        uint256 raised;
        bool fundsWithdrawn;
        bool nftReclaimed;
        IPShareToken shares;
    }

    uint64 public constant MIN_DURATION = 1 hours;
    uint64 public constant MAX_DURATION = 365 days;

    DigitalTwinIPNFT public immutable ipnft;
    Campaign[] private _campaigns;
    mapping(uint256 => mapping(address => uint256)) public contributionOf;
    mapping(uint256 => mapping(address => bool)) public sharesClaimed;

    event CampaignCreated(uint256 indexed id, uint256 indexed tokenId, address indexed creator, uint256 goal, uint64 deadline, address shares);
    event Contributed(uint256 indexed id, address indexed backer, uint256 amount);
    event FundsWithdrawn(uint256 indexed id, uint256 amount);
    event SharesClaimed(uint256 indexed id, address indexed backer, uint256 amount);
    event Refunded(uint256 indexed id, address indexed backer, uint256 amount);
    event NFTReclaimed(uint256 indexed id, uint256 indexed tokenId);

    error NotTokenOwner();
    error InvalidGoal();
    error InvalidDuration();
    error WrongState(State expected, State actual);
    error NotCreator();
    error NothingToClaim();
    error AlreadyDone();
    error TransferFailed();
    error UnexpectedNFT();

    constructor(DigitalTwinIPNFT ipnft_) {
        ipnft = ipnft_;
    }

    /// @notice Lock an IP-NFT and open a campaign. Caller must own the token and approve this contract.
    function createCampaign(uint256 tokenId, uint256 goal, uint64 duration) external returns (uint256 id) {
        if (ipnft.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (goal == 0) revert InvalidGoal();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert InvalidDuration();

        id = _campaigns.length;
        IPShareToken shares = new IPShareToken(
            string.concat("DeDT IP Share #", tokenId.toString()),
            string.concat("DTIPS", tokenId.toString()),
            tokenId
        );
        uint64 deadline = uint64(block.timestamp) + duration;
        _campaigns.push(Campaign(tokenId, msg.sender, goal, deadline, 0, false, false, shares));

        ipnft.safeTransferFrom(msg.sender, address(this), tokenId);
        emit CampaignCreated(id, tokenId, msg.sender, goal, deadline, address(shares));
    }

    function contribute(uint256 id) external payable {
        _requireState(id, State.Active);
        if (msg.value == 0) revert NothingToClaim();
        _campaigns[id].raised += msg.value;
        contributionOf[id][msg.sender] += msg.value;
        emit Contributed(id, msg.sender, msg.value);
    }

    /// @notice Successful campaign: the twin team withdraws the raised funds.
    function withdrawFunds(uint256 id) external nonReentrant {
        _requireState(id, State.Succeeded);
        Campaign storage c = _campaigns[id];
        if (msg.sender != c.creator) revert NotCreator();
        if (c.fundsWithdrawn) revert AlreadyDone();
        c.fundsWithdrawn = true;
        _send(c.creator, c.raised);
        emit FundsWithdrawn(id, c.raised);
    }

    /// @notice Successful campaign: a backer mints IP shares equal to their contribution.
    function claimShares(uint256 id) external {
        _requireState(id, State.Succeeded);
        uint256 amount = contributionOf[id][msg.sender];
        if (amount == 0 || sharesClaimed[id][msg.sender]) revert NothingToClaim();
        sharesClaimed[id][msg.sender] = true;
        _campaigns[id].shares.mint(msg.sender, amount);
        emit SharesClaimed(id, msg.sender, amount);
    }

    /// @notice Failed campaign: a backer takes their contribution back.
    function refund(uint256 id) external nonReentrant {
        _requireState(id, State.Failed);
        uint256 amount = contributionOf[id][msg.sender];
        if (amount == 0) revert NothingToClaim();
        contributionOf[id][msg.sender] = 0;
        _send(msg.sender, amount);
        emit Refunded(id, msg.sender, amount);
    }

    /// @notice Failed campaign: the twin team takes its IP-NFT back.
    function reclaimNFT(uint256 id) external {
        _requireState(id, State.Failed);
        Campaign storage c = _campaigns[id];
        if (msg.sender != c.creator) revert NotCreator();
        if (c.nftReclaimed) revert AlreadyDone();
        c.nftReclaimed = true;
        ipnft.safeTransferFrom(address(this), c.creator, c.tokenId);
        emit NFTReclaimed(id, c.tokenId);
    }

    // ------------------------------------------------------------------ views

    function state(uint256 id) public view returns (State) {
        Campaign storage c = _campaigns[id];
        if (block.timestamp < c.deadline) return State.Active;
        return c.raised >= c.goal ? State.Succeeded : State.Failed;
    }

    function campaign(uint256 id) external view returns (Campaign memory) {
        return _campaigns[id];
    }

    function campaignCount() external view returns (uint256) {
        return _campaigns.length;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(ipnft)) revert UnexpectedNFT();
        return IERC721Receiver.onERC721Received.selector;
    }

    // ---------------------------------------------------------------- helpers

    function _requireState(uint256 id, State expected) private view {
        State actual = state(id);
        if (actual != expected) revert WrongState(expected, actual);
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}

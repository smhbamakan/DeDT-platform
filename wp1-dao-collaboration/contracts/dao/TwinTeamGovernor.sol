// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

/// @title TwinTeamGovernor
/// @notice Governance of the twin teams' DAO (WP1, D1.2). Members propose and vote with their
///         reputation (for / against / abstain); accepted proposals are queued in a timelock and
///         then executed on the workspace, the dNFT bridge configuration or the treasury.
///
///         Optional voting cap: no member's vote counts for more than `maxVoteShareBps` of the
///         total reputation at the snapshot. This limits the weight of founding members, who start
///         with the most reputation, until the DAO rebalances reputation by vote.
contract TwinTeamGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    uint256 public constant MIN_VOTE_SHARE_BPS = 1000; // 10 %
    uint256 public constant BPS = 10_000;

    /// @notice Cap on one member's voting weight, in basis points of total reputation (0 = no cap).
    uint256 public maxVoteShareBps;

    event MaxVoteShareSet(uint256 oldBps, uint256 newBps);

    error InvalidVoteShare(uint256 bps);

    /// @param votingDelay_     blocks between proposing and the start of voting
    /// @param votingPeriod_    blocks during which votes are accepted
    /// @param threshold_       reputation needed to submit a proposal
    /// @param quorumPercent_   share of total reputation that must take part (for + abstain)
    /// @param maxVoteShareBps_ cap on one member's voting weight (basis points; 0 = no cap)
    constructor(
        IVotes reputation,
        TimelockController timelock,
        uint48 votingDelay_,
        uint32 votingPeriod_,
        uint256 threshold_,
        uint256 quorumPercent_,
        uint256 maxVoteShareBps_
    )
        Governor("DeDT Twin Teams DAO")
        GovernorSettings(votingDelay_, votingPeriod_, threshold_)
        GovernorVotes(reputation)
        GovernorVotesQuorumFraction(quorumPercent_)
        GovernorTimelockControl(timelock)
    {
        _setMaxVoteShare(maxVoteShareBps_);
    }

    /// @notice Change the voting cap. Only through a proposal executed by the timelock.
    function setMaxVoteShare(uint256 bps) external onlyGovernance {
        _setMaxVoteShare(bps);
    }

    /// @dev Votes are read at the proposal snapshot and capped relative to the total reputation
    ///      at that same snapshot, so the cap cannot be gamed by minting after a proposal starts.
    function _getVotes(address account, uint256 timepoint, bytes memory params)
        internal
        view
        override(Governor, GovernorVotes)
        returns (uint256)
    {
        uint256 votes = super._getVotes(account, timepoint, params);
        if (maxVoteShareBps == 0) return votes;
        uint256 cap = (token().getPastTotalSupply(timepoint) * maxVoteShareBps) / BPS;
        return votes < cap ? votes : cap;
    }

    function _setMaxVoteShare(uint256 bps) private {
        if (bps != 0 && (bps < MIN_VOTE_SHARE_BPS || bps > BPS)) revert InvalidVoteShare(bps);
        emit MaxVoteShareSet(maxVoteShareBps, bps);
        maxVoteShareBps = bps;
    }

    // Solidity requires these overrides to resolve the multiple inheritance.

    function state(uint256 proposalId) public view override(Governor, GovernorTimelockControl) returns (ProposalState) {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId) public view override(Governor, GovernorTimelockControl) returns (bool) {
        return super.proposalNeedsQueuing(proposalId);
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    function _queueOperations(uint256 proposalId, address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash)
        internal
        override(Governor, GovernorTimelockControl)
        returns (uint48)
    {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(uint256 proposalId, address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash)
        internal
        override(Governor, GovernorTimelockControl)
    {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash)
        internal
        override(Governor, GovernorTimelockControl)
        returns (uint256)
    {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }
}

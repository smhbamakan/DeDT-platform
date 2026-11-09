// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DigitalTwinIPNFT} from "./DigitalTwinIPNFT.sol";

/// @title TwinVerifiedFinancing — Digital-Twin-Verified Financing (DTVF)
/// @notice Staged financing of a collaborative digital twin. The twin's IP-NFT is held in escrow as a
///         certificate of the project. Funds are raised all-or-nothing in an ERC-20 asset (e.g. a euro
///         stablecoin). An optional advance finances the first stage; the budget released on acceptance of
///         milestone m finances the next stage. A milestone is accepted when the team claims a KPI value that
///         meets the target and points to evidence recorded in the twin's provenance trail; the claim is
///         accepted optimistically unless it is challenged, in which case backers decide by a stake-weighted
///         vote. A rejected claim or a missed deadline cancels the project and returns the unreleased balance
///         to backers. Income of the twin is shared between backers (theta) and team members (fixed split).
/// @dev    DeDT WP3 · D3.2. Research prototype, not audited.
contract TwinVerifiedFinancing is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 internal constant BPS = 10_000;
    uint256 internal constant ACC = 1e18;

    enum Phase { Funding, Active, Completed, Cancelled }
    enum MState { Pending, Claimed, Disputed, Accepted, Rejected }

    struct Terms {
        uint64 fundingDuration;  // seconds
        uint64 challengeWindow;  // seconds a claim stays open to challenge
        uint64 voteWindow;       // seconds a dispute is open for voting
        uint16 bondBps;          // claim bond and challenge bond as a share of the tranche
        uint16 quorumBps;        // share of raised capital that must vote for a rejection to count
        uint16 thetaBps;         // share of twin income paid to backers
        uint128 capPerBacker;    // 0 = no cap
        uint128 advance;         // tranche released to the team when funding succeeds (finances stage 1)
        bool allowListOnly;      // only allow-listed backers may contribute
    }

    struct Milestone {
        uint128 budget;
        uint64 duration;     // time allowed from the start of the milestone to an accepted claim
        bytes32 kpi;         // identifier of the KPI computed by the twin
        int128 target;       // KPI threshold (reported >= target)
        int128 reported;
        bytes32 evidence;    // data hash taken from the IP-NFT provenance trail
        uint64 claimedAt;
        uint64 disputeEnd;
        address challenger;
        uint128 votesFor;
        uint128 votesAgainst;
        MState state;
    }

    struct Project {
        address team;
        uint256 tokenId;
        IERC20 asset;
        uint128 goal;
        uint128 raised;
        uint128 released;
        uint64 fundingEnd;
        uint64 milestoneStart;
        uint8 current;
        Phase phase;
        uint256 revenuePerUnit; // accumulated backer income per unit of contribution, scaled by ACC
    }

    DigitalTwinIPNFT public immutable ipnft;

    Project[] private _projects;
    mapping(uint256 => Terms) public termsOf;
    mapping(uint256 => Milestone[]) private _milestones;
    mapping(uint256 => address[]) private _members;
    mapping(uint256 => uint16[]) private _splitBps;
    mapping(uint256 => mapping(address => uint256)) public contributionOf;
    mapping(uint256 => mapping(address => bool)) public allowed;
    mapping(uint256 => mapping(address => bool)) public refunded;
    mapping(uint256 => mapping(address => uint256)) private _revenueDebt;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public hasVoted;
    /// pull-payment balances: asset => account => amount
    mapping(address => mapping(address => uint256)) public credit;

    event ProjectCreated(uint256 indexed id, uint256 indexed tokenId, address indexed team, address asset, uint256 goal);
    event Contributed(uint256 indexed id, address indexed backer, uint256 amount);
    event FundingClosed(uint256 indexed id, bool success, uint256 raised);
    event Claimed(uint256 indexed id, uint256 indexed milestone, int256 reported, bytes32 evidence);
    event Challenged(uint256 indexed id, uint256 indexed milestone, address indexed challenger);
    event Voted(uint256 indexed id, uint256 indexed milestone, address indexed backer, bool support, uint256 weight);
    event MilestoneResolved(uint256 indexed id, uint256 indexed milestone, bool accepted, uint256 tranche);
    event ProjectCancelled(uint256 indexed id, uint256 refundable);
    event Refunded(uint256 indexed id, address indexed backer, uint256 amount);
    event RevenueDeposited(uint256 indexed id, address indexed from, uint256 amount, uint256 toBackers);
    event Withdrawn(address indexed asset, address indexed account, uint256 amount);

    error BadParameters();
    error NotTeam();
    error WrongPhase();
    error WrongState();
    error NotAllowed();
    error CapExceeded();
    error TooEarly();
    error TooLate();
    error TargetNotMet();
    error BadEvidence();
    error NotBacker();
    error AlreadyDone();
    error Nothing();
    error UnexpectedNFT();

    constructor(DigitalTwinIPNFT ipnft_) {
        ipnft = ipnft_;
    }

    // ------------------------------------------------------------------ set-up

    /// @notice Escrow the IP-NFT and open a staged funding round.
    function createProject(
        uint256 tokenId,
        IERC20 asset,
        Milestone[] calldata milestones,
        address[] calldata team_,
        uint16[] calldata splitBps,
        Terms calldata terms
    ) external returns (uint256 id) {
        if (team_.length == 0 || team_.length != splitBps.length) revert BadParameters();
        if (terms.thetaBps > BPS || terms.bondBps > BPS || terms.quorumBps > BPS || terms.fundingDuration == 0) {
            revert BadParameters();
        }
        _checkSplits(splitBps);
        id = _projects.length;
        uint256 goal = _storeMilestones(id, milestones) + terms.advance;
        _projects.push(Project({
            team: msg.sender,
            tokenId: tokenId,
            asset: asset,
            goal: uint128(goal),
            raised: 0,
            released: 0,
            fundingEnd: uint64(block.timestamp) + terms.fundingDuration,
            milestoneStart: 0,
            current: 0,
            phase: Phase.Funding,
            revenuePerUnit: 0
        }));
        termsOf[id] = terms;
        _members[id] = team_;
        _splitBps[id] = splitBps;

        ipnft.safeTransferFrom(msg.sender, address(this), tokenId); // reverts unless caller owns or is approved
        emit ProjectCreated(id, tokenId, msg.sender, address(asset), goal);
    }

    /// @notice Compliance hook: the team (or the platform operating for it) admits eligible backers.
    function setAllowed(uint256 id, address[] calldata accounts, bool ok) external {
        if (msg.sender != _projects[id].team) revert NotTeam();
        for (uint256 i; i < accounts.length; ++i) allowed[id][accounts[i]] = ok;
    }

    // ---------------------------------------------------------------- funding

    function contribute(uint256 id, uint256 amount) external nonReentrant {
        Project storage p = _projects[id];
        Terms storage t = termsOf[id];
        if (p.phase != Phase.Funding) revert WrongPhase();
        if (block.timestamp >= p.fundingEnd) revert TooLate();
        if (t.allowListOnly && !allowed[id][msg.sender]) revert NotAllowed();
        if (amount == 0 || p.raised + amount > p.goal) revert CapExceeded();
        uint256 mine = contributionOf[id][msg.sender] + amount;
        if (t.capPerBacker != 0 && mine > t.capPerBacker) revert CapExceeded();

        contributionOf[id][msg.sender] = mine;
        p.raised += uint128(amount);
        p.asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Contributed(id, msg.sender, amount);
    }

    /// @notice Close funding: activate if the goal is met, otherwise cancel (full refunds).
    function closeFunding(uint256 id) external {
        Project storage p = _projects[id];
        if (p.phase != Phase.Funding) revert WrongPhase();
        if (p.raised < p.goal && block.timestamp < p.fundingEnd) revert TooEarly();
        bool ok = p.raised == p.goal;
        if (ok) {
            p.phase = Phase.Active;
            p.milestoneStart = uint64(block.timestamp);
            uint128 adv = termsOf[id].advance;
            if (adv != 0) {
                p.released = adv;
                _payTeam(id, address(p.asset), adv);
            }
        } else {
            _cancel(id);
        }
        emit FundingClosed(id, ok, p.raised);
    }

    // ------------------------------------------------------------- milestones

    /// @notice Claim the current milestone. `versionIndex` points to the entry of the twin's provenance
    ///         trail whose data hash commits to the KPI evidence (data batch root and computation).
    function claim(uint256 id, int128 reported, uint256 versionIndex) external nonReentrant {
        Project storage p = _projects[id];
        if (msg.sender != p.team) revert NotTeam();
        if (p.phase != Phase.Active) revert WrongPhase();
        Milestone storage m = _milestones[id][p.current];
        if (m.state != MState.Pending) revert WrongState();
        if (block.timestamp > p.milestoneStart + m.duration) revert TooLate();
        if (reported < m.target) revert TargetNotMet();
        DigitalTwinIPNFT.Version memory v = ipnft.versionAt(p.tokenId, versionIndex);
        if (v.timestamp < p.milestoneStart) revert BadEvidence();

        uint256 bond = _bond(id, m.budget);
        m.reported = reported;
        m.evidence = v.dataHash;
        m.claimedAt = uint64(block.timestamp);
        m.state = MState.Claimed;
        if (bond != 0) p.asset.safeTransferFrom(msg.sender, address(this), bond);
        emit Claimed(id, p.current, reported, v.dataHash);
    }

    /// @notice Challenge a claim within the challenge window by posting an equal bond.
    function challenge(uint256 id) external nonReentrant {
        Project storage p = _projects[id];
        Milestone storage m = _milestones[id][p.current];
        if (p.phase != Phase.Active || m.state != MState.Claimed) revert WrongState();
        Terms storage t = termsOf[id];
        if (block.timestamp > m.claimedAt + t.challengeWindow) revert TooLate();

        uint256 bond = _bond(id, m.budget);
        m.challenger = msg.sender;
        m.disputeEnd = uint64(block.timestamp) + t.voteWindow;
        m.state = MState.Disputed;
        if (bond != 0) p.asset.safeTransferFrom(msg.sender, address(this), bond);
        emit Challenged(id, p.current, msg.sender);
    }

    /// @notice Backers vote on a disputed claim with weight equal to their contribution.
    function vote(uint256 id, bool support) external {
        Project storage p = _projects[id];
        uint256 k = p.current;
        Milestone storage m = _milestones[id][k];
        if (m.state != MState.Disputed) revert WrongState();
        if (block.timestamp > m.disputeEnd) revert TooLate();
        uint256 w = contributionOf[id][msg.sender];
        if (w == 0) revert NotBacker();
        if (hasVoted[id][k][msg.sender]) revert AlreadyDone();
        hasVoted[id][k][msg.sender] = true;
        if (support) m.votesFor += uint128(w);
        else m.votesAgainst += uint128(w);
        emit Voted(id, k, msg.sender, support, w);
    }

    /// @notice Settle the current milestone once its challenge window or vote has ended.
    ///         An unchallenged claim is accepted. A disputed claim is rejected only if votes against
    ///         exceed votes for and the quorum is met; the burden of proof lies with the challenger.
    function resolve(uint256 id) external nonReentrant {
        Project storage p = _projects[id];
        if (p.phase != Phase.Active) revert WrongPhase();
        uint256 k = p.current;
        Milestone storage m = _milestones[id][k];
        Terms storage t = termsOf[id];
        uint256 bond = _bond(id, m.budget);
        address asset = address(p.asset);

        bool accept;
        if (m.state == MState.Claimed) {
            if (block.timestamp <= m.claimedAt + t.challengeWindow) revert TooEarly();
            accept = true;
            credit[asset][p.team] += bond;
        } else if (m.state == MState.Disputed) {
            if (block.timestamp <= m.disputeEnd) revert TooEarly();
            uint256 turnout = uint256(m.votesFor) + m.votesAgainst;
            bool quorum = turnout * BPS >= uint256(t.quorumBps) * p.raised;
            accept = !(quorum && m.votesAgainst > m.votesFor);
            // the losing side forfeits its bond to the winning side
            credit[asset][accept ? p.team : m.challenger] += 2 * bond;
        } else {
            revert WrongState();
        }

        if (accept) {
            m.state = MState.Accepted;
            p.released += m.budget;
            _payTeam(id, asset, m.budget);
            emit MilestoneResolved(id, k, true, m.budget);
            if (k + 1 == _milestones[id].length) {
                p.phase = Phase.Completed;
            } else {
                p.current = uint8(k + 1);
                p.milestoneStart = uint64(block.timestamp);
            }
        } else {
            m.state = MState.Rejected;
            emit MilestoneResolved(id, k, false, 0);
            _cancel(id);
        }
    }

    /// @notice Cancel an active project whose current milestone missed its deadline without a claim.
    function cancelOverdue(uint256 id) external {
        Project storage p = _projects[id];
        if (p.phase != Phase.Active) revert WrongPhase();
        Milestone storage m = _milestones[id][p.current];
        if (m.state != MState.Pending) revert WrongState();
        if (block.timestamp <= p.milestoneStart + m.duration) revert TooEarly();
        _cancel(id);
    }

    /// @notice After cancellation each backer recovers a pro-rata share of the unreleased balance.
    function refund(uint256 id) external nonReentrant {
        Project storage p = _projects[id];
        if (p.phase != Phase.Cancelled) revert WrongPhase();
        if (refunded[id][msg.sender]) revert AlreadyDone();
        uint256 c = contributionOf[id][msg.sender];
        if (c == 0) revert Nothing();
        refunded[id][msg.sender] = true;
        uint256 amount = c * (p.raised - p.released) / p.raised;
        p.asset.safeTransfer(msg.sender, amount);
        emit Refunded(id, msg.sender, amount);
    }

    // ---------------------------------------------------------------- income

    /// @notice Pay income of the twin (licence fees, service revenue) into the project.
    function depositRevenue(uint256 id, uint256 amount) external nonReentrant {
        Project storage p = _projects[id];
        if (p.phase != Phase.Active && p.phase != Phase.Completed) revert WrongPhase();
        if (amount == 0) revert Nothing();
        p.asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 toBackers = amount * termsOf[id].thetaBps / BPS;
        p.revenuePerUnit += toBackers * ACC / p.raised;
        _payTeam(id, address(p.asset), amount - toBackers);
        emit RevenueDeposited(id, msg.sender, amount, toBackers);
    }

    function pendingRevenue(uint256 id, address backer) public view returns (uint256) {
        return contributionOf[id][backer] * _projects[id].revenuePerUnit / ACC - _revenueDebt[id][backer];
    }

    function claimRevenue(uint256 id) external {
        uint256 due = pendingRevenue(id, msg.sender);
        if (due == 0) revert Nothing();
        _revenueDebt[id][msg.sender] += due;
        credit[address(_projects[id].asset)][msg.sender] += due;
    }

    /// @notice Withdraw everything credited to the caller in `asset` (tranches, income, bonds).
    function withdraw(IERC20 asset) external nonReentrant {
        uint256 amount = credit[address(asset)][msg.sender];
        if (amount == 0) revert Nothing();
        credit[address(asset)][msg.sender] = 0;
        asset.safeTransfer(msg.sender, amount);
        emit Withdrawn(address(asset), msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    function project(uint256 id) external view returns (Project memory) { return _projects[id]; }
    function milestone(uint256 id, uint256 k) external view returns (Milestone memory) { return _milestones[id][k]; }
    function milestoneCount(uint256 id) external view returns (uint256) { return _milestones[id].length; }
    function members(uint256 id) external view returns (address[] memory, uint16[] memory) {
        return (_members[id], _splitBps[id]);
    }
    function projectCount() external view returns (uint256) { return _projects.length; }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(ipnft)) revert UnexpectedNFT();
        return IERC721Receiver.onERC721Received.selector;
    }

    // --------------------------------------------------------------- internal

    function _checkSplits(uint16[] calldata splitBps) private pure {
        uint256 sum;
        for (uint256 i; i < splitBps.length; ++i) sum += splitBps[i];
        if (sum != BPS) revert BadParameters();
    }

    function _storeMilestones(uint256 id, Milestone[] calldata ms) private returns (uint256 goal) {
        if (ms.length == 0 || ms.length > 20) revert BadParameters();
        for (uint256 i; i < ms.length; ++i) {
            Milestone calldata m = ms[i];
            if (m.budget == 0 || m.duration == 0) revert BadParameters();
            goal += m.budget;
            _milestones[id].push(Milestone(m.budget, m.duration, m.kpi, m.target, 0, 0, 0, 0, address(0), 0, 0, MState.Pending));
        }
    }

    function _bond(uint256 id, uint256 budget) private view returns (uint256) {
        return budget * termsOf[id].bondBps / BPS;
    }

    function _payTeam(uint256 id, address asset, uint256 amount) private {
        address[] storage mem = _members[id];
        uint16[] storage s = _splitBps[id];
        uint256 paid;
        uint256 last = mem.length - 1;
        for (uint256 i; i < last; ++i) {
            uint256 part = amount * s[i] / BPS;
            credit[asset][mem[i]] += part;
            paid += part;
        }
        credit[asset][mem[last]] += amount - paid; // rounding remainder to the last member
    }

    function _cancel(uint256 id) private {
        Project storage p = _projects[id];
        p.phase = Phase.Cancelled;
        ipnft.transferFrom(address(this), p.team, p.tokenId);
        emit ProjectCancelled(id, p.raised - p.released);
    }
}

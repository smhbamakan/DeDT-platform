// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DTReputation} from "./DTReputation.sol";

/// @title TwinWorkspace
/// @notice The common virtual workspace of twin teams (proposal WP1, deliverable D1.2),
///         managed by the teams themselves through the DAO. The owner is the DAO's timelock,
///         so every `onlyDAO` action below needs an accepted proposal.
///
///   Membership   admitted / expelled by vote; reputation = voting power
///   Projects     a digital twin (dNFT) with a project lead
///   Tasks        funded work items that members carry out in parallel; the lead accepts the
///                result, which pays the bounty and earns reputation
///   Experiments  computational experiments recorded by hash and endorsed by other members,
///                weighted by their reputation
///   Reports      collective monitoring: a member files a bonded report on misbehaviour and the
///                DAO rules on it (Banaeian Far & Hosseini Bamakan, Data Sci. Manag. 5(1), 2022)
contract TwinWorkspace is Ownable, ReentrancyGuard {
    enum TaskStatus {
        Open,
        Claimed,
        Submitted,
        Completed,
        Cancelled
    }

    enum ReportStatus {
        Pending,
        Upheld,
        Dismissed
    }

    struct Project {
        string name;
        address dnft; // DigitalTwinDNFT contract
        uint256 twinId; // the twin this project develops
        address lead;
        bool active;
    }

    struct Task {
        uint256 projectId;
        bytes32 specHash;
        uint256 bounty; // wei
        uint256 repReward;
        uint64 deadline;
        address assignee;
        bytes32 resultHash;
        TaskStatus status;
    }

    struct Experiment {
        uint256 projectId;
        address author;
        bytes32 configHash; // model, parameters, data version
        bytes32 resultHash;
        uint64 timestamp;
        uint32 endorsements;
        uint256 endorsementWeight; // sum of endorsers' reputation
    }

    struct Report {
        address reporter;
        address accused;
        bytes32 evidenceHash;
        uint256 bond;
        ReportStatus status;
    }

    DTReputation public immutable reputation;
    uint256 public reportBond;
    uint256 public reportReward; // reputation granted for an upheld report
    uint256 public committedBounties; // treasury reserved for open tasks
    uint256 public pendingBonds; // report bonds held until the DAO rules

    Project[] private _projects;
    Task[] private _tasks;
    Experiment[] private _experiments;
    Report[] private _reports;
    mapping(uint256 => mapping(address => bool)) public endorsed;

    event MemberAdmitted(address indexed account, uint256 reputation);
    event MemberExpelled(address indexed account, uint256 reputationBurned);
    event ProjectCreated(uint256 indexed id, string name, address dnft, uint256 twinId, address lead);
    event ProjectUpdated(uint256 indexed id, address lead, bool active);
    event TaskOpened(uint256 indexed id, uint256 indexed projectId, bytes32 specHash, uint256 bounty, uint256 repReward, uint64 deadline);
    event TaskClaimed(uint256 indexed id, address indexed assignee);
    event TaskSubmitted(uint256 indexed id, bytes32 resultHash);
    event TaskRejected(uint256 indexed id);
    event TaskCompleted(uint256 indexed id, address indexed assignee, uint256 bounty, uint256 repReward);
    event TaskCancelled(uint256 indexed id);
    event ExperimentSubmitted(uint256 indexed id, uint256 indexed projectId, address indexed author, bytes32 configHash, bytes32 resultHash);
    event ExperimentEndorsed(uint256 indexed id, address indexed endorser, uint256 weight);
    event ReportFiled(uint256 indexed id, address indexed reporter, address indexed accused, bytes32 evidenceHash);
    event ReportResolved(uint256 indexed id, bool upheld, uint256 reputationSlashed);
    event ParametersSet(uint256 reportBond, uint256 reportReward);

    error NotMember();
    error NotLead();
    error AlreadyMember();
    error InvalidProject();
    error InvalidTask();
    error WrongStatus();
    error DeadlinePassed();
    error InsufficientTreasury();
    error CannotEndorse();
    error InvalidReport();
    error WrongBond();
    error TransferFailed();

    modifier onlyMember() {
        if (reputation.balanceOf(msg.sender) == 0) revert NotMember();
        _;
    }

    constructor(DTReputation reputation_, address dao, uint256 reportBond_, uint256 reportReward_) Ownable(dao) {
        reputation = reputation_;
        reportBond = reportBond_;
        reportReward = reportReward_;
    }

    /// @notice The treasury accepts funding from anyone (grants, sponsors, NFT sales).
    receive() external payable {}

    // ------------------------------------------------------------- membership

    function admitMember(address account, uint256 rep) external onlyOwner {
        if (reputation.balanceOf(account) != 0) revert AlreadyMember();
        reputation.mint(account, rep);
        emit MemberAdmitted(account, rep);
    }

    function grantReputation(address account, uint256 rep) external onlyOwner {
        if (reputation.balanceOf(account) == 0) revert NotMember();
        reputation.mint(account, rep);
    }

    function expelMember(address account) external onlyOwner {
        uint256 bal = reputation.balanceOf(account);
        if (bal == 0) revert NotMember();
        reputation.burn(account, bal);
        emit MemberExpelled(account, bal);
    }

    function setParameters(uint256 reportBond_, uint256 reportReward_) external onlyOwner {
        reportBond = reportBond_;
        reportReward = reportReward_;
        emit ParametersSet(reportBond_, reportReward_);
    }

    // --------------------------------------------------------------- projects

    function createProject(string calldata name, address dnft, uint256 twinId, address lead)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (reputation.balanceOf(lead) == 0) revert NotMember();
        id = _projects.length;
        _projects.push(Project(name, dnft, twinId, lead, true));
        emit ProjectCreated(id, name, dnft, twinId, lead);
    }

    function updateProject(uint256 id, address lead, bool active) external onlyOwner {
        if (id >= _projects.length) revert InvalidProject();
        if (reputation.balanceOf(lead) == 0) revert NotMember();
        _projects[id].lead = lead;
        _projects[id].active = active;
        emit ProjectUpdated(id, lead, active);
    }

    // ------------------------------------------------------------------ tasks

    /// @notice Fund a task from the treasury. Several tasks can run in parallel on one project.
    function openTask(uint256 projectId, bytes32 specHash, uint256 bounty, uint256 repReward, uint64 deadline)
        external
        onlyOwner
        returns (uint256 id)
    {
        _requireActiveProject(projectId);
        if (deadline <= block.timestamp) revert DeadlinePassed();
        if (address(this).balance < committedBounties + pendingBonds + bounty) revert InsufficientTreasury();
        committedBounties += bounty;
        id = _tasks.length;
        _tasks.push(Task(projectId, specHash, bounty, repReward, deadline, address(0), bytes32(0), TaskStatus.Open));
        emit TaskOpened(id, projectId, specHash, bounty, repReward, deadline);
    }

    function claimTask(uint256 id) external onlyMember {
        Task storage t = _task(id);
        if (t.status != TaskStatus.Open) revert WrongStatus();
        if (block.timestamp >= t.deadline) revert DeadlinePassed();
        t.assignee = msg.sender;
        t.status = TaskStatus.Claimed;
        emit TaskClaimed(id, msg.sender);
    }

    function submitResult(uint256 id, bytes32 resultHash) external {
        Task storage t = _task(id);
        if (t.status != TaskStatus.Claimed || msg.sender != t.assignee) revert WrongStatus();
        if (block.timestamp >= t.deadline) revert DeadlinePassed();
        t.resultHash = resultHash;
        t.status = TaskStatus.Submitted;
        emit TaskSubmitted(id, resultHash);
    }

    /// @notice The project lead accepts a result. A lead's own work is accepted by the DAO.
    function approveTask(uint256 id) external nonReentrant {
        Task storage t = _task(id);
        if (t.status != TaskStatus.Submitted) revert WrongStatus();
        address lead = _projects[t.projectId].lead;
        bool byLead = msg.sender == lead && t.assignee != lead;
        if (!byLead && msg.sender != owner()) revert NotLead();

        t.status = TaskStatus.Completed;
        committedBounties -= t.bounty;
        if (t.repReward > 0) reputation.mint(t.assignee, t.repReward);
        _send(t.assignee, t.bounty);
        emit TaskCompleted(id, t.assignee, t.bounty, t.repReward);
    }

    /// @notice The lead sends a result back; the task is open again for anyone.
    function rejectResult(uint256 id) external {
        Task storage t = _task(id);
        if (t.status != TaskStatus.Submitted) revert WrongStatus();
        if (msg.sender != _projects[t.projectId].lead && msg.sender != owner()) revert NotLead();
        t.status = TaskStatus.Open;
        t.assignee = address(0);
        t.resultHash = bytes32(0);
        emit TaskRejected(id);
    }

    function cancelTask(uint256 id) external onlyOwner {
        Task storage t = _task(id);
        if (t.status == TaskStatus.Completed || t.status == TaskStatus.Cancelled) revert WrongStatus();
        t.status = TaskStatus.Cancelled;
        committedBounties -= t.bounty;
        emit TaskCancelled(id);
    }

    // ------------------------------------------------------------ experiments

    /// @notice Record a computational experiment (configuration + result) for reproducibility.
    function submitExperiment(uint256 projectId, bytes32 configHash, bytes32 resultHash)
        external
        onlyMember
        returns (uint256 id)
    {
        _requireActiveProject(projectId);
        id = _experiments.length;
        _experiments.push(Experiment(projectId, msg.sender, configHash, resultHash, uint64(block.timestamp), 0, 0));
        emit ExperimentSubmitted(id, projectId, msg.sender, configHash, resultHash);
    }

    /// @notice Another member confirms an experiment (e.g. after reproducing it).
    function endorseExperiment(uint256 id) external onlyMember {
        if (id >= _experiments.length) revert CannotEndorse();
        Experiment storage e = _experiments[id];
        if (e.author == msg.sender || endorsed[id][msg.sender]) revert CannotEndorse();
        endorsed[id][msg.sender] = true;
        uint256 weight = reputation.balanceOf(msg.sender);
        e.endorsements += 1;
        e.endorsementWeight += weight;
        emit ExperimentEndorsed(id, msg.sender, weight);
    }

    // ---------------------------------------------------------------- reports

    /// @notice Collective monitoring: report a member's misbehaviour with a bond against spam.
    function fileReport(address accused, bytes32 evidenceHash) external payable onlyMember returns (uint256 id) {
        if (msg.value != reportBond) revert WrongBond();
        if (accused == msg.sender || reputation.balanceOf(accused) == 0) revert InvalidReport();
        pendingBonds += msg.value;
        id = _reports.length;
        _reports.push(Report(msg.sender, accused, evidenceHash, msg.value, ReportStatus.Pending));
        emit ReportFiled(id, msg.sender, accused, evidenceHash);
    }

    /// @notice The DAO rules on a report. Upheld: the accused loses `slash` reputation and the
    ///         reporter gets the bond back plus a reward. Dismissed: the bond goes to the treasury.
    function resolveReport(uint256 id, bool upheld, uint256 slash) external onlyOwner nonReentrant {
        if (id >= _reports.length) revert InvalidReport();
        Report storage r = _reports[id];
        if (r.status != ReportStatus.Pending) revert WrongStatus();

        pendingBonds -= r.bond;
        uint256 slashed;
        if (upheld) {
            r.status = ReportStatus.Upheld;
            uint256 bal = reputation.balanceOf(r.accused);
            slashed = slash < bal ? slash : bal;
            if (slashed > 0) reputation.burn(r.accused, slashed);
            if (reportReward > 0) reputation.mint(r.reporter, reportReward);
            _send(r.reporter, r.bond);
        } else {
            r.status = ReportStatus.Dismissed;
        }
        emit ReportResolved(id, upheld, slashed);
    }

    // ------------------------------------------------------------------ views

    function project(uint256 id) external view returns (Project memory) {
        if (id >= _projects.length) revert InvalidProject();
        return _projects[id];
    }

    function task(uint256 id) external view returns (Task memory) {
        return _task(id);
    }

    function experiment(uint256 id) external view returns (Experiment memory) {
        return _experiments[id];
    }

    function report(uint256 id) external view returns (Report memory) {
        return _reports[id];
    }

    function counts() external view returns (uint256 projects, uint256 tasks, uint256 experiments, uint256 reports) {
        return (_projects.length, _tasks.length, _experiments.length, _reports.length);
    }

    /// @notice Treasury not reserved for open tasks.
    function availableTreasury() external view returns (uint256) {
        return address(this).balance - committedBounties - pendingBonds;
    }

    // ---------------------------------------------------------------- helpers

    function _task(uint256 id) private view returns (Task storage) {
        if (id >= _tasks.length) revert InvalidTask();
        return _tasks[id];
    }

    function _requireActiveProject(uint256 id) private view {
        if (id >= _projects.length || !_projects[id].active) revert InvalidProject();
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}

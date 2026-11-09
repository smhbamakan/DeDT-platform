// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title QuadraticMatchingPool — matching funds for the open components of digital twins
/// @notice One funding round. Sponsors (e.g. a grant programme or an industry consortium) fill a
///         matching pool; verified contributors support open components (open models, data schemas,
///         reference twins). Each component receives its contributions plus a match of
///         (sum_i sqrt(c_i))^2 - sum_i c_i, scaled down pro rata if the pool is insufficient
///         (Buterin, Hitzig and Weyl, 2019). Contributors must be verified by the owner, because
///         quadratic matching is only meaningful if one person cannot split into many accounts.
/// @dev    DeDT WP3 · D3.2. Research prototype, not audited.
contract QuadraticMatchingPool is Ownable {
    using SafeERC20 for IERC20;

    struct Component {
        address recipient;
        uint256 total;    // sum of contributions
        uint256 sumSqrt;  // sum over contributors of sqrt(contribution)
        bool paid;
    }

    IERC20 public immutable asset;
    uint64 public immutable roundEnd;
    uint256 public pool;
    uint256 public totalMatchAtClose;
    bool public closed;

    Component[] private _components;
    mapping(address => bool) public verified;
    mapping(uint256 => mapping(address => uint256)) public contributionOf;

    event ComponentAdded(uint256 indexed id, address recipient);
    event PoolFunded(address indexed sponsor, uint256 amount);
    event Contributed(uint256 indexed id, address indexed contributor, uint256 amount);
    event RoundClosed(uint256 pool, uint256 totalMatch);
    event Paid(uint256 indexed id, uint256 contributions, uint256 matched);

    error RoundOver();
    error RoundOpen();
    error NotVerified();
    error AlreadyDone();
    error Nothing();

    constructor(IERC20 asset_, uint64 duration) Ownable(msg.sender) {
        asset = asset_;
        roundEnd = uint64(block.timestamp) + duration;
    }

    function addComponent(address recipient) external onlyOwner returns (uint256 id) {
        if (block.timestamp >= roundEnd) revert RoundOver();
        id = _components.length;
        _components.push(Component(recipient, 0, 0, false));
        emit ComponentAdded(id, recipient);
    }

    function setVerified(address[] calldata accounts, bool ok) external onlyOwner {
        for (uint256 i; i < accounts.length; ++i) verified[accounts[i]] = ok;
    }

    function fundPool(uint256 amount) external {
        if (closed) revert RoundOver();
        pool += amount;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit PoolFunded(msg.sender, amount);
    }

    function contribute(uint256 id, uint256 amount) external {
        if (block.timestamp >= roundEnd) revert RoundOver();
        if (!verified[msg.sender]) revert NotVerified();
        if (amount == 0) revert Nothing();
        Component storage c = _components[id];
        uint256 before = contributionOf[id][msg.sender];
        uint256 next = before + amount;
        contributionOf[id][msg.sender] = next;
        c.sumSqrt = c.sumSqrt + Math.sqrt(next) - Math.sqrt(before);
        c.total += amount;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Contributed(id, msg.sender, amount);
    }

    /// @notice Unscaled quadratic match of a component.
    function rawMatch(uint256 id) public view returns (uint256) {
        Component storage c = _components[id];
        uint256 sq = c.sumSqrt * c.sumSqrt;
        return sq > c.total ? sq - c.total : 0;
    }

    function close() external {
        if (block.timestamp < roundEnd) revert RoundOpen();
        if (closed) revert AlreadyDone();
        closed = true;
        uint256 t;
        for (uint256 i; i < _components.length; ++i) t += rawMatch(i);
        totalMatchAtClose = t;
        emit RoundClosed(pool, t);
    }

    /// @notice Match actually paid: the raw match, scaled by min(1, pool / total raw match).
    function matchOf(uint256 id) public view returns (uint256) {
        uint256 m = rawMatch(id);
        uint256 t = closed ? totalMatchAtClose : _sumRaw();
        if (t <= pool) return m;
        return m * pool / t;
    }

    function payout(uint256 id) external {
        if (!closed) revert RoundOpen();
        Component storage c = _components[id];
        if (c.paid) revert AlreadyDone();
        c.paid = true;
        uint256 m = matchOf(id);
        asset.safeTransfer(c.recipient, c.total + m);
        emit Paid(id, c.total, m);
    }

    /// @notice Return the unused part of the pool to the owner once all components are paid.
    function sweep() external onlyOwner {
        if (!closed) revert RoundOpen();
        for (uint256 i; i < _components.length; ++i) if (!_components[i].paid) revert RoundOpen();
        uint256 bal = asset.balanceOf(address(this));
        if (bal == 0) revert Nothing();
        asset.safeTransfer(owner(), bal);
    }

    function component(uint256 id) external view returns (Component memory) { return _components[id]; }
    function componentCount() external view returns (uint256) { return _components.length; }

    function _sumRaw() private view returns (uint256 t) {
        for (uint256 i; i < _components.length; ++i) t += rawMatch(i);
    }
}

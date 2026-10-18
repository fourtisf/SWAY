// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwayStaking} from "./interfaces/ISwayStaking.sol";

interface ISwayKeysClaim {
    function claim(address[] calldata subjects) external returns (uint256);
}

/// @title SwayStaking
/// @notice Stake $SWAY for a level (1..4) that cuts the protocol fee on your key trades by 10/25/50/75%
///         and unlocks 2,000-character posts. Stakers share half of the protocol fee, paid in ETH.
///         Staker rewards are variable and may be zero.
/// @dev Unstaking starts a cooldown and drops the level immediately, so a level can't be borrowed for a
///      single trade. UNAUDITED.
contract SwayStaking is ISwayStaking, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant COOLDOWN = 7 days;
    /// @dev Stakes are 18-decimal token amounts, so the accumulator needs more than 1e18 of precision.
    uint256 internal constant ACC_PRECISION = 1e36;

    IERC20 public immutable token;
    ISwayKeysClaim public keys;

    /// @notice Minimum stake (token wei) for levels 1..4, ascending.
    uint256[4] public thresholds;

    struct Account {
        uint256 staked;
        uint256 unstaking;
        uint64 unlockAt;
        uint256 rewardDebt;
        uint256 rewards;
    }

    mapping(address => Account) public accounts;
    uint256 public totalStaked;
    uint256 public accRewardPerToken;
    /// @notice Rewards received while nobody was staked; distributed on the next harvest with stakers.
    uint256 public undistributed;

    event Staked(address indexed account, uint256 amount, uint8 level);
    event UnstakeRequested(address indexed account, uint256 amount, uint64 unlockAt, uint8 level);
    event Withdrawn(address indexed account, uint256 amount);
    event Harvested(uint256 amount, uint256 accRewardPerToken);
    event RewardsClaimed(address indexed account, uint256 amount);
    event ThresholdsSet(uint256[4] thresholds);
    event KeysSet(address keys);

    error ZeroAmount();
    error InsufficientStake();
    error StillCoolingDown();
    error NothingToWithdraw();
    error BadThresholds();
    error TransferFailed();
    error UnexpectedEth();

    constructor(address initialOwner, IERC20 token_, uint256[4] memory thresholds_) Ownable(initialOwner) {
        token = token_;
        _setThresholds(thresholds_);
    }

    receive() external payable {
        if (msg.sender != address(keys)) revert UnexpectedEth();
    }

    function levelOf(address account) public view returns (uint8 level) {
        uint256 s = accounts[account].staked;
        for (uint256 i; i < 4; ++i) {
            if (s >= thresholds[i]) level = uint8(i + 1);
        }
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _settle(msg.sender);
        Account storage a = accounts[msg.sender];
        a.staked += amount;
        totalStaked += amount;
        a.rewardDebt = accRewardPerToken;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, levelOf(msg.sender));
    }

    function requestUnstake(uint256 amount) external nonReentrant {
        Account storage a = accounts[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (a.staked < amount) revert InsufficientStake();
        _settle(msg.sender);
        a.staked -= amount;
        totalStaked -= amount;
        a.unstaking += amount;
        a.unlockAt = uint64(block.timestamp + COOLDOWN);
        a.rewardDebt = accRewardPerToken;
        emit UnstakeRequested(msg.sender, amount, a.unlockAt, levelOf(msg.sender));
    }

    function withdraw() external nonReentrant {
        Account storage a = accounts[msg.sender];
        uint256 amount = a.unstaking;
        if (amount == 0) revert NothingToWithdraw();
        if (block.timestamp < a.unlockAt) revert StillCoolingDown();
        a.unstaking = 0;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Pulls the stakers' protocol share from SwayKeys and distributes it pro rata.
    function harvest() public nonReentrant returns (uint256 amount) {
        uint256 before = address(this).balance;
        try keys.claim(new address[](0)) {} catch {}
        amount = address(this).balance - before + undistributed;
        if (amount == 0) return 0;
        if (totalStaked == 0) {
            undistributed = amount;
            return amount;
        }
        undistributed = 0;
        accRewardPerToken += (amount * ACC_PRECISION) / totalStaked;
        emit Harvested(amount, accRewardPerToken);
    }

    function pendingRewards(address account) external view returns (uint256) {
        Account storage a = accounts[account];
        return a.rewards + (a.staked * (accRewardPerToken - a.rewardDebt)) / ACC_PRECISION;
    }

    function claimRewards() external nonReentrant returns (uint256 amount) {
        _settle(msg.sender);
        Account storage a = accounts[msg.sender];
        amount = a.rewards;
        if (amount == 0) revert ZeroAmount();
        a.rewards = 0;
        emit RewardsClaimed(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _settle(address account) internal {
        Account storage a = accounts[account];
        uint256 owed = (a.staked * (accRewardPerToken - a.rewardDebt)) / ACC_PRECISION;
        if (owed != 0) a.rewards += owed;
        a.rewardDebt = accRewardPerToken;
    }

    function setKeys(address keys_) external onlyOwner {
        keys = ISwayKeysClaim(keys_);
        emit KeysSet(keys_);
    }

    function setThresholds(uint256[4] calldata thresholds_) external onlyOwner {
        _setThresholds(thresholds_);
    }

    function _setThresholds(uint256[4] memory t) internal {
        if (t[0] == 0 || t[0] >= t[1] || t[1] >= t[2] || t[2] >= t[3]) revert BadThresholds();
        thresholds = t;
        emit ThresholdsSet(t);
    }
}

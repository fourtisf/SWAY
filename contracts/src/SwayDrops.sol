// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title SwayDrops
/// @notice Creator airdrops to key holders (brief Phase 4). A creator deposits ETH with the merkle root of
///         holder allocations (Sway builds it from key balances, pro rata to units); holders claim their leaf;
///         after the expiry the creator can take back what wasn't claimed. Leaves use the same encoding as
///         SwayLaunchpad: keccak256(bytes.concat(keccak256(abi.encode(account, amount)))).
/// @dev The creator funds the drop, so no attestation is needed: they can only give their own ETH away.
///      UNAUDITED.
contract SwayDrops is ReentrancyGuard {
    uint64 public constant MIN_DURATION = 1 days;
    uint64 public constant MAX_DURATION = 365 days;

    struct Drop {
        address creator;
        uint64 expiresAt;
        bytes32 root;
        uint256 total;
        uint256 claimed;
        bool reclaimed;
    }

    Drop[] public drops;
    mapping(uint256 id => mapping(address account => bool)) public hasClaimed;

    event DropCreated(uint256 indexed id, address indexed creator, bytes32 root, uint256 total, uint64 expiresAt);
    event DropClaimed(uint256 indexed id, address indexed account, uint256 amount);
    event DropReclaimed(uint256 indexed id, address indexed creator, uint256 amount);

    error ZeroAmount();
    error BadDuration();
    error UnknownDrop();
    error Expired();
    error NotExpired();
    error AlreadyClaimed();
    error BadProof();
    error NotCreator();
    error Exhausted();
    error TransferFailed();

    function create(bytes32 root, uint64 duration) external payable returns (uint256 id) {
        if (msg.value == 0) revert ZeroAmount();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();
        id = drops.length;
        uint64 expiresAt = uint64(block.timestamp) + duration;
        drops.push(Drop({creator: msg.sender, expiresAt: expiresAt, root: root, total: msg.value, claimed: 0, reclaimed: false}));
        emit DropCreated(id, msg.sender, root, msg.value, expiresAt);
    }

    function claim(uint256 id, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        if (id >= drops.length) revert UnknownDrop();
        Drop storage d = drops[id];
        if (block.timestamp >= d.expiresAt || d.reclaimed) revert Expired();
        if (hasClaimed[id][msg.sender]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, amount))));
        if (!MerkleProof.verifyCalldata(proof, d.root, leaf)) revert BadProof();
        if (d.claimed + amount > d.total) revert Exhausted();
        hasClaimed[id][msg.sender] = true;
        d.claimed += amount;
        emit DropClaimed(id, msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice After expiry the creator takes back whatever wasn't claimed.
    function reclaim(uint256 id) external nonReentrant {
        if (id >= drops.length) revert UnknownDrop();
        Drop storage d = drops[id];
        if (msg.sender != d.creator) revert NotCreator();
        if (block.timestamp < d.expiresAt) revert NotExpired();
        if (d.reclaimed) revert Expired();
        d.reclaimed = true;
        uint256 left = d.total - d.claimed;
        emit DropReclaimed(id, msg.sender, left);
        if (left != 0) {
            (bool ok,) = payable(msg.sender).call{value: left}("");
            if (!ok) revert TransferFailed();
        }
    }

    function dropCount() external view returns (uint256) {
        return drops.length;
    }
}

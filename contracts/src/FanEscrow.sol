// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IFanEscrow} from "./interfaces/IFanEscrow.sol";

/// @title FanEscrow
/// @notice Holds the 6% creator fee of unclaimed fan markets, per market, until the X account signs in
///         and SwayKeys.claimFanMarket hands the market over. Also holds each fan market's first key
///         (as a balance inside SwayKeys). The account behind a fan market does not run, endorse or
///         profit from it before it claims.
/// @dev UNAUDITED.
contract FanEscrow is IFanEscrow, Ownable2Step {
    address public keys;
    mapping(address subject => uint256) public escrowed;
    uint256 public totalEscrowed;

    event KeysSet(address keys);
    event Deposited(address indexed subject, uint256 amount);
    event Released(address indexed subject, uint256 amount);

    error NotKeys();
    error KeysAlreadySet();
    error ZeroAddress();
    error TransferFailed();

    modifier onlyKeys() {
        if (msg.sender != keys) revert NotKeys();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Set once, to the SwayKeys contract.
    function setKeys(address keys_) external onlyOwner {
        if (keys_ == address(0)) revert ZeroAddress();
        if (keys != address(0)) revert KeysAlreadySet();
        keys = keys_;
        emit KeysSet(keys_);
    }

    function deposit(address subject) external payable onlyKeys {
        escrowed[subject] += msg.value;
        totalEscrowed += msg.value;
        emit Deposited(subject, msg.value);
    }

    function release(address subject) external onlyKeys returns (uint256 amount) {
        amount = escrowed[subject];
        if (amount == 0) return 0;
        escrowed[subject] = 0;
        totalEscrowed -= amount;
        emit Released(subject, amount);
        (bool ok,) = payable(keys).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}

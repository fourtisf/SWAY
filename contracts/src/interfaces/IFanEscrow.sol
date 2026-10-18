// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IFanEscrow {
    /// @notice Escrows a creator fee for the fan market `subject`. Only SwayKeys calls this.
    function deposit(address subject) external payable;

    /// @notice Sends everything escrowed for `subject` back to SwayKeys and returns the amount.
    function release(address subject) external returns (uint256 amount);
}

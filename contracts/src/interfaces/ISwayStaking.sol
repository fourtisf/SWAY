// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ISwayStaking {
    /// @notice Staking level 0..4 of `account`. Each level cuts the protocol fee on its key trades.
    function levelOf(address account) external view returns (uint8);
}

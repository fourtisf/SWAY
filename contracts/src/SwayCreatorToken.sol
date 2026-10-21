// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title SwayCreatorToken
/// @notice Fixed-supply ERC-20 launched from a creator's reach. The whole supply is minted once to the
///         launchpad, which sells 90% on a curve and holds 10% for the creator's key holders.
/// @dev Until the curve graduates, only the launchpad can send tokens to the token's Uniswap pair: nobody can
///      seed the pool at a price of their choosing before the curve's liquidity moves there.
contract SwayCreatorToken is ERC20 {
    address public immutable creator;
    address public immutable launchpad;
    address public pair;
    bool public pairOpen;

    error OnlyLaunchpad();
    error PairNotOpen();

    constructor(string memory name_, string memory symbol_, address creator_, address launchpad_, uint256 supply)
        ERC20(name_, symbol_)
    {
        creator = creator_;
        launchpad = launchpad_;
        _mint(launchpad_, supply);
    }

    /// @notice Set once by the launchpad, right after it creates the pair.
    function setPair(address pair_) external {
        if (msg.sender != launchpad || pair != address(0)) revert OnlyLaunchpad();
        pair = pair_;
    }

    /// @notice Called by the launchpad once the pool holds the curve's liquidity.
    function openPair() external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        pairOpen = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to == pair && to != address(0) && !pairOpen && from != launchpad) revert PairNotOpen();
        super._update(from, to, value);
    }
}

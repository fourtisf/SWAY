// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title SwayCreatorToken
/// @notice Fixed-supply ERC-20 launched from a creator's reach. The whole supply is minted once to the
///         launchpad, which sells 90% on a curve and holds 10% for the creator's key holders.
contract SwayCreatorToken is ERC20 {
    address public immutable creator;

    constructor(string memory name_, string memory symbol_, address creator_, address mintTo, uint256 supply)
        ERC20(name_, symbol_)
    {
        creator = creator_;
        _mint(mintTo, supply);
    }
}

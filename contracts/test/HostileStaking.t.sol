// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Base} from "./utils/Base.sol";

/// Staking contracts a compromised owner could plug in: none may stop a holder from selling.
contract GasBurner {
    function levelOf(address) external view returns (uint8) {
        uint256 i;
        while (gasleft() > 1_000) i++;
        return uint8(i);
    }
}

contract ReturnBomb {
    function levelOf(address) external pure returns (uint8) {
        assembly {
            return(0, 100000)
        }
    }
}

contract OutOfRange {
    function levelOf(address) external pure returns (uint256) {
        return 99;
    }
}

contract Reverter {
    function levelOf(address) external pure returns (uint8) {
        revert("no");
    }
}

contract HostileStakingTest is Base {
    function _sellsUnder(address hostile) internal {
        _buy(bob, alice, 300);
        vm.warp(block.timestamp + 2 days);
        vm.prank(admin);
        keys.setStaking(hostile);
        assertEq(keys.levelOf(bob), 0, "hostile answers read as level 0");
        uint256 before = bob.balance;
        uint256 got = _sell(bob, alice, 300);
        assertGt(got, 0);
        assertEq(bob.balance - before, got, "the sell paid out");
        _buy(carol, alice, 100); // buys keep working too
    }

    function test_sellsSurviveGasBurner() public {
        _sellsUnder(address(new GasBurner()));
    }

    function test_sellsSurviveReturnBomb() public {
        _sellsUnder(address(new ReturnBomb()));
    }

    function test_sellsSurviveOutOfRangeLevel() public {
        _sellsUnder(address(new OutOfRange()));
    }

    function test_sellsSurviveRevertingStaking() public {
        _sellsUnder(address(new Reverter()));
    }
}

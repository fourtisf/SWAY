// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwayKeys} from "../src/SwayKeys.sol";
import {SwayStaking} from "../src/SwayStaking.sol";
import {Base} from "./utils/Base.sol";

contract TestSway is ERC20 {
    constructor() ERC20("Sway", "SWAY") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract SwayStakingTest is Base {
    SwayStaking internal st;
    TestSway internal sway;

    function setUp() public override {
        super.setUp();
        sway = new TestSway();
        st = new SwayStaking(admin, IERC20(address(sway)), [uint256(1_000 ether), 10_000 ether, 50_000 ether, 250_000 ether]);
        vm.startPrank(admin);
        st.setKeys(address(keys));
        keys.setStaking(address(st));
        vm.stopPrank();
        for (uint256 i; i < 3; ++i) {
            address a = [bob, carol, dave][i];
            sway.mint(a, 1_000_000 ether);
            vm.prank(a);
            sway.approve(address(st), type(uint256).max);
        }
    }

    function test_levels() public {
        assertEq(st.levelOf(bob), 0);
        vm.prank(bob);
        st.stake(1_000 ether);
        assertEq(st.levelOf(bob), 1);
        vm.prank(bob);
        st.stake(49_000 ether);
        assertEq(st.levelOf(bob), 3);
        assertEq(keys.levelOf(bob), 3, "SwayKeys reads the level");
        (,, uint256 protocolFee,,,) = keys.quote(alice, 100, true, bob);
        (uint256 base,,,,,) = keys.quote(alice, 100, true, bob);
        assertEq(protocolFee, base * 200 * 5_000 / 1e8, "Tempo cuts the protocol fee by 50%");
    }

    function test_unstakeDropsLevelNow_withdrawAfterCooldown() public {
        vm.startPrank(bob);
        st.stake(10_000 ether);
        assertEq(st.levelOf(bob), 2);
        st.requestUnstake(9_500 ether);
        assertEq(st.levelOf(bob), 0);
        vm.expectRevert(SwayStaking.StillCoolingDown.selector);
        st.withdraw();
        vm.warp(block.timestamp + 7 days);
        uint256 before = sway.balanceOf(bob);
        st.withdraw();
        assertEq(sway.balanceOf(bob) - before, 9_500 ether);
        vm.stopPrank();
    }

    function test_rewardsFromProtocolFee_proRata() public {
        vm.prank(bob);
        st.stake(1_000 ether);
        vm.prank(carol);
        st.stake(3_000 ether);

        _buy(dave, alice, 500);
        (,,, uint256 stakerShare) = keys.earnings(address(st));
        assertGt(stakerShare, 0);
        uint256 harvested = st.harvest();
        assertEq(harvested, stakerShare);
        assertApproxEqAbs(st.pendingRewards(bob), stakerShare / 4, 1);
        assertApproxEqAbs(st.pendingRewards(carol), stakerShare * 3 / 4, 1);

        uint256 before = carol.balance;
        vm.prank(carol);
        st.claimRewards();
        assertApproxEqAbs(carol.balance - before, stakerShare * 3 / 4, 1);
    }

    function test_rewardsWithNoStakersWait() public {
        _buy(dave, alice, 200);
        uint256 h = st.harvest();
        assertGt(h, 0);
        assertEq(st.undistributed(), h);
        vm.prank(bob);
        st.stake(1_000 ether);
        st.harvest();
        assertApproxEqAbs(st.pendingRewards(bob), h, 1);
    }

    function test_rejectsStrayEthAndBadThresholds() public {
        (bool ok,) = address(st).call{value: 1}("");
        assertFalse(ok);
        vm.prank(admin);
        vm.expectRevert(SwayStaking.BadThresholds.selector);
        st.setThresholds([uint256(10), 5, 20, 30]);
    }
}

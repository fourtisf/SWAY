// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SwayKeys} from "../../src/SwayKeys.sol";
import {FanEscrow} from "../../src/FanEscrow.sol";
import {MockStaking, SwayKeysHarness} from "../utils/Base.sol";

contract KeysHandler is Test {
    SwayKeysHarness public keys;
    FanEscrow public escrow;
    MockStaking public staking;
    address public treasury;
    address public operator;
    address[] public actors;
    address[] public subjects;
    address public fanSubject;
    bool public fanClaimed;
    uint256 public trades;

    constructor(SwayKeysHarness k, FanEscrow e, MockStaking s, address t, address op, address[] memory a, address[] memory subs, address fan) {
        keys = k;
        escrow = e;
        staking = s;
        treasury = t;
        operator = op;
        actors = a;
        subjects = subs;
        fanSubject = fan;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function subjectCount() external view returns (uint256) {
        return subjects.length;
    }

    function buy(uint256 a, uint256 s, uint256 units, uint8 level) external {
        address actor = actors[a % actors.length];
        address subject = subjects[s % subjects.length];
        units = bound(units, 1, 1_500);
        staking.set(actor, uint8(bound(level, 0, 4)));
        (,,,,, uint256 total) = keys.quote(subject, units, true, actor);
        vm.deal(actor, actor.balance + total + 1 ether);
        vm.prank(actor);
        try keys.buy{value: total + 1 ether}(subject, units) {
            trades++;
        } catch {}
    }

    function sell(uint256 a, uint256 s, uint256 units) external {
        address actor = actors[a % actors.length];
        address subject = subjects[s % subjects.length];
        (address owner_,,,,,,,) = keys.markets(subject);
        uint256 bal = keys.balanceOf(subject, actor);
        uint256 locked = actor == owner_ ? 100 : 0;
        if (bal <= locked) return;
        units = bound(units, 1, bal - locked);
        vm.prank(actor);
        keys.sell(subject, units, 0);
        trades++;
    }

    function claim(uint256 a) external {
        address actor = actors[a % actors.length];
        vm.prank(actor);
        try keys.claim(subjects) {} catch {}
    }

    function pullProtocol(bool toTreasury) external {
        vm.prank(toTreasury ? treasury : address(staking));
        try keys.claim(new address[](0)) {} catch {}
    }

    function claimFan(uint256 a) external {
        if (fanClaimed) return;
        fanClaimed = true;
        vm.prank(operator);
        keys.claimFanMarket(fanSubject, actors[a % actors.length]);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 2 hours));
    }
}

contract SwayKeysInvariantTest is Test {
    SwayKeysHarness internal keys;
    FanEscrow internal escrow;
    MockStaking internal staking;
    KeysHandler internal handler;
    address internal treasury = makeAddr("treasury");
    address internal operator = makeAddr("operator");
    address[] internal actors;
    address[] internal subjects;

    function setUp() public {
        address admin = makeAddr("admin");
        keys = new SwayKeysHarness(admin, treasury);
        escrow = new FanEscrow(admin);
        staking = new MockStaking();
        vm.startPrank(admin);
        keys.setOperator(operator, true);
        keys.setFanAdmin(admin, true);
        keys.setFanEscrow(address(escrow));
        escrow.setKeys(address(keys));
        keys.setStaking(address(staking));
        address fan = keys.openFanMarket(424242);
        vm.stopPrank();

        for (uint256 i; i < 5; ++i) actors.push(makeAddr(string.concat("actor", vm.toString(i))));
        vm.startPrank(operator);
        keys.openMarket(actors[0], 1);
        keys.openMarket(actors[1], 2);
        keys.setReferrer(actors[2], actors[0]);
        keys.setReferrer(actors[0], actors[3]);
        vm.stopPrank();
        subjects.push(actors[0]);
        subjects.push(actors[1]);
        subjects.push(fan);

        handler = new KeysHandler(keys, escrow, staking, treasury, operator, actors, subjects, fan);
        targetContract(address(handler));
    }

    function _accounts() internal view returns (address[] memory a) {
        a = new address[](actors.length + 3);
        for (uint256 i; i < actors.length; ++i) a[i] = actors[i];
        a[actors.length] = treasury;
        a[actors.length + 1] = address(staking);
        a[actors.length + 2] = address(escrow);
    }

    function _owed() internal view returns (uint256 owed) {
        address[] memory acc = _accounts();
        for (uint256 i; i < acc.length; ++i) {
            (uint256 c, uint256 h, uint256 r, uint256 p) = keys.earnings(acc[i]);
            owed += c + h + r + p;
            for (uint256 j; j < subjects.length; ++j) owed += keys.pendingHolderReward(subjects[j], acc[i]);
        }
        for (uint256 j; j < subjects.length; ++j) {
            (,,,,,, uint256 supply,) = keys.markets(subjects[j]);
            owed += keys.cumulative(supply) - keys.cumulative(100);
        }
    }

    /// The contract always holds every reserve plus everything it owes.
    function invariant_solvent() public view {
        uint256 owed = _owed();
        assertGe(address(keys).balance, owed);
        // what's left over is accumulator rounding dust, a few wei per trade at most
        assertLe(address(keys).balance - owed, (handler.trades() + 1) * 8);
    }

    function invariant_supplyEqualsBalances() public view {
        address[] memory acc = _accounts();
        for (uint256 j; j < subjects.length; ++j) {
            uint256 sum;
            for (uint256 i; i < acc.length; ++i) sum += keys.balanceOf(subjects[j], acc[i]);
            (,,,,,, uint256 supply,) = keys.markets(subjects[j]);
            assertEq(sum, supply);
        }
    }

    function invariant_firstKeyNeverLeaves() public view {
        for (uint256 j; j < subjects.length; ++j) {
            (address owner_,,,,,,,) = keys.markets(subjects[j]);
            address lockHolder = owner_ == address(0) ? address(escrow) : owner_;
            assertGe(keys.balanceOf(subjects[j], lockHolder), 100);
        }
    }

    function invariant_escrowBacked() public view {
        assertEq(address(escrow).balance, escrow.totalEscrowed());
        if (handler.fanClaimed()) assertEq(escrow.escrowed(subjects[2]), 0);
    }
}

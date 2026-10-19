// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SwayKeys} from "../../src/SwayKeys.sol";
import {FanEscrow} from "../../src/FanEscrow.sol";
import {ISwayStaking} from "../../src/interfaces/ISwayStaking.sol";

contract MockStaking is ISwayStaking {
    mapping(address => uint8) public level;

    function set(address account, uint8 l) external {
        level[account] = l;
    }

    function levelOf(address account) external view returns (uint8) {
        return level[account];
    }

    function pull(SwayKeys keys) external {
        keys.claim(new address[](0));
    }

    receive() external payable {}
}

/// @dev Exposes state setters so tests can start a market at any supply.
contract SwayKeysHarness is SwayKeys {
    constructor(address o, address t) SwayKeys(o, t) {}

    function harnessMint(address subject, address holder, uint256 units) external {
        _settle(subject, holder);
        markets[subject].supply += units;
        balanceOf[subject][holder] += units;
    }

    function harnessSetLastBuy(address subject, address holder, uint256 ts) external {
        lastBuyAt[subject][holder] = uint40(ts);
    }

    function harnessEndSnipeWindow(address subject) external {
        markets[subject].firstTradeAt = 1;
    }
}

abstract contract Base is Test {
    SwayKeysHarness internal keys;
    FanEscrow internal escrow;
    MockStaking internal staking;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal operator = makeAddr("operator");
    address internal fanAdmin = makeAddr("fanAdmin");
    address internal alice = makeAddr("alice"); // creator with an open market
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");

    uint64 internal constant ALICE_XID = 1001;

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        keys = new SwayKeysHarness(admin, treasury);
        escrow = new FanEscrow(admin);
        staking = new MockStaking();
        vm.startPrank(admin);
        keys.setOperator(operator, true);
        keys.setFanAdmin(fanAdmin, true);
        keys.setFanEscrow(address(escrow));
        escrow.setKeys(address(keys));
        keys.setStaking(address(staking));
        vm.stopPrank();

        vm.prank(operator);
        keys.openMarket(alice, ALICE_XID);

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
        vm.deal(dave, 1_000 ether);
    }

    function _quote(address subject, uint256 units, bool isBuy, address trader)
        internal
        view
        returns (uint256 base, uint256 total)
    {
        (base,,,,, total) = keys.quote(subject, units, isBuy, trader);
    }

    function _buy(address trader, address subject, uint256 units) internal returns (uint256 total) {
        (, total) = _quote(subject, units, true, trader);
        vm.prank(trader);
        keys.buy{value: total}(subject, units);
    }

    function _sell(address trader, address subject, uint256 units) internal returns (uint256 proceeds) {
        uint256 before = trader.balance;
        vm.prank(trader);
        keys.sell(subject, units, 0);
        proceeds = trader.balance - before;
    }

    function _earnings(address a) internal view returns (uint256 creator, uint256 holder, uint256 referral, uint256 protocol) {
        (creator, holder, referral, protocol) = keys.earnings(a);
    }

    function _reserve(uint256 supply) internal view returns (uint256) {
        return keys.cumulative(supply) - keys.cumulative(100);
    }
}

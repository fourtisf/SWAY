// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Base} from "./utils/Base.sol";

/// @notice Differential test: replays quotes computed by packages/curve (TypeScript, bigint) through real
///         buy/sell calls and requires every amount to match to the wei.
///         Regenerate the vectors with `pnpm vectors` after changing either side.
contract CurveVectorsTest is Base {
    struct V {
        uint256[] supply;
        uint256[] units;
        bool[] isBuy;
        uint256[] level;
        bool[] traderRef;
        bool[] creatorRef;
        uint256[] base;
        uint256[] creatorFee;
        uint256[] protocolFee;
        uint256[] holderFee;
        uint256[] referralFee;
        uint256[] protocolTotal;
        uint256[] total;
    }

    function _load() internal view returns (V memory v) {
        string memory json = vm.readFile("test/vectors/curve.json");
        v.supply = vm.parseJsonUintArray(json, ".supply");
        v.units = vm.parseJsonUintArray(json, ".units");
        v.isBuy = vm.parseJsonBoolArray(json, ".isBuy");
        v.level = vm.parseJsonUintArray(json, ".level");
        v.traderRef = vm.parseJsonBoolArray(json, ".traderRef");
        v.creatorRef = vm.parseJsonBoolArray(json, ".creatorRef");
        v.base = vm.parseJsonUintArray(json, ".base");
        v.creatorFee = vm.parseJsonUintArray(json, ".creatorFee");
        v.protocolFee = vm.parseJsonUintArray(json, ".protocolFee");
        v.holderFee = vm.parseJsonUintArray(json, ".holderFee");
        v.referralFee = vm.parseJsonUintArray(json, ".referralFee");
        v.protocolTotal = vm.parseJsonUintArray(json, ".protocolTotal");
        v.total = vm.parseJsonUintArray(json, ".total");
    }

    function test_vectorsMatchContract() public {
        V memory v = _load();
        assertGt(v.supply.length, 100);
        for (uint256 i; i < v.supply.length; ++i) {
            _check(v, i);
        }
    }

    function _protocolBalance() internal view returns (uint256) {
        (,,, uint256 s) = keys.earnings(address(staking));
        (,,, uint256 t) = keys.earnings(treasury);
        return s + t;
    }

    function _check(V memory v, uint256 i) internal {
        (address creator, address trader) = _arrange(v, i);
        _assertQuote(v, i, creator, trader);
        _execute(v, i, creator, trader);
    }

    function _arrange(V memory v, uint256 i) internal returns (address creator, address trader) {
        creator = address(uint160(0x10000 + i));
        trader = address(uint160(0x20000 + i));
        address whale = address(uint160(0x30000 + i));
        vm.prank(operator);
        keys.openMarket(creator, uint64(10_000 + i));
        keys.harnessEndSnipeWindow(creator);
        uint256 supply = v.supply[i];
        uint256 units = v.units[i];
        if (v.isBuy[i]) {
            if (supply > 100) keys.harnessMint(creator, whale, supply - 100);
        } else {
            // the trader holds what it sells; any remainder above the locked key sits with a whale
            keys.harnessMint(creator, trader, units);
            if (supply - 100 > units) keys.harnessMint(creator, whale, supply - 100 - units);
            vm.deal(address(keys), address(keys).balance + _reserve(supply));
        }
        staking.set(trader, uint8(v.level[i]));
        vm.startPrank(operator);
        if (v.traderRef[i]) keys.setReferrer(trader, address(uint160(0x40000 + i)));
        if (v.creatorRef[i]) keys.setReferrer(creator, address(uint160(0x50000 + i)));
        vm.stopPrank();
    }

    function _assertQuote(V memory v, uint256 i, address creator, address trader) internal view {
        (uint256 base, uint256 cf, uint256 pf, uint256 hf, uint256 rf, uint256 total) =
            keys.quote(creator, v.units[i], v.isBuy[i], trader);
        assertEq(base, v.base[i], "base");
        assertEq(cf, v.creatorFee[i], "creatorFee");
        assertEq(pf, v.protocolFee[i], "protocolFee");
        assertEq(hf, v.holderFee[i], "holderFee");
        assertEq(rf, v.referralFee[i], "referralFee");
        assertEq(total, v.total[i], "total");
    }

    function _execute(V memory v, uint256 i, address creator, address trader) internal {
        uint256 total = v.total[i];
        uint256 protoBefore = _protocolBalance();
        if (v.isBuy[i]) {
            vm.deal(trader, total);
            vm.prank(trader);
            keys.buy{value: total}(creator, v.units[i]);
            assertEq(trader.balance, 0, "paid exactly total");
        } else {
            vm.prank(trader);
            keys.sell(creator, v.units[i], total);
            assertEq(trader.balance, total, "received exactly total");
        }
        (uint256 creatorEarned,,,) = keys.earnings(creator);
        assertEq(creatorEarned, v.creatorFee[i], "creator credited");
        assertEq(_protocolBalance() - protoBefore, v.protocolTotal[i], "protocol credited");
        (,, uint256 rt,) = keys.earnings(address(uint160(0x40000 + i)));
        (,, uint256 rc,) = keys.earnings(address(uint160(0x50000 + i)));
        assertEq(rt + rc + v.protocolTotal[i] - v.protocolFee[i], v.referralFee[i], "referral split");
    }
}

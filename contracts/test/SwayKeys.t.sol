// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {SwayKeys} from "../src/SwayKeys.sol";
import {FanEscrow} from "../src/FanEscrow.sol";
import {Base} from "./utils/Base.sol";

contract SwayKeysTest is Base {
    /* ------------------------------------------------------------ curve */

    function test_referencePrices() public view {
        assertEq(keys.priceAt(100), 157_500_000_000_000); // first key 0.0001575 ETH
        assertEq(keys.priceAt(1_000), 2_520_000_000_000_000); // 10th 0.00252 ETH
        assertEq(keys.priceAt(10_000), 182_070_000_000_000_000); // 100th 0.18207 ETH
    }

    function test_fanSubjectMatchesTypescript() public view {
        // packages/shared fanSubject(44196397n) and fanSubject(1n)
        assertEq(keys.fanSubject(44196397), 0x9Ef4E0A4E2F666F2eb3bB533ce13645F2529979E);
        assertEq(keys.fanSubject(1), 0x7a6C33F44683ffa686060D66DB2D5586b4ed9ae0);
    }

    /* ------------------------------------------------------------ markets */

    function test_openMarket_mintsLockedFirstKey() public {
        (address owner_, uint64 xId,,, bool fan,, uint256 supply,) = keys.markets(alice);
        assertEq(owner_, alice);
        assertEq(xId, ALICE_XID);
        assertFalse(fan);
        assertEq(supply, 100);
        assertEq(keys.balanceOf(alice, alice), 100);
        assertEq(keys.subjectOfXId(ALICE_XID), alice);

        vm.expectEmit(true, true, true, true);
        emit SwayKeys.MarketOpened(bob, bob, 7, false);
        vm.prank(operator);
        keys.openMarket(bob, 7);
    }

    function test_openMarket_rules() public {
        vm.expectRevert(SwayKeys.NotOperator.selector);
        keys.openMarket(bob, 7);

        vm.startPrank(operator);
        vm.expectRevert(SwayKeys.MarketExists.selector);
        keys.openMarket(alice, 8);
        vm.expectRevert(SwayKeys.XIdTaken.selector);
        keys.openMarket(bob, ALICE_XID);
        vm.expectRevert(SwayKeys.InvalidXId.selector);
        keys.openMarket(bob, 0);
        vm.expectRevert(SwayKeys.ZeroAddress.selector);
        keys.openMarket(address(0), 9);
        vm.stopPrank();
    }

    /* ------------------------------------------------------------ buy / sell */

    function test_buy_paysCurvePlusFees_andRefundsChange() public {
        uint256 base = keys.cumulative(200) - keys.cumulative(100);
        uint256 creatorFee = base * 600 / 10_000;
        uint256 protocolFee = base * 200 / 10_000;
        uint256 holderFee = base * 100 / 10_000;
        uint256 referralFee = base * 100 / 10_000;
        uint256 total = base + creatorFee + protocolFee + holderFee + referralFee;

        uint256 before = bob.balance;
        vm.expectEmit(true, true, false, true);
        emit SwayKeys.Trade(bob, alice, true, 100, base, creatorFee, protocolFee, holderFee, referralFee, 200);
        vm.prank(bob);
        keys.buy{value: total + 1 ether}(alice, 100);

        assertEq(before - bob.balance, total, "change refunded");
        assertEq(keys.balanceOf(alice, bob), 100);
        (,,,,,, uint256 supply,) = keys.markets(alice);
        assertEq(supply, 200);

        (uint256 creator,,,) = _earnings(alice);
        assertEq(creator, creatorFee);
        // no referrers: the whole 1% joins protocol, split half stakers / half treasury
        uint256 protocolTotal = protocolFee + referralFee;
        (,,, uint256 stakers) = _earnings(address(staking));
        (,,, uint256 treas) = _earnings(treasury);
        assertEq(stakers, protocolTotal / 2);
        assertEq(treas, protocolTotal - protocolTotal / 2);
        // alice held all 100 units before the buy, so she gets the whole holder fee
        assertApproxEqAbs(keys.pendingHolderReward(alice, alice), holderFee, 1);
        assertEq(keys.pendingHolderReward(alice, bob), 0);
    }

    function test_buy_insufficientPayment() public {
        (, uint256 total) = _quote(alice, 50, true, bob);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SwayKeys.InsufficientPayment.selector, total, total - 1));
        keys.buy{value: total - 1}(alice, 50);
    }

    function test_buy_rejectsUnopenedMarketAndZeroUnits() public {
        vm.startPrank(bob);
        vm.expectRevert(SwayKeys.MarketNotOpen.selector);
        keys.buy{value: 1 ether}(carol, 1);
        vm.expectRevert(SwayKeys.ZeroUnits.selector);
        keys.buy{value: 1 ether}(alice, 0);
        vm.stopPrank();
    }

    function test_sell_paysCurveMinusFees() public {
        _buy(bob, alice, 300);
        vm.warp(block.timestamp + 24 hours); // past the anti-dump window
        uint256 base = keys.cumulative(400) - keys.cumulative(300);
        uint256 fees = base * 600 / 10_000 + base * 200 / 10_000 + base * 100 / 10_000 + base * 100 / 10_000;
        uint256 got = _sell(bob, alice, 100);
        assertEq(got, base - fees);
        assertEq(keys.balanceOf(alice, bob), 200);
    }

    function test_sell_slippage() public {
        _buy(bob, alice, 100);
        (, uint256 proceeds) = _quote(alice, 100, false, bob);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SwayKeys.Slippage.selector, proceeds, proceeds + 1));
        keys.sell(alice, 100, proceeds + 1);
    }

    function test_creatorCannotSellFirstKey() public {
        vm.prank(alice);
        vm.expectRevert(SwayKeys.InsufficientKeys.selector);
        keys.sell(alice, 1, 0);

        _buy(alice, alice, 50); // the creator can trade keys above the locked one
        _sell(alice, alice, 50);
        assertEq(keys.balanceOf(alice, alice), 100);
        vm.prank(alice);
        vm.expectRevert(SwayKeys.InsufficientKeys.selector);
        keys.sell(alice, 1, 0);
    }

    function test_cannotSellMoreThanHeld() public {
        _buy(bob, alice, 100);
        vm.prank(bob);
        vm.expectRevert(SwayKeys.InsufficientKeys.selector);
        keys.sell(alice, 101, 0);
    }

    function test_fullExit_leavesNoReserve() public {
        _buy(bob, alice, 250);
        _buy(carol, alice, 400);
        _buy(dave, alice, 1);
        _sell(carol, alice, 400);
        _sell(bob, alice, 250);
        _sell(dave, alice, 1);
        (,,,,,, uint256 supply,) = keys.markets(alice);
        assertEq(supply, 100);
        // everything left in the contract is claimable earnings or holder-reward rounding dust
        uint256 owed = _owedTotal();
        assertGe(address(keys).balance, owed);
        assertLe(address(keys).balance - owed, 10);
    }

    /* ------------------------------------------------------------ anti-snipe */

    function test_antiSnipe_capsFirstFiveMinutes() public {
        _buy(bob, alice, 1_000); // exactly 10 keys is fine
        (, uint256 total) = _quote(alice, 1, true, bob);
        vm.prank(bob);
        vm.expectRevert(SwayKeys.SnipeLimit.selector);
        keys.buy{value: total}(alice, 1);

        vm.warp(block.timestamp + 5 minutes);
        _buy(bob, alice, 1);
        assertEq(keys.balanceOf(alice, bob), 1_001);
    }

    function test_antiSnipe_windowStartsAtFirstTrade() public {
        vm.warp(block.timestamp + 1 days); // opened long ago, but nobody traded yet
        _buy(carol, alice, 10);
        (, uint256 total) = _quote(alice, 1_001, true, bob);
        vm.prank(bob);
        vm.expectRevert(SwayKeys.SnipeLimit.selector);
        keys.buy{value: total}(alice, 1_001);
    }

    /* ------------------------------------------------------------ fees: referrals, staking */

    function test_referralHalves() public {
        vm.startPrank(operator);
        keys.setReferrer(bob, carol); // trader's referrer
        keys.setReferrer(alice, dave); // creator's referrer
        vm.stopPrank();
        (uint256 base,) = _quote(alice, 100, true, bob);
        _buy(bob, alice, 100);
        uint256 referral = base * 100 / 10_000;
        (,, uint256 c,) = _earnings(carol);
        (,, uint256 d,) = _earnings(dave);
        assertEq(c, referral / 2);
        assertEq(d, referral - referral / 2);
        uint256 protocolFee = base * 200 / 10_000;
        (,,, uint256 stakers) = _earnings(address(staking));
        (,,, uint256 treas) = _earnings(treasury);
        assertEq(stakers + treas, protocolFee);
    }

    function test_referrerRules() public {
        vm.startPrank(operator);
        keys.setReferrer(bob, carol);
        vm.expectRevert(SwayKeys.ReferrerAlreadySet.selector);
        keys.setReferrer(bob, dave);
        vm.expectRevert(SwayKeys.InvalidReferrer.selector);
        keys.setReferrer(carol, carol);
        vm.expectRevert(SwayKeys.InvalidReferrer.selector);
        keys.setReferrer(carol, address(0));
        vm.stopPrank();
        vm.expectRevert(SwayKeys.NotOperator.selector);
        keys.setReferrer(dave, bob);
    }

    function test_stakingLevelCutsProtocolFeeOnly() public {
        uint8[5] memory levels = [0, 1, 2, 3, 4];
        uint256[5] memory cut = [uint256(0), 1_000, 2_500, 5_000, 7_500];
        for (uint256 i; i < 5; ++i) {
            staking.set(bob, levels[i]);
            (uint256 base, uint256 creatorFee, uint256 protocolFee, uint256 holderFee, uint256 referralFee, uint256 total) =
                keys.quote(alice, 100, true, bob);
            assertEq(creatorFee, base * 600 / 10_000);
            assertEq(holderFee, base * 100 / 10_000);
            assertEq(referralFee, base * 100 / 10_000);
            assertEq(protocolFee, base * 200 * (10_000 - cut[i]) / 1e8);
            assertEq(total, base + creatorFee + protocolFee + holderFee + referralFee);
        }
    }

    /* ------------------------------------------------------------ holder rewards */

    function test_holderRewards_proRata() public {
        _buy(bob, alice, 100); // fee to alice (100 of 100)
        (uint256 base2,) = _quote(alice, 200, true, carol);
        _buy(carol, alice, 200); // fee over 200 units: alice 100, bob 100
        uint256 fee2 = base2 * 100 / 10_000;
        assertApproxEqAbs(keys.pendingHolderReward(alice, bob), fee2 / 2, 1);
        assertEq(keys.pendingHolderReward(alice, carol), 0, "buyer earns nothing from own buy");

        // carol sells 100 after the anti-dump window: fee goes to holders after the sell: alice, bob, carol 100 each
        vm.warp(block.timestamp + 24 hours);
        (uint256 base3,) = _quote(alice, 100, false, carol);
        _sell(carol, alice, 100);
        uint256 fee3 = base3 * 100 / 10_000;
        assertApproxEqAbs(keys.pendingHolderReward(alice, carol), fee3 / 3, 1);
        assertApproxEqAbs(keys.pendingHolderReward(alice, bob), fee2 / 2 + fee3 / 3, 2);

        // claim settles holder rewards for the given subjects
        address[] memory subjects = new address[](1);
        subjects[0] = alice;
        uint256 expected = keys.pendingHolderReward(alice, bob);
        uint256 before = bob.balance;
        vm.prank(bob);
        keys.claim(subjects);
        assertEq(bob.balance - before, expected);
        assertEq(keys.pendingHolderReward(alice, bob), 0);
    }

    function test_claim_everything_and_nothingLeft() public {
        vm.prank(operator);
        keys.setReferrer(bob, carol);
        _buy(bob, alice, 500);
        vm.warp(block.timestamp + 6 minutes);
        _buy(dave, alice, 700);

        address[] memory subjects = new address[](1);
        subjects[0] = alice;
        (uint256 cr, uint256 ho, uint256 re, uint256 pr) = keys.claimable(alice, subjects);
        uint256 before = alice.balance;
        vm.expectEmit(true, false, false, true);
        emit SwayKeys.Claimed(alice, cr, ho, re, pr);
        vm.prank(alice);
        uint256 paid = keys.claim(subjects);
        assertEq(paid, cr + ho + re + pr);
        assertEq(alice.balance - before, paid);

        vm.prank(alice);
        vm.expectRevert(SwayKeys.NothingToClaim.selector);
        keys.claim(subjects);

        // treasury and the staking contract pull the protocol share the same way
        uint256 tBefore = treasury.balance;
        vm.prank(treasury);
        keys.claim(new address[](0));
        assertGt(treasury.balance, tBefore);
        uint256 sBefore = address(staking).balance;
        staking.pull(keys);
        assertGt(address(staking).balance, sBefore);
    }

    /* ------------------------------------------------------------ fan markets */

    function _openFan(uint64 xId) internal returns (address subject) {
        vm.prank(fanAdmin);
        subject = keys.openFanMarket(xId);
    }

    function test_fanMarket_escrowsCreatorFee_untilClaim() public {
        address subject = _openFan(5005);
        assertEq(subject, keys.fanSubject(5005));
        assertEq(keys.balanceOf(subject, address(escrow)), 100);

        (uint256 base,) = _quote(subject, 300, true, bob);
        _buy(bob, subject, 300);
        uint256 creatorFee = base * 600 / 10_000;
        assertEq(escrow.escrowed(subject), creatorFee);
        assertEq(address(escrow).balance, creatorFee);

        // bob can sell freely; the escrow's first key stays put
        _sell(bob, subject, 100);
        uint256 escrowed = escrow.escrowed(subject);
        assertGt(escrowed, creatorFee);
        uint256 escrowHolderReward = keys.pendingHolderReward(subject, address(escrow));
        assertGt(escrowHolderReward, 0);

        // claim: dave proves the X account. He gets the first key, its holder rewards and the escrow
        vm.expectEmit(true, true, false, true);
        emit SwayKeys.FanMarketClaimed(subject, dave, escrowed);
        vm.prank(operator);
        keys.claimFanMarket(subject, dave);

        (address owner_,,,, bool fan,,,) = keys.markets(subject);
        assertEq(owner_, dave);
        assertTrue(fan);
        assertEq(keys.balanceOf(subject, dave), 100);
        assertEq(keys.balanceOf(subject, address(escrow)), 0);
        assertEq(keys.balanceOf(subject, bob), 200, "holders keep their keys");
        assertEq(escrow.escrowed(subject), 0);
        (uint256 creator, uint256 holder,,) = _earnings(dave);
        assertEq(creator, escrowed);
        assertEq(holder, escrowHolderReward);

        // now creator fees go to dave, and dave can't sell the locked key
        (uint256 base2,) = _quote(subject, 100, true, carol);
        _buy(carol, subject, 100);
        (uint256 creator2,,,) = _earnings(dave);
        assertEq(creator2 - creator, base2 * 600 / 10_000);
        vm.prank(dave);
        vm.expectRevert(SwayKeys.InsufficientKeys.selector);
        keys.sell(subject, 1, 0);

        vm.prank(operator);
        vm.expectRevert(SwayKeys.AlreadyClaimed.selector);
        keys.claimFanMarket(subject, carol);
    }

    function test_fanMarket_claimerWhoAlreadyHeldKeys() public {
        address subject = _openFan(6006);
        _buy(dave, subject, 150);
        _buy(bob, subject, 100); // dave earns holder fee on his 150
        uint256 davePending = keys.pendingHolderReward(subject, dave);
        uint256 escrowPending = keys.pendingHolderReward(subject, address(escrow));
        vm.prank(operator);
        keys.claimFanMarket(subject, dave);
        assertEq(keys.balanceOf(subject, dave), 250);
        (, uint256 holder,,) = _earnings(dave);
        assertEq(holder, davePending + escrowPending, "own rewards + the first key's rewards");
        vm.prank(dave);
        keys.sell(subject, 150, 0); // can sell what he bought, not the locked key
        vm.prank(dave);
        vm.expectRevert(SwayKeys.InsufficientKeys.selector);
        keys.sell(subject, 1, 0);
    }

    function test_fanMarket_rules() public {
        vm.expectRevert(SwayKeys.NotFanAdmin.selector);
        keys.openFanMarket(1);
        _openFan(7007);
        vm.prank(fanAdmin);
        vm.expectRevert(SwayKeys.XIdTaken.selector);
        keys.openFanMarket(7007);
        vm.prank(operator);
        vm.expectRevert(SwayKeys.XIdTaken.selector);
        keys.openMarket(bob, 7007); // a member whose fan market exists must claim it instead
        vm.prank(operator);
        vm.expectRevert(SwayKeys.NotFanMarket.selector);
        keys.claimFanMarket(alice, bob);
    }

    function test_brokenStakingNeverBlocksTrades() public {
        BrokenStaking broken = new BrokenStaking();
        vm.prank(admin);
        keys.setStaking(address(broken));
        assertEq(keys.levelOf(bob), 0);
        _buy(bob, alice, 100);
        assertEq(keys.balanceOf(alice, bob), 100);
    }

    function test_fanClaimRejectsEscrowAsOwner() public {
        address subject = _openFan(8008);
        vm.prank(operator);
        vm.expectRevert(SwayKeys.ZeroAddress.selector);
        keys.claimFanMarket(subject, address(escrow));
    }

    /* ------------------------------------------------------------ activity bond & anti-dump */

    function test_inactiveCreatorFeeGoesToHolders() public {
        _buy(bob, alice, 100);
        vm.warp(block.timestamp + 6 minutes);
        vm.expectEmit(true, false, false, true);
        emit SwayKeys.CreatorInactiveSet(alice, true);
        vm.prank(operator);
        keys.setCreatorInactive(alice, true);
        (uint256 creatorBefore,,,) = _earnings(alice);
        vm.prank(operator);
        keys.setCreatorInactive(alice, false);
        (,,,,, uint256 totalActive) = keys.quote(alice, 200, true, carol);
        vm.prank(operator);
        keys.setCreatorInactive(alice, true);
        (uint256 base, uint256 creatorFee,, uint256 holderFee,, uint256 total) = keys.quote(alice, 200, true, carol);
        assertEq(total, totalActive, "the trader pays the same");
        assertEq(creatorFee, 0);
        assertEq(holderFee, base * 100 / 10_000 + base * 600 / 10_000);
        uint256 bobBefore = keys.pendingHolderReward(alice, bob);
        _buy(carol, alice, 200);
        (uint256 creatorAfter,,,) = _earnings(alice);
        assertEq(creatorAfter, creatorBefore, "no creator fee while inactive");
        // holders before the buy: alice 100, bob 100 -> bob gets half of 1% + 6%
        assertApproxEqAbs(keys.pendingHolderReward(alice, bob) - bobBefore, holderFee / 2, 2);

        vm.prank(operator);
        keys.setCreatorInactive(alice, false);
        _buy(dave, alice, 10);
        (uint256 creatorBack,,,) = _earnings(alice);
        assertGt(creatorBack, creatorAfter, "fee returns once the creator posts again");
    }

    function test_creatorInactiveRules() public {
        vm.expectRevert(SwayKeys.NotOperator.selector);
        keys.setCreatorInactive(alice, true);
        vm.prank(operator);
        vm.expectRevert(SwayKeys.MarketNotOpen.selector);
        keys.setCreatorInactive(bob, true);
        address fan = _openFan(9009);
        vm.prank(operator);
        vm.expectRevert(SwayKeys.NotFanMarket.selector);
        keys.setCreatorInactive(fan, true);
    }

    function test_antiDumpWithin24h() public {
        _buy(bob, alice, 300);
        (uint256 base,,, uint256 holderFee,, uint256 early) = keys.quote(alice, 100, false, bob);
        assertEq(holderFee, base * 100 / 10_000 + base * 500 / 10_000, "1% + 5% surcharge to holders");
        vm.warp(block.timestamp + 24 hours);
        (,,, uint256 holderLate,, uint256 late) = keys.quote(alice, 100, false, bob);
        assertEq(holderLate, base * 100 / 10_000);
        assertEq(late - early, base * 500 / 10_000);
        // a fresh buy restarts the window
        vm.warp(block.timestamp + 6 minutes);
        _buy(bob, alice, 1);
        (,,,,, uint256 again) = keys.quote(alice, 100, false, bob);
        assertLt(again, late);
        // the surcharge reaches the other holders
        uint256 aliceBefore = keys.pendingHolderReward(alice, alice);
        uint256 got = _sell(bob, alice, 100);
        assertEq(got, again);
        assertGt(keys.pendingHolderReward(alice, alice) - aliceBefore, 0);
    }

    function test_haltBlocksBuysNotSells() public {
        _buy(bob, alice, 100);
        vm.prank(fanAdmin);
        keys.setMarketHalted(alice, true);
        (, uint256 total) = _quote(alice, 1, true, carol);
        vm.prank(carol);
        vm.expectRevert(SwayKeys.MarketIsHalted.selector);
        keys.buy{value: total}(alice, 1);
        _sell(bob, alice, 100);
    }

    /* ------------------------------------------------------------ admin & safety */

    function test_pauseBlocksBuysAndOpens_notSellsOrClaims() public {
        _buy(bob, alice, 100);
        vm.prank(admin);
        keys.pause();
        vm.prank(carol);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        keys.buy{value: 1 ether}(alice, 1);
        vm.prank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        keys.openMarket(carol, 99);
        _sell(bob, alice, 100);
        address[] memory subjects = new address[](1);
        subjects[0] = alice;
        vm.prank(alice);
        keys.claim(subjects);
    }

    function test_adminIsTwoStep() public {
        vm.prank(admin);
        keys.transferOwnership(bob);
        assertEq(keys.owner(), admin);
        vm.prank(bob);
        keys.acceptOwnership();
        assertEq(keys.owner(), bob);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        keys.setOperator(admin, true);
    }

    function test_fanEscrowSetOnce() public {
        vm.prank(admin);
        vm.expectRevert(SwayKeys.FanEscrowAlreadySet.selector);
        keys.setFanEscrow(address(0xBEEF));
        vm.prank(admin);
        vm.expectRevert(FanEscrow.KeysAlreadySet.selector);
        escrow.setKeys(address(0xBEEF));
        vm.expectRevert(FanEscrow.NotKeys.selector);
        escrow.deposit{value: 1}(alice);
    }

    function test_rejectsStrayEth() public {
        vm.prank(bob);
        (bool ok,) = address(keys).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_reentrantSellerCannotDoubleSell() public {
        Reenterer r = new Reenterer(keys, alice);
        vm.deal(address(r), 10 ether);
        r.buyKeys(200);
        vm.expectRevert(SwayKeys.TransferFailed.selector);
        r.sellKeys(100);
        assertEq(keys.balanceOf(alice, address(r)), 200);
    }

    /* ------------------------------------------------------------ fuzz */

    function testFuzz_pathIndependentBase(uint256 a, uint256 b, uint256 start) public {
        a = bound(a, 1, 20_000);
        b = bound(b, 1, 20_000);
        start = bound(start, 0, 100_000);
        keys.harnessEndSnipeWindow(alice);
        if (start != 0) keys.harnessMint(alice, carol, start);
        (uint256 baseWhole,) = _quote(alice, a + b, true, bob);
        (uint256 baseA,) = _quote(alice, a, true, bob);
        vm.deal(bob, type(uint128).max);
        _buy(bob, alice, a);
        (uint256 baseB,) = _quote(alice, b, true, bob);
        assertEq(baseA + baseB, baseWhole);
    }

    function testFuzz_roundTripLosesExactlyFees(uint256 units, uint8 level) public {
        units = bound(units, 1, 50_000);
        level = uint8(bound(level, 0, 4));
        staking.set(bob, level);
        keys.harnessEndSnipeWindow(alice);
        vm.deal(bob, type(uint128).max);
        uint256 start = bob.balance;
        (uint256 base, uint256 paid) = _quote(alice, units, true, bob);
        _buy(bob, alice, units);
        (uint256 baseSell, uint256 proceeds) = _quote(alice, units, false, bob);
        assertEq(baseSell, base, "same area both ways");
        assertEq(_sell(bob, alice, units), proceeds);
        assertEq(start - bob.balance, paid - proceeds);
        // what the contract keeps equals what it owes, up to accumulator rounding
        uint256 owed = _owedTotal();
        assertGe(address(keys).balance, owed);
        assertLe(address(keys).balance - owed, 4);
    }

    function testFuzz_quoteMatchesExecution(uint256 units, uint256 supply, uint8 level, bool isBuy) public {
        supply = bound(supply, 0, 200_000);
        units = bound(units, 1, 30_000);
        level = uint8(bound(level, 0, 4));
        staking.set(bob, level);
        keys.harnessEndSnipeWindow(alice);
        keys.harnessMint(alice, bob, supply + units);
        vm.deal(address(keys), _reserve(100 + supply + units)); // fund the reserve the harness skipped
        vm.deal(bob, type(uint128).max);
        if (isBuy) {
            (, uint256 total) = _quote(alice, units, true, bob);
            uint256 before = bob.balance;
            vm.prank(bob);
            keys.buy{value: total}(alice, units);
            assertEq(before - bob.balance, total);
        } else {
            (, uint256 total) = _quote(alice, units, false, bob);
            assertEq(_sell(bob, alice, units), total);
        }
    }

    /* ------------------------------------------------------------ helpers */

    function _owedTotal() internal view returns (uint256 owed) {
        address[7] memory who = [alice, bob, carol, dave, treasury, address(staking), address(escrow)];
        for (uint256 i; i < who.length; ++i) {
            (uint256 c, uint256 h, uint256 r, uint256 p) = _earnings(who[i]);
            owed += c + h + r + p + keys.pendingHolderReward(alice, who[i]);
        }
        (,,,,,, uint256 supply,) = keys.markets(alice);
        owed += _reserve(supply);
    }
}

contract BrokenStaking {
    function levelOf(address) external pure returns (uint8) {
        revert("broken");
    }
}

/// @dev Re-enters sell() from its receive hook; the guard makes the outer transfer fail.
contract Reenterer {
    SwayKeys internal immutable keys;
    address internal immutable subject;
    bool internal entered;

    constructor(SwayKeys k, address s) {
        keys = k;
        subject = s;
    }

    function buyKeys(uint256 units) external {
        (,,,,, uint256 total) = keys.quote(subject, units, true, address(this));
        keys.buy{value: total}(subject, units);
    }

    function sellKeys(uint256 units) external {
        keys.sell(subject, units, 0);
    }

    receive() external payable {
        if (!entered && msg.sender == address(keys) && keys.balanceOf(subject, address(this)) != 0) {
            entered = true;
            keys.sell(subject, 100, 0);
        }
    }
}

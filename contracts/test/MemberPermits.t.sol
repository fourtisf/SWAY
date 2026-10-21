// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {SwayKeys} from "../src/SwayKeys.sol";
import {Base} from "./utils/Base.sol";

/// @dev Joining costs the operator no gas: it signs Member permits offchain and the first buyer (or the
///      member) submits them.
contract MemberPermitsTest is Base {
    address internal signer;
    uint256 internal signerKey;
    uint64 internal constant BOB_XID = 2002;
    uint64 internal constant FAN_XID = 5005;

    function setUp() public override {
        super.setUp();
        (signer, signerKey) = makeAddrAndKey("signer");
        vm.prank(admin);
        keys.setOperator(signer, true);
    }

    function _member(address wallet, uint64 xId, address referrer) internal view returns (SwayKeys.Member memory) {
        return SwayKeys.Member({wallet: wallet, xId: xId, referrer: referrer, deadline: block.timestamp + 30 minutes});
    }

    function _sign(SwayKeys.Member memory m, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keys.memberDigest(m));
        return abi.encodePacked(r, s, v);
    }

    function _one(SwayKeys.Member memory m, bytes memory sig)
        internal
        pure
        returns (SwayKeys.Member[] memory ms, bytes[] memory sigs)
    {
        ms = new SwayKeys.Member[](1);
        sigs = new bytes[](1);
        ms[0] = m;
        sigs[0] = sig;
    }

    /// @dev What the first buyer pays: the curve quote for a fresh market (supply 100) plus fees.
    function _freshTotal(uint256 units) internal view returns (uint256) {
        uint256 base = keys.cumulative(100 + units) - keys.cumulative(100);
        return base + (base * 1_000) / 10_000;
    }

    function _supply(address subject) internal view returns (uint256 supply) {
        (,,,,,, supply,) = keys.markets(subject);
    }

    /* ------------------------------------------------------------ opening */

    function test_firstBuyerOpensTheMarket_operatorSendsNothing() public {
        SwayKeys.Member memory m = _member(bob, BOB_XID, address(0));
        (SwayKeys.Member[] memory ms, bytes[] memory sigs) = _one(m, _sign(m, signerKey));
        uint256 total = _freshTotal(100);
        uint256 nonceBefore = vm.getNonce(signer);

        vm.expectEmit(true, true, true, true);
        emit SwayKeys.MarketOpened(bob, bob, BOB_XID, false);
        vm.prank(carol);
        keys.registerAndBuy{value: total}(ms, sigs, bob, 100);

        assertEq(vm.getNonce(signer), nonceBefore, "the operator sent no transaction");
        assertEq(keys.subjectOfXId(BOB_XID), bob);
        assertEq(keys.balanceOf(bob, bob), 100, "locked first key");
        assertEq(keys.balanceOf(bob, carol), 100);
        assertEq(_supply(bob), 200);
        (uint256 creator,,,) = _earnings(bob);
        assertEq(creator, ((keys.cumulative(200) - keys.cumulative(100)) * 600) / 10_000);
    }

    function test_memberCanRegisterThemselves() public {
        SwayKeys.Member memory m = _member(bob, BOB_XID, address(0));
        bytes memory sig = _sign(m, signerKey);
        vm.prank(bob);
        keys.register(m, sig);
        assertEq(keys.subjectOfXId(BOB_XID), bob);
        assertEq(_supply(bob), 100);
    }

    function test_secondBuyerWithTheSamePermit_justBuys() public {
        SwayKeys.Member memory m = _member(bob, BOB_XID, address(0));
        (SwayKeys.Member[] memory ms, bytes[] memory sigs) = _one(m, _sign(m, signerKey));
        uint256 fresh = _freshTotal(100); // computed before the prank: it calls the contract
        vm.prank(carol);
        keys.registerAndBuy{value: fresh}(ms, sigs, bob, 100);

        // A racing buyer holding the same permit, even past its deadline, still gets their keys.
        vm.warp(block.timestamp + 1 days);
        (, uint256 total) = _quote(bob, 100, true, dave);
        vm.prank(dave);
        keys.registerAndBuy{value: total}(ms, sigs, bob, 100);
        assertEq(keys.balanceOf(bob, dave), 100);
        assertEq(_supply(bob), 300);
    }

    function test_withoutAPermit_anUnopenedMarketCannotBeBought() public {
        uint256 total = _freshTotal(100);
        vm.prank(carol);
        vm.expectRevert(SwayKeys.MarketNotOpen.selector);
        keys.buy{value: total}(bob, 100);
    }

    /* ------------------------------------------------------------ signatures */

    function test_rejectsPermitsNotSignedByAnOperator() public {
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        SwayKeys.Member memory m = _member(bob, BOB_XID, address(0));
        bytes memory forged = _sign(m, strangerKey);
        vm.expectRevert(SwayKeys.BadSignature.selector);
        keys.register(m, forged);

        // Valid signature, different wallet: the digest no longer matches.
        bytes memory sig = _sign(m, signerKey);
        m.wallet = carol;
        vm.expectRevert(SwayKeys.BadSignature.selector);
        keys.register(m, sig);
    }

    function test_revokedOperatorsPermitsStopWorking() public {
        SwayKeys.Member memory m = _member(bob, BOB_XID, address(0));
        bytes memory sig = _sign(m, signerKey);
        vm.prank(admin);
        keys.setOperator(signer, false);
        vm.expectRevert(SwayKeys.BadSignature.selector);
        keys.register(m, sig);
    }

    function test_expiredPermitWithWorkLeft_reverts() public {
        SwayKeys.Member memory m = _member(bob, BOB_XID, address(0));
        bytes memory sig = _sign(m, signerKey);
        vm.warp(m.deadline + 1);
        vm.expectRevert(SwayKeys.Expired.selector);
        keys.register(m, sig);
    }

    function test_lengthMismatch() public {
        SwayKeys.Member[] memory ms = new SwayKeys.Member[](1);
        bytes[] memory sigs = new bytes[](0);
        vm.prank(carol);
        vm.expectRevert(SwayKeys.LengthMismatch.selector);
        keys.registerAndBuy{value: 1 ether}(ms, sigs, alice, 100);
    }

    /* ------------------------------------------------------------ referrers */

    function test_permitSetsTheCreatorsReferrer() public {
        SwayKeys.Member memory m = _member(bob, BOB_XID, dave);
        (SwayKeys.Member[] memory ms, bytes[] memory sigs) = _one(m, _sign(m, signerKey));
        vm.expectEmit(true, true, false, false);
        emit SwayKeys.ReferrerSet(bob, dave);
        uint256 fresh = _freshTotal(100); // computed before the prank: it calls the contract
        vm.prank(carol);
        keys.registerAndBuy{value: fresh}(ms, sigs, bob, 100);

        assertEq(keys.referrerOf(bob), dave);
        uint256 base = keys.cumulative(200) - keys.cumulative(100);
        uint256 referral = (base * 100) / 10_000;
        (,, uint256 earned,) = _earnings(dave);
        assertEq(earned, referral - referral / 2, "the creator's half of the referral fee");
    }

    function test_traderReferrerOnlyPermit_onTheirFirstTrade() public {
        // xId 0: no market part, so the trader's own market stays unopened and they pay only for the referrer.
        SwayKeys.Member memory t = _member(carol, 0, dave);
        (SwayKeys.Member[] memory ms, bytes[] memory sigs) = _one(t, _sign(t, signerKey));
        (uint256 base, uint256 total) = _quote(alice, 100, true, carol);
        vm.prank(carol);
        keys.registerAndBuy{value: total}(ms, sigs, alice, 100);

        assertEq(keys.referrerOf(carol), dave);
        assertEq(_supply(carol), 0);
        (,, uint256 earned,) = _earnings(dave);
        assertEq(earned, ((base * 100) / 10_000) / 2, "the trader's half of the referral fee");
    }

    function test_referrerIsSetOnce() public {
        vm.prank(operator);
        keys.setReferrer(carol, bob);
        SwayKeys.Member memory t = _member(carol, 0, dave);
        bytes memory sig = _sign(t, signerKey);
        keys.register(t, sig); // nothing left to do: a no-op
        assertEq(keys.referrerOf(carol), bob);
    }

    function test_bothPermitsInOneBuy() public {
        SwayKeys.Member[] memory ms = new SwayKeys.Member[](2);
        bytes[] memory sigs = new bytes[](2);
        ms[0] = _member(bob, BOB_XID, address(0));
        ms[1] = _member(carol, 0, dave);
        sigs[0] = _sign(ms[0], signerKey);
        sigs[1] = _sign(ms[1], signerKey);
        uint256 fresh = _freshTotal(100); // computed before the prank: it calls the contract
        vm.prank(carol);
        keys.registerAndBuy{value: fresh}(ms, sigs, bob, 100);
        assertEq(keys.balanceOf(bob, carol), 100);
        assertEq(keys.referrerOf(carol), dave);
    }

    /* ------------------------------------------------------------ fan markets */

    function test_permitClaimsTheFanMarketOfTheMembersXAccount() public {
        vm.prank(fanAdmin);
        address subject = keys.openFanMarket(FAN_XID);
        _buy(carol, subject, 300);
        uint256 escrowed = escrow.escrowed(subject);
        assertGt(escrowed, 0);

        SwayKeys.Member memory m = _member(bob, FAN_XID, address(0));
        bytes memory sig = _sign(m, signerKey);
        vm.expectEmit(true, true, false, true);
        emit SwayKeys.FanMarketClaimed(subject, bob, escrowed);
        vm.prank(bob);
        keys.register(m, sig);

        (address owner_,,,,,,,) = keys.markets(subject);
        assertEq(owner_, bob);
        assertEq(keys.balanceOf(subject, bob), 100);
        (uint256 creator,,,) = _earnings(bob);
        assertEq(creator, escrowed);
        assertEq(_supply(bob), 0, "no second market for the wallet");

        // Already claimed: the same permit does nothing more.
        keys.register(m, sig);
        (creator,,,) = _earnings(bob);
        assertEq(creator, escrowed);
    }

    function test_nextBuyerCanCarryTheCreatorsClaim() public {
        vm.prank(fanAdmin);
        address subject = keys.openFanMarket(FAN_XID);
        _buy(carol, subject, 100);

        SwayKeys.Member memory m = _member(bob, FAN_XID, address(0));
        (SwayKeys.Member[] memory ms, bytes[] memory sigs) = _one(m, _sign(m, signerKey));
        (uint256 base, uint256 total) = _quote(subject, 100, true, dave);
        vm.prank(dave);
        keys.registerAndBuy{value: total}(ms, sigs, subject, 100);

        // Claimed before the buy, so this buy's creator fee goes straight to bob.
        assertEq(escrow.escrowed(subject), 0);
        (uint256 creator,,,) = _earnings(bob);
        uint256 firstFee = ((keys.cumulative(200) - keys.cumulative(100)) * 600) / 10_000;
        assertEq(creator, firstFee + (base * 600) / 10_000);
    }

    /* ------------------------------------------------------------ pause */

    function test_pauseBlocksOpening_notReferrers() public {
        vm.prank(admin);
        keys.pause();
        SwayKeys.Member memory m = _member(bob, BOB_XID, address(0));
        bytes memory sig = _sign(m, signerKey);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        keys.register(m, sig);

        SwayKeys.Member memory t = _member(carol, 0, dave);
        bytes memory tsig = _sign(t, signerKey);
        keys.register(t, tsig);
        assertEq(keys.referrerOf(carol), dave);
    }
}

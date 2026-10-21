// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwayLaunchpad, ISwayKeysMarkets} from "../src/SwayLaunchpad.sol";
import {SwayCreatorToken} from "../src/SwayCreatorToken.sol";
import {Base} from "./utils/Base.sol";
import {IUniswapV2RouterLike} from "../src/interfaces/IUniswapV2.sol";
import {DevV2Factory, DevV2Pair, DevV2Router, DevWETH} from "../script/DevUniswapV2.sol";

contract SwayLaunchpadTest is Base {
    SwayLaunchpad internal pad;
    DevV2Router internal router;
    uint256 internal signerKey = 0xA11CE;
    address internal signer;

    function setUp() public override {
        super.setUp();
        signer = vm.addr(signerKey);
        router = new DevV2Router();
        pad = new SwayLaunchpad(admin, ISwayKeysMarkets(address(keys)), signer, IUniswapV2RouterLike(address(router)));
    }

    function _sig(address creator, uint256 startCap, uint256 gradCap, bytes32 root, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = pad.launchDigest(creator, "Alice", "ALICE", startCap, gradCap, root, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Two-leaf merkle tree of key holders (bob 60M, carol 40M).
    function _tree() internal view returns (bytes32 root, bytes32 leafBob, bytes32 leafCarol) {
        leafBob = keccak256(bytes.concat(keccak256(abi.encode(bob, uint256(60_000_000 ether)))));
        leafCarol = keccak256(bytes.concat(keccak256(abi.encode(carol, uint256(40_000_000 ether)))));
        root = leafBob < leafCarol
            ? keccak256(abi.encodePacked(leafBob, leafCarol))
            : keccak256(abi.encodePacked(leafCarol, leafBob));
    }

    function _launch() internal returns (address token) {
        (bytes32 root,,) = _tree();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(alice, 1 ether, 20 ether, root, deadline);
        vm.prank(alice);
        token = pad.launch("Alice", "ALICE", 1 ether, 20 ether, root, deadline, sig);
    }

    function test_launch_requiresKeyMarketAndSignature() public {
        (bytes32 root,,) = _tree();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(bob, 1 ether, 20 ether, root, deadline);
        vm.prank(bob);
        vm.expectRevert(SwayLaunchpad.NoKeyMarket.selector);
        pad.launch("Alice", "ALICE", 1 ether, 20 ether, root, deadline, sig);

        bytes memory wrong = _sig(alice, 1 ether, 20 ether, bytes32(uint256(1)), deadline);
        vm.prank(alice);
        vm.expectRevert(SwayLaunchpad.BadSignature.selector);
        pad.launch("Alice", "ALICE", 1 ether, 20 ether, root, deadline, wrong);

        address token = _launch();
        assertEq(IERC20(token).balanceOf(address(pad)), 1_000_000_000 ether);
        assertApproxEqRel(pad.marketCap(token), 1 ether, 1e12, "start cap seeded from the attestation");

        bytes memory again = _sig(alice, 1 ether, 20 ether, root, deadline);
        vm.prank(alice);
        vm.expectRevert(SwayLaunchpad.AlreadyLaunched.selector);
        pad.launch("Alice", "ALICE", 1 ether, 20 ether, root, deadline, again);
    }

    function test_buySell_feesToCreator() public {
        address token = _launch();
        (uint256 out, uint256 fee, uint256 spent) = pad.quoteBuy(token, 0.5 ether);
        assertEq(spent, 0.5 ether, "far from graduation the whole amount is spent");
        vm.prank(bob);
        uint256 got = pad.buy{value: 0.5 ether}(token, out);
        assertEq(got, out);
        assertEq(fee, 0.005 ether);
        assertEq(pad.creatorFees(alice), fee);
        assertGt(pad.marketCap(token), 1 ether);

        vm.startPrank(bob);
        IERC20(token).approve(address(pad), got);
        (uint256 ethOut, uint256 fee2) = pad.quoteSell(token, got);
        uint256 before = bob.balance;
        pad.sell(token, got, ethOut);
        vm.stopPrank();
        assertEq(bob.balance - before, ethOut);
        assertLt(ethOut, 0.5 ether);
        assertEq(pad.creatorFees(alice), fee + fee2);
        (,, uint256 ethReserve,,,,,) = pad.curves(token);
        assertLe(ethReserve, 2, "round trip leaves only rounding dust in the curve");

        uint256 aBefore = alice.balance;
        vm.prank(alice);
        pad.claimCreatorFees();
        assertEq(alice.balance - aBefore, fee + fee2);
    }

    function test_graduatingBuyMovesTheCurveIntoUniswap_atItsLastPrice() public {
        address token = _launch();
        address pair = pad.pairOf(token);
        assertEq(DevV2Factory(router.factory()).getPair(token, router.WETH()), pair, "pair created at launch");

        uint256 padBalance = address(pad).balance;
        (,, uint256 spent) = pad.quoteBuy(token, 30 ether);
        uint256 bobBefore = bob.balance;
        vm.prank(bob);
        uint256 got = pad.buy{value: 30 ether}(token, 0);
        (, uint256 virtualEth,,,,, bool graduated, bool migrated) = pad.curves(token);
        assertTrue(graduated && migrated);
        assertEq(IERC20(token).balanceOf(bob), got);
        assertLt(spent, 30 ether, "the buy stops at the graduation cap");
        assertEq(bobBefore - bob.balance, spent, "the rest is refunded");
        uint256 fee = pad.creatorFees(alice);
        assertApproxEqAbs(fee, spent / 100, 1);
        // All of the curve's ETH is in the pool as WETH; only the creator's fee stays in the launchpad.
        assertEq(IERC20(router.WETH()).balanceOf(pair), spent - fee);
        assertEq(address(pad).balance - padBalance, fee);
        _assertPoolAtLastPrice(token, pair, spent - fee, pad.CURVE_SUPPLY() - got, virtualEth);

        // The curve is closed; the token now trades freely, the pool included.
        vm.prank(carol);
        vm.expectRevert(SwayLaunchpad.CurveClosed.selector);
        pad.buy{value: 1 ether}(token, 0);
        vm.prank(bob);
        IERC20(token).transfer(pair, 1 ether);
    }

    /// @dev Pool price = the curve's last price (virtualEth + eth) / tokens left, the rest of the curve and the LP
    ///      tokens burned, and only the airdrop left in the launchpad.
    function _assertPoolAtLastPrice(address token, address pair, uint256 eth, uint256 tokensLeft, uint256 virtualEth)
        internal
        view
    {
        uint256 poolTokens = IERC20(token).balanceOf(pair);
        assertEq(poolTokens, (eth * tokensLeft) / (virtualEth + eth));
        assertEq(IERC20(token).balanceOf(pad.DEAD()), tokensLeft - poolTokens, "leftover curve tokens burned");
        assertEq(IERC20(token).balanceOf(address(pad)), pad.HOLDER_ALLOCATION(), "only the airdrop stays");
        // LP tokens are burned: nobody, the owner included, can pull the liquidity.
        DevV2Pair p = DevV2Pair(pair);
        assertEq(p.balanceOf(pad.DEAD()) + p.MINIMUM_LIQUIDITY(), p.totalSupply());
        assertEq(p.balanceOf(admin) + p.balanceOf(address(pad)) + p.balanceOf(alice), 0);
    }

    function test_poolOpensAtTheGraduationCap_howeverLargeTheLastBuy() public {
        address token = _launch();
        vm.deal(bob, 1_000 ether);
        vm.prank(bob);
        pad.buy{value: 500 ether}(token, 0);
        address pair = pad.pairOf(token);
        uint256 pooledEth = IERC20(router.WETH()).balanceOf(pair);
        uint256 pooledTokens = IERC20(token).balanceOf(pair);
        // Pool market cap = ETH per token x total supply: the graduation cap (20 ETH), not 500 ETH worth of curve.
        assertApproxEqRel((pooledEth * pad.TOTAL_SUPPLY()) / pooledTokens, 20 ether, 1e15);
        assertLt(pooledEth, 20 ether);
    }

    function test_quoteMatchesTheBuy_whenCapped() public {
        address token = _launch();
        (uint256 out, uint256 fee, uint256 spent) = pad.quoteBuy(token, 50 ether);
        uint256 before = bob.balance;
        vm.prank(bob);
        uint256 got = pad.buy{value: 50 ether}(token, out);
        assertEq(got, out);
        assertEq(before - bob.balance, spent);
        assertEq(pad.creatorFees(alice), fee);
    }

    function test_nobodyCanSeedThePoolBeforeGraduation() public {
        address token = _launch();
        address pair = pad.pairOf(token);
        vm.prank(bob);
        uint256 got = pad.buy{value: 1 ether}(token, 0);
        vm.prank(bob);
        vm.expectRevert(SwayCreatorToken.PairNotOpen.selector);
        IERC20(token).transfer(pair, got);
        vm.startPrank(bob);
        IERC20(token).approve(carol, got);
        vm.stopPrank();
        vm.prank(carol);
        vm.expectRevert(SwayCreatorToken.PairNotOpen.selector);
        IERC20(token).transferFrom(bob, pair, got);
        vm.expectRevert(SwayCreatorToken.OnlyLaunchpad.selector);
        SwayCreatorToken(token).openPair();
        vm.expectRevert(SwayCreatorToken.OnlyLaunchpad.selector);
        SwayCreatorToken(token).setPair(bob);
    }

    function test_aPairMadeAheadOfLaunch_withWethInIt_doesntBlockOrSkewGraduation() public {
        // The next token's address is predictable: someone creates its pair first and sends WETH to it.
        address predicted = vm.computeCreateAddress(address(pad), vm.getNonce(address(pad)));
        address weth = router.WETH();
        address pair = DevV2Factory(router.factory()).createPair(predicted, weth);
        vm.deal(dave, 1 ether);
        vm.startPrank(dave);
        DevWETH(weth).deposit{value: 1 ether}();
        DevWETH(weth).transfer(pair, 1 ether);
        vm.stopPrank();

        address token = _launch();
        assertEq(token, predicted);
        assertEq(pad.pairOf(token), pair, "launch reuses the existing pair");
        DevV2Pair(pair).sync(); // the WETH is now in the pair's reserves
        (,, uint256 spent) = pad.quoteBuy(token, 30 ether);
        vm.prank(bob);
        pad.buy{value: 30 ether}(token, 0);
        (,,,,,,, bool migrated) = pad.curves(token);
        assertTrue(migrated);
        // The stray WETH stays in the pool on top of the curve's ETH: a gift to it, not to the sender.
        assertEq(IERC20(weth).balanceOf(pair), 1 ether + spent - pad.creatorFees(alice));
        assertEq(DevV2Pair(pair).balanceOf(dave), 0);
    }

    function test_holderAirdrop() public {
        address token = _launch();
        (, bytes32 leafBob, bytes32 leafCarol) = _tree();
        bytes32[] memory proofBob = new bytes32[](1);
        proofBob[0] = leafCarol;
        vm.prank(bob);
        pad.claimAirdrop(token, 60_000_000 ether, proofBob);
        assertEq(IERC20(token).balanceOf(bob), 60_000_000 ether);
        vm.prank(bob);
        vm.expectRevert(SwayLaunchpad.AlreadyClaimed.selector);
        pad.claimAirdrop(token, 60_000_000 ether, proofBob);

        bytes32[] memory proofCarol = new bytes32[](1);
        proofCarol[0] = leafBob;
        vm.prank(carol);
        vm.expectRevert(SwayLaunchpad.BadProof.selector);
        pad.claimAirdrop(token, 50_000_000 ether, proofCarol);
    }

    /// A root that promises more than 10% can't pay out past HOLDER_ALLOCATION (the curve's tokens stay put).
    function test_airdropCappedAtHolderAllocation() public {
        bytes32 lb = keccak256(bytes.concat(keccak256(abi.encode(bob, uint256(60_000_000 ether)))));
        bytes32 lc = keccak256(bytes.concat(keccak256(abi.encode(carol, uint256(60_000_000 ether)))));
        bytes32 root = lb < lc ? keccak256(abi.encodePacked(lb, lc)) : keccak256(abi.encodePacked(lc, lb));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(alice, 1 ether, 20 ether, root, deadline);
        vm.prank(alice);
        address token = pad.launch("Alice", "ALICE", 1 ether, 20 ether, root, deadline, sig);

        bytes32[] memory pb = new bytes32[](1);
        pb[0] = lc;
        vm.prank(bob);
        pad.claimAirdrop(token, 60_000_000 ether, pb);
        bytes32[] memory pc = new bytes32[](1);
        pc[0] = lb;
        vm.prank(carol);
        vm.expectRevert(SwayLaunchpad.AirdropExceeded.selector);
        pad.claimAirdrop(token, 60_000_000 ether, pc);
        assertEq(pad.airdropped(token), 60_000_000 ether);
    }

    function testFuzz_buyNeverOverdrawsCurve(uint256 ethIn) public {
        address token = _launch();
        ethIn = bound(ethIn, 1 gwei, 19 ether);
        vm.deal(bob, ethIn);
        vm.prank(bob);
        uint256 out = pad.buy{value: ethIn}(token, 0);
        (,, uint256 ethReserve, uint256 tokenReserve,,,, bool migrated) = pad.curves(token);
        assertEq(address(pad).balance, ethReserve + pad.creatorFees(alice));
        if (migrated) {
            // Graduated: the rest of the curve went into the pool or was burned.
            address pair = pad.pairOf(token);
            assertEq(tokenReserve, 0);
            assertEq(IERC20(token).balanceOf(pair) + IERC20(token).balanceOf(pad.DEAD()) + out, 900_000_000 ether);
        } else {
            assertEq(tokenReserve + out, 900_000_000 ether);
        }
    }
}

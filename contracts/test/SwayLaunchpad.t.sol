// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwayLaunchpad, ISwayKeysMarkets} from "../src/SwayLaunchpad.sol";
import {Base} from "./utils/Base.sol";

contract SwayLaunchpadTest is Base {
    SwayLaunchpad internal pad;
    uint256 internal signerKey = 0xA11CE;
    address internal signer;

    function setUp() public override {
        super.setUp();
        signer = vm.addr(signerKey);
        pad = new SwayLaunchpad(admin, ISwayKeysMarkets(address(keys)), signer);
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
        (uint256 out, uint256 fee) = pad.quoteBuy(token, 0.5 ether);
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

    function test_graduationClosesCurve_thenMigrate() public {
        address token = _launch();
        vm.prank(bob);
        pad.buy{value: 30 ether}(token, 0);
        (,,,,,, bool graduated,) = pad.curves(token);
        assertTrue(graduated);
        vm.prank(carol);
        vm.expectRevert(SwayLaunchpad.CurveClosed.selector);
        pad.buy{value: 1 ether}(token, 0);

        address pool = makeAddr("pool");
        vm.prank(admin);
        pad.migrate(token, pool);
        assertGt(pool.balance, 0);
        assertGt(IERC20(token).balanceOf(pool), 0);
        vm.prank(admin);
        vm.expectRevert(SwayLaunchpad.AlreadyMigrated.selector);
        pad.migrate(token, pool);
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
        (,, uint256 ethReserve, uint256 tokenReserve,,,,) = pad.curves(token);
        assertEq(tokenReserve + out, 900_000_000 ether);
        assertEq(address(pad).balance, ethReserve + pad.creatorFees(alice));
    }
}

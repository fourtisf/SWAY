// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SwayDrops} from "../src/SwayDrops.sol";

/// @notice Creator ETH drops, claimed with proofs built by packages/shared/src/merkle.ts.
contract SwayDropsTest is Test {
    SwayDrops internal drops;
    address internal creator = makeAddr("creator");
    string internal json;
    bytes32 internal root;
    address[] internal accounts;
    uint256[] internal amounts;
    uint256 internal total;

    function setUp() public {
        drops = new SwayDrops();
        json = vm.readFile("test/vectors/airdrop.json");
        root = vm.parseJsonBytes32(json, ".root");
        accounts = vm.parseJsonAddressArray(json, ".accounts");
        amounts = vm.parseJsonUintArray(json, ".amounts");
        for (uint256 i; i < amounts.length; ++i) total += amounts[i];
        vm.deal(creator, total * 2);
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory) {
        return vm.parseJsonBytes32Array(json, string.concat(".proofs[", vm.toString(i), "]"));
    }

    function _create() internal returns (uint256 id) {
        vm.prank(creator);
        id = drops.create{value: total}(root, 7 days);
    }

    function test_everyHolderClaimsTheirShare() public {
        uint256 id = _create();
        for (uint256 i; i < accounts.length; ++i) {
            vm.prank(accounts[i]);
            drops.claim(id, amounts[i], _proof(i));
            assertEq(accounts[i].balance, amounts[i]);
        }
        (,,, uint256 t, uint256 claimed,) = drops.drops(id);
        assertEq(claimed, t);
        assertEq(address(drops).balance, 0);
    }

    function test_claimRules() public {
        uint256 id = _create();
        vm.prank(accounts[0]);
        drops.claim(id, amounts[0], _proof(0));
        vm.prank(accounts[0]);
        vm.expectRevert(SwayDrops.AlreadyClaimed.selector);
        drops.claim(id, amounts[0], _proof(0));
        vm.prank(accounts[1]);
        vm.expectRevert(SwayDrops.BadProof.selector);
        drops.claim(id, amounts[1] + 1, _proof(1));
        vm.warp(block.timestamp + 7 days);
        vm.prank(accounts[1]);
        vm.expectRevert(SwayDrops.Expired.selector);
        drops.claim(id, amounts[1], _proof(1));
    }

    function test_reclaimAfterExpiry() public {
        uint256 id = _create();
        vm.prank(accounts[0]);
        drops.claim(id, amounts[0], _proof(0));
        vm.prank(creator);
        vm.expectRevert(SwayDrops.NotExpired.selector);
        drops.reclaim(id);
        vm.warp(block.timestamp + 7 days);
        vm.prank(accounts[1]);
        vm.expectRevert(SwayDrops.NotCreator.selector);
        drops.reclaim(id);
        uint256 before = creator.balance;
        vm.prank(creator);
        drops.reclaim(id);
        assertEq(creator.balance - before, total - amounts[0]);
        vm.prank(creator);
        vm.expectRevert(SwayDrops.Expired.selector);
        drops.reclaim(id);
    }

    function test_createRules() public {
        vm.startPrank(creator);
        vm.expectRevert(SwayDrops.ZeroAmount.selector);
        drops.create(root, 7 days);
        vm.expectRevert(SwayDrops.BadDuration.selector);
        drops.create{value: 1}(root, 1 hours);
        vm.stopPrank();
    }
}

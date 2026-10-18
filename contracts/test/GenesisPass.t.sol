// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {GenesisPass} from "../src/GenesisPass.sol";

contract GenesisPassTest is Test {
    GenesisPass internal pass;
    address internal admin = makeAddr("admin");
    address internal issuer = makeAddr("issuer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        pass = new GenesisPass(admin, issuer, "https://sway.fam/genesis/");
    }

    function _commit() internal {
        vm.prank(issuer);
        pass.commitSnapshot(keccak256("list"), 1_793_113_200, "ipfs://list");
    }

    function test_mintRequiresCommittedSnapshot() public {
        vm.prank(issuer);
        vm.expectRevert(GenesisPass.SnapshotNotCommitted.selector);
        pass.mint(alice, 1);
        _commit();
        vm.prank(issuer);
        vm.expectRevert(GenesisPass.SnapshotAlreadyCommitted.selector);
        pass.commitSnapshot(keccak256("other"), 1, "");
    }

    function test_tokenIdIsRank_andLocked() public {
        _commit();
        vm.expectEmit(false, false, false, true);
        emit GenesisPass.Locked(7);
        vm.prank(issuer);
        pass.mint(alice, 7);
        assertEq(pass.ownerOf(7), alice);
        assertTrue(pass.locked(7));
        assertEq(pass.tokenURI(7), "https://sway.fam/genesis/7");
        assertEq(pass.totalMinted(), 1);
        assertTrue(pass.supportsInterface(0xb45a3c0e));
    }

    function test_rankBoundsAndOnePerMember() public {
        _commit();
        vm.startPrank(issuer);
        vm.expectRevert(GenesisPass.InvalidRank.selector);
        pass.mint(alice, 0);
        vm.expectRevert(GenesisPass.InvalidRank.selector);
        pass.mint(alice, 501);
        pass.mint(alice, 500);
        vm.expectRevert(GenesisPass.AlreadyHasPass.selector);
        pass.mint(alice, 499);
        vm.expectRevert(); // ERC721InvalidSender: rank already minted
        pass.mint(bob, 500);
        vm.stopPrank();
        vm.expectRevert(GenesisPass.NotIssuer.selector);
        pass.mint(bob, 2);
    }

    function test_soulbound() public {
        _commit();
        vm.prank(issuer);
        pass.mint(alice, 1);
        vm.startPrank(alice);
        vm.expectRevert(GenesisPass.Soulbound.selector);
        pass.transferFrom(alice, bob, 1);
        vm.expectRevert(GenesisPass.Soulbound.selector);
        pass.safeTransferFrom(alice, bob, 1);
        vm.expectRevert(GenesisPass.Soulbound.selector);
        pass.approve(bob, 1);
        vm.expectRevert(GenesisPass.Soulbound.selector);
        pass.setApprovalForAll(bob, true);
        vm.stopPrank();
    }

    function test_mintBatch() public {
        _commit();
        address[] memory to = new address[](3);
        uint256[] memory ranks = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            to[i] = address(uint160(0x1000 + i));
            ranks[i] = i + 1;
        }
        vm.prank(issuer);
        pass.mintBatch(to, ranks);
        assertEq(pass.ownerOf(3), to[2]);
        uint256[] memory short = new uint256[](2);
        vm.prank(issuer);
        vm.expectRevert(GenesisPass.LengthMismatch.selector);
        pass.mintBatch(to, short);
    }
}

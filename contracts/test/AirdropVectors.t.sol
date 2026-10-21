// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwayLaunchpad, ISwayKeysMarkets} from "../src/SwayLaunchpad.sol";
import {Base} from "./utils/Base.sol";
import {IUniswapV2RouterLike} from "../src/interfaces/IUniswapV2.sol";
import {DevV2Router} from "../script/DevUniswapV2.sol";

/// @notice Claims every leaf of an airdrop tree built by packages/shared/src/merkle.ts (odd-sized, so
///         promoted nodes are covered). Regenerate with `pnpm vectors`.
contract AirdropVectorsTest is Base {
    function _launch(bytes32 root) internal returns (SwayLaunchpad pad, address token) {
        uint256 key = 0xB0B;
        pad = new SwayLaunchpad(admin, ISwayKeysMarkets(address(keys)), vm.addr(key), IUniswapV2RouterLike(address(new DevV2Router())));
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = pad.launchDigest(alice, "Alice", "ALICE", 1 ether, 20 ether, root, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        vm.prank(alice);
        token = pad.launch("Alice", "ALICE", 1 ether, 20 ether, root, deadline, abi.encodePacked(r, s, v));
    }

    function test_typescriptTreeClaimsOnchain() public {
        string memory json = vm.readFile("test/vectors/airdrop.json");
        (SwayLaunchpad pad, address token) = _launch(vm.parseJsonBytes32(json, ".root"));
        address[] memory accounts = vm.parseJsonAddressArray(json, ".accounts");
        uint256[] memory amounts = vm.parseJsonUintArray(json, ".amounts");
        uint256 total;
        for (uint256 i; i < accounts.length; ++i) {
            bytes32[] memory proof = vm.parseJsonBytes32Array(json, string.concat(".proofs[", vm.toString(i), "]"));
            vm.prank(accounts[i]);
            pad.claimAirdrop(token, amounts[i], proof);
            assertEq(IERC20(token).balanceOf(accounts[i]), amounts[i]);
            total += amounts[i];
        }
        assertEq(total, pad.HOLDER_ALLOCATION());
    }
}

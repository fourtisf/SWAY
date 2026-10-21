// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SwayLaunchpad, ISwayKeysMarkets} from "../src/SwayLaunchpad.sol";
import {IUniswapV2RouterLike} from "../src/interfaces/IUniswapV2.sol";
import {uniswapV2Router} from "./Deploy.s.sol";

/// @notice Adds SwayLaunchpad to an existing deployment (mainnet deploys without it) and records it in
///         deployments/<chainId>.json. Graduated launches move into Uniswap V2, so nothing here trusts the owner
///         with launch funds.
/// Env:
///   SWAY_KEYS          the deployed SwayKeys (the launchpad checks creators' key markets there)
///   LAUNCH_SIGNER      signs launch terms; defaults to the deployer (the operator key)
///   ADMIN              owner (can change the signer); defaults to the deployer
///   UNISWAP_V2_ROUTER  as in Deploy.s.sol
///   ALLOW_MAINNET      1 on chain 4663
contract DeployLaunchpad is Script {
    function run() external returns (SwayLaunchpad pad) {
        bool mainnet = block.chainid == 4663;
        if (mainnet) require(vm.envOr("ALLOW_MAINNET", uint256(0)) == 1, "unaudited: set ALLOW_MAINNET=1");
        address keys = vm.envAddress("SWAY_KEYS");
        require(keys.code.length > 0, "SWAY_KEYS has no code on this chain");
        address signer = vm.envOr("LAUNCH_SIGNER", msg.sender);
        address admin = vm.envOr("ADMIN", msg.sender);
        address given = vm.envOr("UNISWAP_V2_ROUTER", address(0));

        vm.startBroadcast();
        IUniswapV2RouterLike router = uniswapV2Router(given, mainnet);
        pad = new SwayLaunchpad(msg.sender, ISwayKeysMarkets(keys), signer, router);
        if (admin != msg.sender) pad.transferOwnership(admin);
        vm.stopBroadcast();

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        if (vm.exists(path)) vm.writeJson(vm.toString(address(pad)), path, ".launchpad");
        console2.log("SwayLaunchpad ", address(pad));
        console2.log("Uniswap V2 router", address(router));
        if (admin != msg.sender) console2.log("Pending owner (must acceptOwnership):", admin);
    }
}

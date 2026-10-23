// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SwayStaking} from "../src/SwayStaking.sol";

/// @notice Adds SwayStaking for the live $SWAY token to an existing deployment (mainnet deploys without staking)
///         and points it at SwayKeys. SwayKeys' owner then calls SwayKeys.setStaking (deploy/setup-staking.sh
///         does when the operator owns SwayKeys; otherwise /admin → Contracts → Turn on staking).
/// Env:
///   SWAY_KEYS           the deployed SwayKeys
///   SWAY_TOKEN          the $SWAY token (18 decimals; stakes are plain transfers, so no fee-on-transfer tokens)
///   STAKING_THRESHOLDS  levels 1..4 in token wei, comma-separated, ascending
///   ADMIN               owner; defaults to the deployer
///   ALLOW_MAINNET       1 on chain 4663
contract DeployStaking is Script {
    function run() external returns (SwayStaking staking) {
        if (block.chainid == 4663) require(vm.envOr("ALLOW_MAINNET", uint256(0)) == 1, "unaudited: set ALLOW_MAINNET=1");
        address keys = vm.envAddress("SWAY_KEYS");
        address token = vm.envAddress("SWAY_TOKEN");
        require(keys.code.length > 0, "SWAY_KEYS has no code on this chain");
        require(token.code.length > 0, "SWAY_TOKEN has no code on this chain");
        require(IERC20Metadata(token).decimals() == 18, "SwayStaking expects an 18-decimal token");
        uint256[] memory t = vm.envUint("STAKING_THRESHOLDS", ",");
        require(t.length == 4, "STAKING_THRESHOLDS needs 4 amounts");
        address admin = vm.envOr("ADMIN", msg.sender);

        vm.startBroadcast();
        staking = new SwayStaking(msg.sender, IERC20(token), [t[0], t[1], t[2], t[3]]);
        staking.setKeys(keys);
        if (admin != msg.sender) staking.transferOwnership(admin);
        vm.stopBroadcast();

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        if (vm.exists(path)) vm.writeJson(vm.toString(address(staking)), path, ".swayStaking");
        console2.log("SwayStaking   ", address(staking));
        if (admin != msg.sender) console2.log("Pending owner (must acceptOwnership):", admin);
    }
}

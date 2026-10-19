// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SwayKeys} from "../src/SwayKeys.sol";
import {FanEscrow} from "../src/FanEscrow.sol";
import {SwayStaking} from "../src/SwayStaking.sol";
import {GenesisPass} from "../src/GenesisPass.sol";
import {SwayLaunchpad, ISwayKeysMarkets} from "../src/SwayLaunchpad.sol";
import {SwayDrops} from "../src/SwayDrops.sol";

/// @dev Local/testnet stand-in for $SWAY, which doesn't exist yet. Never deployed when SWAY_TOKEN is set.
contract DevSway is ERC20 {
    constructor(address to) ERC20("Sway (dev)", "SWAY") {
        _mint(to, 1_000_000_000 ether);
    }
}

/// @notice Deploys and wires every Sway contract, then writes deployments/<chainId>.json.
/// Env:
///   ADMIN          final owner (multisig behind a timelock on testnet/mainnet). Defaults to the deployer.
///   TREASURY       protocol treasury. Defaults to ADMIN.
///   OPERATOR       backend operator (opens markets, referrers, fan claims). Defaults to the deployer.
///   FAN_ADMIN      opens fan markets. Defaults to OPERATOR.
///   ISSUER         Genesis minter. Defaults to OPERATOR.
///   LAUNCH_SIGNER  signs launchpad terms. Defaults to OPERATOR.
///   SWAY_TOKEN     $SWAY address. If unset a DevSway token is deployed (dev chains only).
///   GENESIS_BASE_URI
/// Mainnet (chain 4663) requires ALLOW_MAINNET=1: the contracts are unaudited.
contract Deploy is Script {
    struct Config {
        address deployer;
        address admin;
        address treasury;
        address operator;
        address fanAdmin;
        address issuer;
        address launchSigner;
        address swayToken;
        string baseURI;
    }

    struct Deployed {
        SwayKeys keys;
        FanEscrow escrow;
        SwayStaking staking;
        GenesisPass pass;
        SwayLaunchpad launchpad;
        SwayDrops drops;
        address swayToken;
    }

    function _config() internal view returns (Config memory c) {
        c.deployer = msg.sender;
        c.admin = vm.envOr("ADMIN", c.deployer);
        c.treasury = vm.envOr("TREASURY", c.admin);
        c.operator = vm.envOr("OPERATOR", c.deployer);
        c.fanAdmin = vm.envOr("FAN_ADMIN", c.operator);
        c.issuer = vm.envOr("ISSUER", c.operator);
        c.launchSigner = vm.envOr("LAUNCH_SIGNER", c.operator);
        c.swayToken = vm.envOr("SWAY_TOKEN", address(0));
        c.baseURI = vm.envOr("GENESIS_BASE_URI", string("https://sway.fam/genesis/"));
    }

    function run() external {
        Config memory c = _config();
        if (block.chainid == 4663) {
            require(vm.envOr("ALLOW_MAINNET", uint256(0)) == 1, "unaudited: set ALLOW_MAINNET=1 after the audit");
            require(c.swayToken != address(0), "SWAY_TOKEN required on mainnet");
        }
        uint256 startBlock = block.number;
        vm.startBroadcast();
        Deployed memory d = _deploy(c);
        _wire(c, d);
        vm.stopBroadcast();
        _write(c, d, startBlock);
    }

    function _deploy(Config memory c) internal returns (Deployed memory d) {
        d.keys = new SwayKeys(c.deployer, c.treasury);
        d.escrow = new FanEscrow(c.deployer);
        d.swayToken = c.swayToken == address(0) ? address(new DevSway(c.admin)) : c.swayToken;
        d.staking = new SwayStaking(
            c.deployer, IERC20(d.swayToken), [uint256(1_000 ether), 10_000 ether, 50_000 ether, 250_000 ether]
        );
        d.pass = new GenesisPass(c.deployer, c.issuer, c.baseURI);
        d.launchpad = new SwayLaunchpad(c.deployer, ISwayKeysMarkets(address(d.keys)), c.launchSigner);
        d.drops = new SwayDrops();
    }

    function _wire(Config memory c, Deployed memory d) internal {
        d.keys.setOperator(c.operator, true);
        d.keys.setFanAdmin(c.fanAdmin, true);
        d.keys.setFanEscrow(address(d.escrow));
        d.keys.setStaking(address(d.staking));
        d.escrow.setKeys(address(d.keys));
        d.staking.setKeys(address(d.keys));
        if (c.admin != c.deployer) {
            d.keys.transferOwnership(c.admin);
            d.escrow.transferOwnership(c.admin);
            d.staking.transferOwnership(c.admin);
            d.pass.transferOwnership(c.admin);
            d.launchpad.transferOwnership(c.admin);
        }
    }

    function _write(Config memory c, Deployed memory d, uint256 startBlock) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "startBlock", startBlock);
        vm.serializeAddress(k, "admin", c.admin);
        vm.serializeAddress(k, "treasury", c.treasury);
        vm.serializeAddress(k, "operator", c.operator);
        vm.serializeAddress(k, "swayToken", d.swayToken);
        vm.serializeAddress(k, "swayKeys", address(d.keys));
        vm.serializeAddress(k, "fanEscrow", address(d.escrow));
        vm.serializeAddress(k, "swayStaking", address(d.staking));
        vm.serializeAddress(k, "genesisPass", address(d.pass));
        vm.serializeAddress(k, "launchpad", address(d.launchpad));
        string memory json = vm.serializeAddress(k, "drops", address(d.drops));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console2.log("SwayKeys      ", address(d.keys));
        console2.log("FanEscrow     ", address(d.escrow));
        console2.log("SwayStaking   ", address(d.staking));
        console2.log("GenesisPass   ", address(d.pass));
        console2.log("SwayLaunchpad ", address(d.launchpad));
        console2.log("SwayDrops     ", address(d.drops));
        if (c.admin != c.deployer) console2.log("Pending owner (must acceptOwnership on each):", c.admin);
    }
}

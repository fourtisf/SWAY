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
import {IUniswapV2RouterLike} from "../src/interfaces/IUniswapV2.sol";
import {DevV2Router} from "./DevUniswapV2.sol";

/// @dev Local/testnet stand-in for $SWAY, which doesn't exist yet. Never deployed when SWAY_TOKEN is set.
contract DevSway is ERC20 {
    constructor(address to) ERC20("Sway (dev)", "SWAY") {
        _mint(to, 1_000_000_000 ether);
    }
}

// Robinhood Chain's Uniswap V2 (developers.uniswap.org v2 deployments; the factory is also in Uniswap
// governance's Robinhood Chain fee proposal). The router is accepted only if it reports this factory.
address constant ROBINHOOD_V2_ROUTER = 0x89e5DB8B5aA49aA85AC63f691524311AEB649eba;
address constant ROBINHOOD_V2_FACTORY = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f;

/// @dev The router a launchpad graduates into: the given one, Uniswap's on mainnet, else a fresh DevV2Router.
function uniswapV2Router(address given, bool mainnet) returns (IUniswapV2RouterLike router) {
    if (given == address(0)) given = mainnet ? ROBINHOOD_V2_ROUTER : address(new DevV2Router());
    router = IUniswapV2RouterLike(given);
    if (mainnet) {
        require(given.code.length > 0, "UNISWAP_V2_ROUTER has no code on this chain");
        require(router.factory() == ROBINHOOD_V2_FACTORY, "UNISWAP_V2_ROUTER isn't Uniswap V2 on Robinhood Chain");
        require(router.WETH().code.length > 0, "the router's WETH has no code");
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
///   DEPLOY_LAUNCHPAD  1 to deploy SwayLaunchpad on mainnet too (otherwise deploy/setup-launchpad.sh adds it).
///   UNISWAP_V2_ROUTER where graduated launches get their pool. Mainnet defaults to Uniswap's Router02 on Robinhood
///                  Chain (checked against its factory); elsewhere a DevV2Router is deployed when unset.
/// Mainnet (chain 4663) requires ALLOW_MAINNET=1 (the contracts have no third-party audit) and an ADMIN that
/// isn't the deployer (the deployer is the server's operator key), unless the owner opts into one key for both
/// with ALLOW_SINGLE_KEY=1. Without SWAY_TOKEN, mainnet gets no staking
/// (the stakers' half of the protocol fee goes to the treasury) and never a DevSway.
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
        address v2Router;
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
        c.v2Router = vm.envOr("UNISWAP_V2_ROUTER", address(0));
        c.baseURI = vm.envOr("GENESIS_BASE_URI", string("https://swayfamily.com/genesis/"));
    }

    function run() external {
        Config memory c = _config();
        bool mainnet = block.chainid == 4663;
        if (mainnet) {
            require(vm.envOr("ALLOW_MAINNET", uint256(0)) == 1, "unaudited: set ALLOW_MAINNET=1 after the audit");
            require(
                c.admin != c.deployer || vm.envOr("ALLOW_SINGLE_KEY", uint256(0)) == 1,
                "mainnet: set ADMIN to a separate wallet (ideally a Safe), or ALLOW_SINGLE_KEY=1 to keep one key"
            );
        }
        uint256 startBlock = block.number;
        vm.startBroadcast();
        Deployed memory d = _deploy(c, mainnet);
        _wire(c, d);
        vm.stopBroadcast();
        _write(c, d, startBlock);
    }

    function _deploy(Config memory c, bool mainnet) internal returns (Deployed memory d) {
        d.keys = new SwayKeys(c.deployer, c.treasury);
        d.escrow = new FanEscrow(c.deployer);
        if (c.swayToken != address(0) || !mainnet) {
            d.swayToken = c.swayToken == address(0) ? address(new DevSway(c.admin)) : c.swayToken;
            d.staking = new SwayStaking(
                c.deployer, IERC20(d.swayToken), [uint256(1_000 ether), 10_000 ether, 50_000 ether, 250_000 ether]
            );
        }
        d.pass = new GenesisPass(c.deployer, c.issuer, c.baseURI);
        if (!mainnet || vm.envOr("DEPLOY_LAUNCHPAD", uint256(0)) == 1) {
            d.launchpad = new SwayLaunchpad(
                c.deployer, ISwayKeysMarkets(address(d.keys)), c.launchSigner, uniswapV2Router(c.v2Router, mainnet)
            );
        }
        d.drops = new SwayDrops();
    }

    function _wire(Config memory c, Deployed memory d) internal {
        d.keys.setOperator(c.operator, true);
        d.keys.setFanAdmin(c.fanAdmin, true);
        d.keys.setFanEscrow(address(d.escrow));
        d.escrow.setKeys(address(d.keys));
        if (address(d.staking) != address(0)) {
            d.keys.setStaking(address(d.staking));
            d.staking.setKeys(address(d.keys));
        }
        if (c.admin != c.deployer) {
            d.keys.transferOwnership(c.admin);
            d.escrow.transferOwnership(c.admin);
            if (address(d.staking) != address(0)) d.staking.transferOwnership(c.admin);
            d.pass.transferOwnership(c.admin);
            if (address(d.launchpad) != address(0)) d.launchpad.transferOwnership(c.admin);
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

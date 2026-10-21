// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwayKeys} from "../../src/SwayKeys.sol";
import {SwayLaunchpad, ISwayKeysMarkets} from "../../src/SwayLaunchpad.sol";
import {SwayCreatorToken} from "../../src/SwayCreatorToken.sol";
import {uniswapV2Router} from "../../script/Deploy.s.sol";

interface IPairReserves {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

/// @notice A launch graduating into the real Uniswap V2 on Robinhood Chain, on a fork of mainnet (no transaction
///         is sent). Skipped unless ROBINHOOD_RPC is set; setup-chain.sh --launchpad runs it before deploying:
///   ROBINHOOD_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path test/fork/RobinhoodUniswap.t.sol
contract RobinhoodUniswapForkTest is Test {
    function test_graduationSeedsTheRealUniswapPool() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 4663);
        (SwayLaunchpad pad, address token) = _launch();
        address pair = pad.pairOf(token);
        assertGt(pair.code.length, 0, "Uniswap pair created at launch");

        address buyer = makeAddr("buyer");
        vm.deal(buyer, 10 ether);
        (, uint256 fee, uint256 spent) = pad.quoteBuy(token, 5 ether);
        vm.prank(buyer);
        pad.buy{value: 5 ether}(token, 0);
        assertEq(buyer.balance, 10 ether - spent, "the buy stops at the graduation cap; the rest is refunded");
        (,,,,,, bool graduated, bool migrated) = pad.curves(token);
        assertTrue(graduated && migrated);
        assertTrue(SwayCreatorToken(token).pairOpen());

        IPairReserves p = IPairReserves(pair);
        (uint112 r0, uint112 r1,) = p.getReserves();
        (uint256 tokenRes, uint256 wethRes) = p.token0() == token ? (r0, r1) : (r1, r0);
        assertEq(wethRes, spent - fee, "all of the curve's ETH in the pool");
        assertEq(tokenRes, IERC20(token).balanceOf(pair));
        assertApproxEqRel((wethRes * pad.TOTAL_SUPPLY()) / tokenRes, 3 ether, 1e15, "pool opens at the graduation cap");
        assertEq(p.balanceOf(pad.DEAD()) + 1_000, p.totalSupply(), "LP burned");
    }

    /// @dev Fresh SwayKeys and launchpad on the fork (the router is checked against Uniswap's factory), then a
    ///      creator's launch with a 1 ETH start cap and a 3 ETH graduation cap.
    function _launch() internal returns (SwayLaunchpad pad, address token) {
        address operator = makeAddr("operator");
        (address signer, uint256 signerKey) = makeAddrAndKey("signer");
        address creator = makeAddr("creator");
        SwayKeys keys = new SwayKeys(address(this), address(this));
        keys.setOperator(operator, true);
        vm.prank(operator);
        keys.openMarket(creator, 4242);
        pad = new SwayLaunchpad(address(this), ISwayKeysMarkets(address(keys)), signer, uniswapV2Router(address(0), true));
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = pad.launchDigest(creator, "Fork", "FORK", 1 ether, 3 ether, bytes32(0), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        vm.prank(creator);
        token = pad.launch("Fork", "FORK", 1 ether, 3 ether, bytes32(0), deadline, abi.encodePacked(r, s, v));
    }
}

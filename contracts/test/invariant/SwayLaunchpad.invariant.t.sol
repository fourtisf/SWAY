// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwayKeys} from "../../src/SwayKeys.sol";
import {SwayLaunchpad, ISwayKeysMarkets} from "../../src/SwayLaunchpad.sol";
import {IUniswapV2RouterLike} from "../../src/interfaces/IUniswapV2.sol";
import {DevV2Router} from "../../script/DevUniswapV2.sol";

/// @dev Random buys, sells, fee claims, airdrop claims and attempts to seed the pool early, over two launches.
contract PadHandler is Test {
    SwayLaunchpad public pad;
    address[] public tokens;
    address[] public creators;
    address[] public actors;
    /// @dev Per token: ETH and tokens the curve held when it graduated (zero before).
    mapping(address => uint256) public migratedEth;
    mapping(address => uint256) public migratedTokens;
    /// @dev Per token: what the pool held right after graduation (trading may add to it later).
    mapping(address => uint256) public poolTokensAtGraduation;
    mapping(address => uint256) public poolWethAtGraduation;
    IERC20 public weth;

    constructor(SwayLaunchpad p, address[] memory t, address[] memory c, address[] memory a) {
        pad = p;
        weth = IERC20(p.weth());
        tokens = t;
        creators = c;
        actors = a;
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    struct Before {
        uint256 eth;
        uint256 tokens;
        uint256 fees;
        uint256 balance;
    }

    function buy(uint256 a, uint256 t, uint256 ethIn) external {
        address actor = actors[a % actors.length];
        address token = tokens[t % tokens.length];
        address creator = creators[t % creators.length];
        ethIn = bound(ethIn, 1 gwei, 8 ether);
        vm.deal(actor, actor.balance + ethIn);
        Before memory b;
        (,, b.eth, b.tokens,,,,) = pad.curves(token);
        b.fees = pad.creatorFees(creator);
        b.balance = actor.balance;
        vm.prank(actor);
        try pad.buy{value: ethIn}(token, 0) returns (uint256 out) {
            _afterBuy(token, creator, actor, b, out);
        } catch {}
    }

    /// @dev On the graduating buy, records what the curve handed to the pool, from the buyer's side of the books.
    function _afterBuy(address token, address creator, address actor, Before memory b, uint256 out) internal {
        (,,,,,,, bool migrated) = pad.curves(token);
        if (!migrated || migratedEth[token] != 0) return;
        uint256 spent = b.balance - actor.balance;
        migratedEth[token] = b.eth + spent - (pad.creatorFees(creator) - b.fees);
        migratedTokens[token] = b.tokens - out;
        poolTokensAtGraduation[token] = IERC20(token).balanceOf(pad.pairOf(token));
        poolWethAtGraduation[token] = weth.balanceOf(pad.pairOf(token));
    }

    function sell(uint256 a, uint256 t, uint256 frac) external {
        address actor = actors[a % actors.length];
        address token = tokens[t % tokens.length];
        uint256 bal = IERC20(token).balanceOf(actor);
        if (bal == 0) return;
        uint256 amount = bound(frac, 1, bal);
        vm.startPrank(actor);
        IERC20(token).approve(address(pad), amount);
        try pad.sell(token, amount, 0) {} catch {}
        vm.stopPrank();
    }

    function claimFees(uint256 c) external {
        vm.prank(creators[c % creators.length]);
        try pad.claimCreatorFees() {} catch {}
    }

    /// @dev Each creator's one-leaf airdrop (the whole 10% to themselves).
    function claimAirdrop(uint256 c) external {
        address creator = creators[c % creators.length];
        vm.prank(creator);
        try pad.claimAirdrop(tokens[c % creators.length], pad.HOLDER_ALLOCATION(), new bytes32[](0)) {} catch {}
    }

    /// @dev Anyone trying to put tokens in the pool before graduation.
    function seedPool(uint256 a, uint256 t, uint256 amount) external {
        address actor = actors[a % actors.length];
        address token = tokens[t % tokens.length];
        uint256 bal = IERC20(token).balanceOf(actor);
        if (bal == 0) return;
        address pair = pad.pairOf(token);
        vm.prank(actor);
        try IERC20(token).transfer(pair, bound(amount, 1, bal)) {} catch {}
    }
}

contract SwayLaunchpadInvariantTest is Test {
    SwayLaunchpad internal pad;
    DevV2Router internal router;
    PadHandler internal handler;
    address[] internal tokens;
    address[] internal creators;

    function setUp() public {
        vm.warp(1_700_000_000);
        (address signer, uint256 signerKey) = makeAddrAndKey("signer");
        address operator = makeAddr("operator");
        SwayKeys keys = new SwayKeys(address(this), makeAddr("treasury"));
        keys.setOperator(operator, true);
        router = new DevV2Router();
        pad = new SwayLaunchpad(address(this), ISwayKeysMarkets(address(keys)), signer, IUniswapV2RouterLike(address(router)));

        for (uint256 i; i < 2; ++i) {
            address creator = makeAddr(string.concat("creator", vm.toString(i)));
            vm.prank(operator);
            keys.openMarket(creator, uint64(100 + i));
            // One-leaf tree: the whole 10% to the creator (leaf = root, empty proof).
            bytes32 root = keccak256(bytes.concat(keccak256(abi.encode(creator, uint256(100_000_000 ether)))));
            uint256 deadline = block.timestamp + 1 hours;
            // Two graduation caps, so one curve graduates early in a run and the other later or never.
            uint256 grad = i == 0 ? 6 ether : 40 ether;
            bytes32 digest = pad.launchDigest(creator, "T", "T", 1 ether, grad, root, deadline);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
            vm.prank(creator);
            tokens.push(pad.launch("T", "T", 1 ether, grad, root, deadline, abi.encodePacked(r, s, v)));
            creators.push(creator);
        }
        address[] memory actors = new address[](3);
        actors[0] = makeAddr("a0");
        actors[1] = makeAddr("a1");
        actors[2] = makeAddr("a2");
        handler = new PadHandler(pad, tokens, creators, actors);
        targetContract(address(handler));
    }

    /// @notice Every wei the launchpad holds is a curve's reserve or a creator's unclaimed fee.
    function invariant_ethSolvent() public view {
        uint256 owed;
        for (uint256 i; i < tokens.length; ++i) {
            (,, uint256 ethReserve,,,,,) = pad.curves(tokens[i]);
            owed += ethReserve + pad.creatorFees(creators[i]);
        }
        assertEq(address(pad).balance, owed);
    }

    /// @notice The launchpad holds exactly the curve's tokens plus the unclaimed airdrop.
    function invariant_tokensAccounted() public view {
        for (uint256 i; i < tokens.length; ++i) {
            (,,, uint256 tokenReserve,,,,) = pad.curves(tokens[i]);
            uint256 held = IERC20(tokens[i]).balanceOf(address(pad));
            assertEq(held, tokenReserve + pad.HOLDER_ALLOCATION() - pad.airdropped(tokens[i]));
        }
    }

    /// @notice Before graduation nothing is in the pool; graduation puts exactly the curve's ETH and the tokens at
    ///         its last price there, burns the rest of the curve and empties it. (Trading may add to the pool after.)
    function invariant_poolOnlyAtGraduation() public view {
        address weth = router.WETH();
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            address pair = pad.pairOf(token);
            (, uint256 virtualEth, uint256 ethReserve, uint256 tokenReserve, uint256 grad,, bool graduated, bool migrated) =
                pad.curves(token);
            assertEq(graduated, migrated);
            if (!migrated) {
                assertEq(IERC20(token).balanceOf(pair), 0, "no tokens in the pool before graduation");
                assertEq(IERC20(weth).balanceOf(pair), 0);
                assertLt(pad.marketCap(token), grad);
                continue;
            }
            assertEq(ethReserve + tokenReserve, 0, "curve emptied");
            uint256 eth = handler.migratedEth(token);
            uint256 left = handler.migratedTokens(token);
            uint256 pooled = handler.poolTokensAtGraduation(token);
            assertEq(handler.poolWethAtGraduation(token), eth);
            assertEq(pooled, (eth * left) / (virtualEth + eth), "pool at the curve's last price");
            assertEq(IERC20(token).balanceOf(pad.DEAD()) + pooled, left, "the rest of the curve burned");
            // However large the last buy, the pool opens at the graduation market cap.
            assertApproxEqRel((eth * pad.TOTAL_SUPPLY()) / pooled, grad, 1e15, "pool opens at the graduation cap");
            assertGe(IERC20(token).balanceOf(pair), pooled);
        }
    }
}

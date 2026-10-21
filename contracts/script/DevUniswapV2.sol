// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Local/testnet stand-in for Uniswap V2 (factory, pair mint, WETH), so a launch can graduate where
///      Uniswap isn't deployed. Pair.mint follows Uniswap V2's math (first mint burns MINIMUM_LIQUIDITY).
///      There is no swap: never deployed on mainnet, which uses the real Uniswap V2.
contract DevWETH is ERC20 {
    constructor() ERC20("Wrapped Ether (dev)", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "ETH transfer failed");
    }
}

contract DevV2Pair {
    uint256 public constant MINIMUM_LIQUIDITY = 1_000;
    address public immutable token0;
    address public immutable token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }

    function mint(address to) external returns (uint256 liquidity) {
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        uint256 a0 = b0 - reserve0;
        uint256 a1 = b1 - reserve1;
        if (totalSupply == 0) {
            liquidity = Math.sqrt(a0 * a1) - MINIMUM_LIQUIDITY;
            totalSupply = MINIMUM_LIQUIDITY;
        } else {
            liquidity = Math.min((a0 * totalSupply) / reserve0, (a1 * totalSupply) / reserve1);
        }
        require(liquidity > 0, "INSUFFICIENT_LIQUIDITY_MINTED");
        totalSupply += liquidity;
        balanceOf[to] += liquidity;
        _sync(b0, b1);
    }

    function sync() external {
        _sync(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)));
    }

    function _sync(uint256 b0, uint256 b1) internal {
        reserve0 = uint112(b0);
        reserve1 = uint112(b1);
    }
}

contract DevV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address a, address b) external returns (address pair) {
        require(a != b && getPair[a][b] == address(0), "PAIR_EXISTS");
        pair = address(new DevV2Pair(a, b));
        getPair[a][b] = pair;
        getPair[b][a] = pair;
    }
}

contract DevV2Router {
    address public immutable factory;
    address public immutable WETH;

    constructor() {
        factory = address(new DevV2Factory());
        WETH = address(new DevWETH());
    }
}

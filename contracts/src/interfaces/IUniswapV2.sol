// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev The few Uniswap V2 calls the launchpad makes when a curve graduates.
interface IUniswapV2RouterLike {
    function factory() external view returns (address);
    function WETH() external view returns (address);
}

interface IUniswapV2FactoryLike {
    function getPair(address tokenA, address tokenB) external view returns (address);
    function createPair(address tokenA, address tokenB) external returns (address);
}

interface IUniswapV2PairLike {
    function mint(address to) external returns (uint256 liquidity);
}

interface IWETHLike {
    function deposit() external payable;
}

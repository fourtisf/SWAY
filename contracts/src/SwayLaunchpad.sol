// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SwayCreatorToken} from "./SwayCreatorToken.sol";

interface ISwayKeysMarkets {
    function markets(address subject)
        external
        view
        returns (address owner, uint64 xId, uint40 openedAt, uint40 firstTradeAt, bool fan, bool halted, uint256 supply, uint256 accPerUnit);
}

/// @title SwayLaunchpad
/// @notice "Launch your reach as a token with one switch." A creator with a key market launches a
///         1B-supply token. 90% trades on a virtual constant-product curve whose starting market cap is
///         seeded by their Sway score; 10% is airdropped to their key holders (merkle root of key balances
///         at launch). 1% of every trade goes to the creator. At the graduation market cap the curve
///         closes and the owner (multisig) migrates the liquidity to a pool.
/// @dev Launch terms (start cap, graduation cap, holder airdrop root) come from an EIP-712 attestation
///      signed by the Sway operator, so a creator can't choose their own airdrop list.
///      PLACEHOLDER TERMS, UNAUDITED. Pool migration target is to be decided.
contract SwayLaunchpad is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant HOLDER_ALLOCATION = 100_000_000 ether; // 10%
    uint256 public constant CURVE_SUPPLY = TOTAL_SUPPLY - HOLDER_ALLOCATION;
    uint256 public constant CREATOR_FEE_BPS = 100; // 1%
    uint256 public constant BPS = 10_000;

    bytes32 public constant LAUNCH_TYPEHASH = keccak256(
        "Launch(address creator,string name,string symbol,uint256 startCapWei,uint256 graduationCapWei,bytes32 airdropRoot,uint256 deadline)"
    );

    struct Curve {
        address creator;
        /// @dev Virtual ETH reserve at launch; price0 = virtualEth / CURVE_SUPPLY.
        uint256 virtualEth;
        /// @dev Real ETH collected by the curve (excluding creator fees).
        uint256 ethReserve;
        /// @dev Tokens still on the curve.
        uint256 tokenReserve;
        uint256 graduationCapWei;
        bytes32 airdropRoot;
        bool graduated;
        bool migrated;
    }

    ISwayKeysMarkets public immutable keys;
    address public signer;

    mapping(address token => Curve) public curves;
    mapping(address creator => address token) public tokenOf;
    mapping(address token => mapping(address account => bool)) public airdropClaimed;
    mapping(address creator => uint256) public creatorFees;

    event Launched(address indexed creator, address indexed token, string symbol, uint256 startCapWei, uint256 graduationCapWei, bytes32 airdropRoot);
    event Traded(address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 creatorFee, uint256 ethReserve, uint256 tokenReserve);
    event Graduated(address indexed token, uint256 ethReserve, uint256 tokenReserve);
    event Migrated(address indexed token, address to, uint256 eth, uint256 tokens);
    event AirdropClaimed(address indexed token, address indexed account, uint256 amount);
    event CreatorFeesClaimed(address indexed creator, uint256 amount);
    event SignerSet(address signer);

    error NoKeyMarket();
    error AlreadyLaunched();
    error Expired();
    error BadSignature();
    error BadTerms();
    error UnknownToken();
    error CurveClosed();
    error NotGraduated();
    error AlreadyMigrated();
    error Slippage();
    error ZeroAmount();
    error AlreadyClaimed();
    error BadProof();
    error TransferFailed();

    constructor(address initialOwner, ISwayKeysMarkets keys_, address signer_) Ownable(initialOwner) EIP712("SwayLaunchpad", "1") {
        keys = keys_;
        signer = signer_;
        emit SignerSet(signer_);
    }

    function setSigner(address signer_) external onlyOwner {
        signer = signer_;
        emit SignerSet(signer_);
    }

    /* ------------------------------------------------------------------ launch */

    function launchDigest(
        address creator,
        string calldata name,
        string calldata symbol,
        uint256 startCapWei,
        uint256 graduationCapWei,
        bytes32 airdropRoot,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    LAUNCH_TYPEHASH,
                    creator,
                    keccak256(bytes(name)),
                    keccak256(bytes(symbol)),
                    startCapWei,
                    graduationCapWei,
                    airdropRoot,
                    deadline
                )
            )
        );
    }

    function launch(
        string calldata name,
        string calldata symbol,
        uint256 startCapWei,
        uint256 graduationCapWei,
        bytes32 airdropRoot,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant returns (address token) {
        if (block.timestamp > deadline) revert Expired();
        (address owner_,,,,,,,) = keys.markets(msg.sender);
        if (owner_ != msg.sender) revert NoKeyMarket();
        if (tokenOf[msg.sender] != address(0)) revert AlreadyLaunched();
        if (startCapWei == 0 || graduationCapWei <= startCapWei) revert BadTerms();
        bytes32 digest = launchDigest(msg.sender, name, symbol, startCapWei, graduationCapWei, airdropRoot, deadline);
        if (ECDSA.recover(digest, signature) != signer) revert BadSignature();

        token = address(new SwayCreatorToken(name, symbol, msg.sender, address(this), TOTAL_SUPPLY));
        tokenOf[msg.sender] = token;
        // market cap = price * TOTAL_SUPPLY and price0 = virtualEth / CURVE_SUPPLY
        curves[token] = Curve({
            creator: msg.sender,
            virtualEth: (startCapWei * CURVE_SUPPLY) / TOTAL_SUPPLY,
            ethReserve: 0,
            tokenReserve: CURVE_SUPPLY,
            graduationCapWei: graduationCapWei,
            airdropRoot: airdropRoot,
            graduated: false,
            migrated: false
        });
        emit Launched(msg.sender, token, symbol, startCapWei, graduationCapWei, airdropRoot);
    }

    /* ------------------------------------------------------------------ curve */

    /// @notice Current spot market cap in wei: (virtualEth + ethReserve) / tokenReserve * TOTAL_SUPPLY.
    function marketCap(address token) public view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        return ((c.virtualEth + c.ethReserve) * TOTAL_SUPPLY) / c.tokenReserve;
    }

    function quoteBuy(address token, uint256 ethIn) public view returns (uint256 tokensOut, uint256 fee) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        fee = (ethIn * CREATOR_FEE_BPS) / BPS;
        uint256 x = c.virtualEth + c.ethReserve;
        uint256 y = c.tokenReserve;
        uint256 net = ethIn - fee;
        // constant product, rounded against the buyer
        tokensOut = y - _divUp(x * y, x + net);
    }

    function quoteSell(address token, uint256 tokensIn) public view returns (uint256 ethOut, uint256 fee) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        uint256 x = c.virtualEth + c.ethReserve;
        uint256 y = c.tokenReserve;
        uint256 gross = x - _divUp(x * y, y + tokensIn);
        if (gross > c.ethReserve) gross = c.ethReserve;
        fee = (gross * CREATOR_FEE_BPS) / BPS;
        ethOut = gross - fee;
    }

    function buy(address token, uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.graduated) revert CurveClosed();
        if (msg.value == 0) revert ZeroAmount();
        uint256 fee;
        (tokensOut, fee) = quoteBuy(token, msg.value);
        if (tokensOut < minTokensOut || tokensOut == 0) revert Slippage();
        c.ethReserve += msg.value - fee;
        c.tokenReserve -= tokensOut;
        creatorFees[c.creator] += fee;
        emit Traded(token, msg.sender, true, msg.value, tokensOut, fee, c.ethReserve, c.tokenReserve);
        if (marketCap(token) >= c.graduationCapWei) {
            c.graduated = true;
            emit Graduated(token, c.ethReserve, c.tokenReserve);
        }
        IERC20(token).safeTransfer(msg.sender, tokensOut);
    }

    function sell(address token, uint256 tokensIn, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.graduated) revert CurveClosed();
        if (tokensIn == 0) revert ZeroAmount();
        uint256 fee;
        (ethOut, fee) = quoteSell(token, tokensIn);
        if (ethOut < minEthOut) revert Slippage();
        c.ethReserve -= ethOut + fee;
        c.tokenReserve += tokensIn;
        creatorFees[c.creator] += fee;
        emit Traded(token, msg.sender, false, ethOut, tokensIn, fee, c.ethReserve, c.tokenReserve);
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        _send(msg.sender, ethOut);
    }

    /* ------------------------------------------------------------------ airdrop, fees, migration */

    /// @notice Key holders claim their share of the 10% allocation. Leaf = keccak256(abi.encode(account, amount)).
    function claimAirdrop(address token, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (airdropClaimed[token][msg.sender]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, amount))));
        if (!MerkleProof.verifyCalldata(proof, c.airdropRoot, leaf)) revert BadProof();
        airdropClaimed[token][msg.sender] = true;
        emit AirdropClaimed(token, msg.sender, amount);
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    function claimCreatorFees() external nonReentrant returns (uint256 amount) {
        amount = creatorFees[msg.sender];
        if (amount == 0) revert ZeroAmount();
        creatorFees[msg.sender] = 0;
        emit CreatorFeesClaimed(msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// @notice After graduation, moves the curve's ETH and remaining curve tokens to seed a pool.
    function migrate(address token, address to) external onlyOwner nonReentrant {
        Curve storage c = curves[token];
        if (!c.graduated) revert NotGraduated();
        if (c.migrated) revert AlreadyMigrated();
        c.migrated = true;
        uint256 eth = c.ethReserve;
        uint256 tokens = c.tokenReserve;
        c.ethReserve = 0;
        c.tokenReserve = 0;
        emit Migrated(token, to, eth, tokens);
        IERC20(token).safeTransfer(to, tokens);
        _send(to, eth);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _divUp(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}

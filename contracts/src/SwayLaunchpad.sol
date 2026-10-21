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
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SwayCreatorToken} from "./SwayCreatorToken.sol";
import {IUniswapV2FactoryLike, IUniswapV2PairLike, IUniswapV2RouterLike, IWETHLike} from "./interfaces/IUniswapV2.sol";

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
///         at launch). 1% of every trade goes to the creator. The buy that reaches the graduation market cap
///         closes the curve and moves its liquidity into the token's Uniswap V2 pool in the same transaction.
/// @dev Launch terms (start cap, graduation cap, holder airdrop root) come from an EIP-712 attestation
///      signed by the Sway operator, so a creator can't choose their own airdrop list.
///      Graduation: all of the curve's ETH plus the tokens that match it at the curve's last price go into the
///      pool, the LP tokens and the curve's leftover tokens are burned. No one, the owner included, can move
///      the liquidity anywhere else. The pair is created at launch and the token refuses transfers into it
///      until then, so nobody can seed the pool at another price first.
///      PLACEHOLDER TERMS, UNAUDITED.
contract SwayLaunchpad is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant HOLDER_ALLOCATION = 100_000_000 ether; // 10%
    uint256 public constant CURVE_SUPPLY = TOTAL_SUPPLY - HOLDER_ALLOCATION;
    uint256 public constant CREATOR_FEE_BPS = 100; // 1%
    uint256 public constant BPS = 10_000;
    /// @dev Where graduation sends the LP tokens and leftover curve tokens (ERC-20s refuse address(0)).
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

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
    IUniswapV2FactoryLike public immutable factory;
    address public immutable weth;
    address public signer;

    mapping(address token => Curve) public curves;
    mapping(address creator => address token) public tokenOf;
    mapping(address token => mapping(address account => bool)) public airdropClaimed;
    /// @notice Airdrop tokens paid out per launch: never more than HOLDER_ALLOCATION, whatever the root says,
    ///         so a bad root can't reach the curve's tokens.
    mapping(address token => uint256) public airdropped;
    mapping(address creator => uint256) public creatorFees;
    /// @notice The token's Uniswap V2 pair with WETH, created at launch.
    mapping(address token => address) public pairOf;

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
    error ZeroAddress();
    error Slippage();
    error ZeroAmount();
    error AlreadyClaimed();
    error BadProof();
    error AirdropExceeded();
    error TransferFailed();

    constructor(address initialOwner, ISwayKeysMarkets keys_, address signer_, IUniswapV2RouterLike router)
        Ownable(initialOwner)
        EIP712("SwayLaunchpad", "1")
    {
        keys = keys_;
        factory = IUniswapV2FactoryLike(router.factory());
        weth = router.WETH();
        if (address(factory) == address(0) || weth == address(0)) revert ZeroAddress();
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
        // Token addresses are predictable, so the pair may exist already: it can't hold any of the token yet.
        address pair = factory.getPair(token, weth);
        if (pair == address(0)) pair = factory.createPair(token, weth);
        pairOf[token] = pair;
        SwayCreatorToken(token).setPair(pair);
    }

    /* ------------------------------------------------------------------ curve */

    /// @notice Current spot market cap in wei: (virtualEth + ethReserve) / tokenReserve * TOTAL_SUPPLY. Zero once
    ///         the curve has moved into its Uniswap pool (price it there).
    function marketCap(address token) public view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.tokenReserve == 0) return 0;
        return ((c.virtualEth + c.ethReserve) * TOTAL_SUPPLY) / c.tokenReserve;
    }

    /// @notice What a buy of `ethIn` gets: tokens out, the 1% creator fee and the ETH it spends. A buy that would
    ///         carry the market cap past the graduation cap spends only what reaches it; the rest is refunded, so
    ///         the pool opens at the graduation price rather than wherever one large buy pushed the curve.
    function quoteBuy(address token, uint256 ethIn) public view returns (uint256 tokensOut, uint256 fee, uint256 spent) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        (tokensOut, fee, spent,) = _quoteBuy(c, ethIn);
    }

    function _quoteBuy(Curve storage c, uint256 ethIn)
        internal
        view
        returns (uint256 tokensOut, uint256 fee, uint256 spent, bool capped)
    {
        uint256 x = c.virtualEth + c.ethReserve;
        uint256 y = c.tokenReserve;
        spent = ethIn;
        fee = (ethIn * CREATOR_FEE_BPS) / BPS;
        uint256 net = ethIn - fee;
        // The curve's x at which the market cap, x^2 * TOTAL_SUPPLY / (x * y), reaches the graduation cap.
        uint256 xCap = Math.sqrt((c.graduationCapWei * x * y) / TOTAL_SUPPLY) + 1;
        if (x + net > xCap) {
            capped = true;
            net = xCap - x;
            spent = _divUp(net * BPS, BPS - CREATOR_FEE_BPS);
            fee = spent - net;
        }
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
        (uint256 out, uint256 fee, uint256 spent, bool capped) = _quoteBuy(c, msg.value);
        tokensOut = out;
        // A capped buy always graduates, even one so close to the cap that it buys no whole token unit.
        if (tokensOut < minTokensOut || (tokensOut == 0 && !capped)) revert Slippage();
        c.ethReserve += spent - fee;
        c.tokenReserve -= tokensOut;
        creatorFees[c.creator] += fee;
        emit Traded(token, msg.sender, true, spent, tokensOut, fee, c.ethReserve, c.tokenReserve);
        if (capped || marketCap(token) >= c.graduationCapWei) {
            c.graduated = true;
            emit Graduated(token, c.ethReserve, c.tokenReserve);
            _migrate(token, c);
        }
        IERC20(token).safeTransfer(msg.sender, tokensOut);
        if (spent < msg.value) _send(msg.sender, msg.value - spent);
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
        if (airdropped[token] + amount > HOLDER_ALLOCATION) revert AirdropExceeded();
        airdropped[token] += amount;
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

    /// @dev Seeds the pool at the curve's last price: all of its ETH (as WETH) and the tokens that match it. The
    ///      LP tokens and the curve's leftover tokens go to DEAD. WETH someone sent to the pair beforehand stays in
    ///      the pool (a gift to it); tokens can't have been sent there (SwayCreatorToken refuses until openPair).
    function _migrate(address token, Curve storage c) internal {
        uint256 eth = c.ethReserve;
        uint256 tokens = (eth * c.tokenReserve) / (c.virtualEth + eth);
        uint256 burned = c.tokenReserve - tokens;
        address pair = pairOf[token];
        c.migrated = true;
        c.ethReserve = 0;
        c.tokenReserve = 0;
        emit Migrated(token, pair, eth, tokens);
        IERC20(token).safeTransfer(pair, tokens);
        IWETHLike(weth).deposit{value: eth}();
        IERC20(weth).safeTransfer(pair, eth);
        IUniswapV2PairLike(pair).mint(DEAD);
        SwayCreatorToken(token).openPair();
        if (burned != 0) IERC20(token).safeTransfer(DEAD, burned);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _divUp(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}

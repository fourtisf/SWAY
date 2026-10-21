// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ISwayStaking} from "./interfaces/ISwayStaking.sol";
import {IFanEscrow} from "./interfaces/IFanEscrow.sol";

/// @title SwayKeys
/// @notice Creator-key markets on a bonding curve. Holding 1 key (100 units) of a creator opens their
///         room and holder-only posts. Keys are access, not shares: they cannot be transferred, only
///         bought from and sold back to the curve.
/// @dev Curve, in units (1 key = 100 units):
///        price(u)      = K * (u + 200)^2 / 1e4
///        cumulative(u) = K * (u + 200)^3 / 3e6
///        cost(a -> b)  = cumulative(b) - cumulative(a)
///      Flooring each cumulative value keeps cost path-independent, so a market's reserve is always
///      cumulative(supply) - cumulative(100). packages/curve mirrors this to the wei.
///      Fees on the curve price: creator 6%, protocol 2% (cut by staking level), holders 1%, referral 1%.
///      Every earning is credited here and pulled with claim(); nothing is pushed except trade proceeds,
///      buy change, and fan-market creator fees (to the trusted FanEscrow).
///      Joining costs Sway nothing onchain: the operator signs a Member permit offchain and whoever first needs
///      it onchain (usually the first buyer, via registerAndBuy) submits it and pays its gas.
///      UNAUDITED. Keep mainnet behind a flag until an audit report is published.
contract SwayKeys is Ownable2Step, ReentrancyGuard, Pausable, EIP712 {
    /* ------------------------------------------------------------------ constants */

    uint256 public constant K = 17_500_000_000_000; // 0.0000175 ETH
    uint256 public constant OFFSET_UNITS = 200; // O = 2 keys
    uint256 public constant CUBE_DIV = 3_000_000; // 3 * 100^3
    uint256 public constant SQUARE_DIV = 10_000; // 100^2
    uint256 public constant UNITS_PER_KEY = 100;
    uint256 public constant LOCKED_UNITS = 100; // the creator's first key

    uint256 public constant BPS = 10_000;
    uint256 public constant CREATOR_FEE_BPS = 600;
    uint256 public constant PROTOCOL_FEE_BPS = 200;
    uint256 public constant HOLDER_FEE_BPS = 100;
    uint256 public constant REFERRAL_FEE_BPS = 100;

    uint256 public constant SNIPE_MAX_UNITS = 1_000; // 10 keys
    uint256 public constant SNIPE_WINDOW = 5 minutes;

    /// @notice Anti-dump: selling within 24h of your last buy in a market costs an extra 5%, paid to holders.
    uint256 public constant ANTI_DUMP_BPS = 500;
    uint256 public constant ANTI_DUMP_WINDOW = 24 hours;

    uint256 internal constant ACC_PRECISION = 1e18;
    /// @dev Gas for reading a staking level: SwayStaking needs ~15k. Caps what a bad staking contract can burn.
    uint256 internal constant LEVEL_GAS = 50_000;

    bytes32 public constant MEMBER_TYPEHASH =
        keccak256("Member(address wallet,uint64 xId,address referrer,uint256 deadline)");

    /* ------------------------------------------------------------------ storage */

    struct Market {
        /// @dev address(0) while a fan market is unclaimed.
        address owner;
        uint64 xId;
        uint40 openedAt;
        /// @dev Starts the anti-snipe window.
        uint40 firstTradeAt;
        bool fan;
        /// @dev Buys blocked (takedown or dispute). Sells always work.
        bool halted;
        uint256 supply;
        /// @dev Holder fee per unit, scaled by 1e18.
        uint256 accPerUnit;
    }

    struct Earnings {
        uint256 creator;
        uint256 holder;
        uint256 referral;
        uint256 protocol;
    }

    struct Fees {
        uint256 creator;
        uint256 protocol;
        uint256 holder;
        uint256 referral;
    }

    /// @notice Operator-signed: `wallet` belongs to the X account `xId` (0 = no market part) and was invited by
    ///         `referrer` (0 = none).
    struct Member {
        address wallet;
        uint64 xId;
        address referrer;
        uint256 deadline;
    }

    mapping(address subject => Market) public markets;
    mapping(address subject => mapping(address holder => uint256 units)) public balanceOf;
    mapping(address subject => mapping(address holder => uint256 acc)) public rewardDebt;
    mapping(address account => Earnings) public earnings;
    mapping(address user => address) public referrerOf;
    mapping(uint64 xId => address subject) public subjectOfXId;
    mapping(address => bool) public isOperator;
    mapping(address => bool) public isFanAdmin;
    /// @notice Last time `holder` bought keys of `subject` (starts the anti-dump window).
    mapping(address subject => mapping(address holder => uint40)) public lastBuyAt;
    /// @notice Creator activity bond: while set (the creator hasn't posted in their room for 7 days), the 6%
    ///         creator fee goes to holders instead. Set and cleared by the operator from room activity.
    mapping(address subject => bool) public creatorInactive;

    address public treasury;
    ISwayStaking public staking;
    IFanEscrow public fanEscrow;

    /* ------------------------------------------------------------------ events */

    event MarketOpened(address indexed subject, address indexed owner, uint64 indexed xId, bool fan);
    event Trade(
        address indexed trader,
        address indexed subject,
        bool isBuy,
        uint256 units,
        uint256 ethBase,
        uint256 creatorFee,
        uint256 protocolFee,
        uint256 holderFee,
        uint256 referralFee,
        uint256 supplyAfter
    );
    event FanMarketClaimed(address indexed subject, address indexed owner, uint256 escrowReleased);
    event MarketHalted(address indexed subject, bool halted);
    event CreatorInactiveSet(address indexed subject, bool inactive);
    event ReferrerSet(address indexed user, address indexed referrer);
    event Claimed(address indexed account, uint256 creator, uint256 holder, uint256 referral, uint256 protocol);
    event OperatorSet(address indexed account, bool enabled);
    event FanAdminSet(address indexed account, bool enabled);
    event TreasurySet(address treasury);
    event StakingSet(address staking);
    event FanEscrowSet(address fanEscrow);

    /* ------------------------------------------------------------------ errors */

    error NotOperator();
    error NotFanAdmin();
    error ZeroAddress();
    error InvalidXId();
    error MarketExists();
    error XIdTaken();
    error MarketNotOpen();
    error NotFanMarket();
    error AlreadyClaimed();
    error MarketIsHalted();
    error ZeroUnits();
    error InsufficientPayment(uint256 required, uint256 sent);
    error InsufficientKeys();
    error Slippage(uint256 proceeds, uint256 minProceeds);
    error SnipeLimit();
    error ReferrerAlreadySet();
    error InvalidReferrer();
    error NothingToClaim();
    error TransferFailed();
    error UnexpectedEth();
    error FanEscrowAlreadySet();
    error Expired();
    error BadSignature();
    error LengthMismatch();

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert NotOperator();
        _;
    }

    modifier onlyFanAdmin() {
        if (!isFanAdmin[msg.sender]) revert NotFanAdmin();
        _;
    }

    constructor(address initialOwner, address treasury_) Ownable(initialOwner) EIP712("SwayKeys", "1") {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @dev Only FanEscrow sends ETH here (released escrow on claim).
    receive() external payable {
        if (msg.sender != address(fanEscrow)) revert UnexpectedEth();
    }

    /* ------------------------------------------------------------------ curve math */

    function priceAt(uint256 supplyUnits) public pure returns (uint256) {
        uint256 x = supplyUnits + OFFSET_UNITS;
        return (K * x * x) / SQUARE_DIV;
    }

    function cumulative(uint256 supplyUnits) public pure returns (uint256) {
        uint256 x = supplyUnits + OFFSET_UNITS;
        return (K * x * x * x) / CUBE_DIV;
    }

    /// @notice Deterministic placeholder subject for the fan market of X user `xId`.
    function fanSubject(uint64 xId) public pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("sway.fan", xId)))));
    }

    function protocolCutBps(uint8 level) public pure returns (uint256) {
        if (level == 0) return 0;
        if (level == 1) return 1_000;
        if (level == 2) return 2_500;
        if (level == 3) return 5_000;
        return 7_500;
    }

    /// @dev A failing or hostile staking contract must never block trading (sells included): the call gets
    ///      LEVEL_GAS, only 32 bytes of its answer are read, and anything odd reads as level 0.
    function levelOf(address trader) public view returns (uint8) {
        address s = address(staking);
        if (s == address(0)) return 0;
        bytes memory data = abi.encodeCall(ISwayStaking.levelOf, (trader));
        bool ok;
        uint256 size;
        uint256 word;
        assembly ("memory-safe") {
            ok := staticcall(LEVEL_GAS, s, add(data, 0x20), mload(data), 0x00, 0x20)
            size := returndatasize()
            word := mload(0x00)
        }
        if (!ok || size < 32 || word > 4) return 0;
        return uint8(word);
    }

    /// @dev The Trade event reports fees where they actually go: a redirected creator fee and the anti-dump
    ///      surcharge are part of `holderFee`.
    function _fees(uint256 base, address trader, address subject, bool isBuy) internal view returns (Fees memory f) {
        uint256 cut = protocolCutBps(levelOf(trader));
        f.creator = (base * CREATOR_FEE_BPS) / BPS;
        f.protocol = (base * PROTOCOL_FEE_BPS * (BPS - cut)) / (BPS * BPS);
        f.holder = (base * HOLDER_FEE_BPS) / BPS;
        f.referral = (base * REFERRAL_FEE_BPS) / BPS;
        if (creatorInactive[subject] && markets[subject].owner != address(0)) {
            f.holder += f.creator;
            f.creator = 0;
        }
        if (!isBuy && block.timestamp < uint256(lastBuyAt[subject][trader]) + ANTI_DUMP_WINDOW) {
            f.holder += (base * ANTI_DUMP_BPS) / BPS;
        }
    }

    function _feeTotal(Fees memory f) internal pure returns (uint256) {
        return f.creator + f.protocol + f.holder + f.referral;
    }

    /// @notice Full quote for `trader`. total = what a buyer pays / what a seller receives.
    function quote(address subject, uint256 units, bool isBuy, address trader)
        external
        view
        returns (uint256 base, uint256 creatorFee, uint256 protocolFee, uint256 holderFee, uint256 referralFee, uint256 total)
    {
        uint256 s = markets[subject].supply;
        if (s == 0) revert MarketNotOpen();
        if (isBuy) {
            base = cumulative(s + units) - cumulative(s);
        } else {
            if (s - LOCKED_UNITS < units) revert InsufficientKeys();
            base = cumulative(s) - cumulative(s - units);
        }
        Fees memory f = _fees(base, trader, subject, isBuy);
        (creatorFee, protocolFee, holderFee, referralFee) = (f.creator, f.protocol, f.holder, f.referral);
        uint256 fee = _feeTotal(f);
        total = isBuy ? base + fee : base - fee;
    }

    /* ------------------------------------------------------------------ markets */

    /// @notice Opens the key market of a member who signed in with X. The first key is minted to them
    ///         for free and can never be sold, so the room always has an owner.
    function openMarket(address owner_, uint64 xId) external onlyOperator {
        _openMarket(owner_, xId);
    }

    function _openMarket(address owner_, uint64 xId) internal {
        _requireNotPaused();
        if (owner_ == address(0)) revert ZeroAddress();
        if (xId == 0) revert InvalidXId();
        if (markets[owner_].supply != 0) revert MarketExists();
        if (subjectOfXId[xId] != address(0)) revert XIdTaken();
        markets[owner_] = Market({
            owner: owner_,
            xId: xId,
            openedAt: uint40(block.timestamp),
            firstTradeAt: 0,
            fan: false,
            halted: false,
            supply: LOCKED_UNITS,
            accPerUnit: 0
        });
        subjectOfXId[xId] = owner_;
        balanceOf[owner_][owner_] = LOCKED_UNITS;
        emit MarketOpened(owner_, owner_, xId, false);
    }

    /// @notice Opens a fan market for an X account that has not joined. Its creator fee is escrowed
    ///         until the account signs in with X and claims. The first key sits in FanEscrow.
    function openFanMarket(uint64 xId) external onlyFanAdmin whenNotPaused returns (address subject) {
        if (xId == 0) revert InvalidXId();
        if (address(fanEscrow) == address(0)) revert ZeroAddress();
        if (subjectOfXId[xId] != address(0)) revert XIdTaken();
        subject = fanSubject(xId);
        if (markets[subject].supply != 0) revert MarketExists();
        markets[subject] = Market({
            owner: address(0),
            xId: xId,
            openedAt: uint40(block.timestamp),
            firstTradeAt: 0,
            fan: true,
            halted: false,
            supply: LOCKED_UNITS,
            accPerUnit: 0
        });
        subjectOfXId[xId] = subject;
        balanceOf[subject][address(fanEscrow)] = LOCKED_UNITS;
        emit MarketOpened(subject, address(0), xId, true);
    }

    /// @notice Hands an unclaimed fan market to the X account's owner after they sign in with X.
    ///         They get the first key, its accrued holder rewards and the escrowed creator fees.
    ///         Existing holders keep their keys.
    function claimFanMarket(address subject, address newOwner) external onlyOperator nonReentrant {
        Market storage m = markets[subject];
        if (!m.fan) revert NotFanMarket();
        if (m.owner != address(0)) revert AlreadyClaimed();
        _claimFanMarket(subject, newOwner);
    }

    function _claimFanMarket(address subject, address newOwner) internal {
        Market storage m = markets[subject];
        address escrow = address(fanEscrow);
        if (newOwner == address(0) || newOwner == escrow) revert ZeroAddress();

        uint256 acc = m.accPerUnit;
        uint256 escrowUnits = balanceOf[subject][escrow];
        uint256 owed = (escrowUnits * (acc - rewardDebt[subject][escrow])) / ACC_PRECISION;
        balanceOf[subject][escrow] = 0;
        rewardDebt[subject][escrow] = acc;

        _settle(subject, newOwner);
        balanceOf[subject][newOwner] += escrowUnits;
        if (owed != 0) earnings[newOwner].holder += owed;
        m.owner = newOwner;

        uint256 released = IFanEscrow(escrow).release(subject);
        earnings[newOwner].creator += released;
        emit FanMarketClaimed(subject, newOwner, released);
    }

    /// @notice Creator activity bond, driven by room activity offchain: the operator flags a creator who
    ///         hasn't posted in their room for 7 days and clears the flag when they post again.
    function setCreatorInactive(address subject, bool inactive) external onlyOperator {
        Market storage m = markets[subject];
        if (m.supply == 0) revert MarketNotOpen();
        if (m.owner == address(0)) revert NotFanMarket();
        creatorInactive[subject] = inactive;
        emit CreatorInactiveSet(subject, inactive);
    }

    function setMarketHalted(address subject, bool halted) external onlyFanAdmin {
        if (markets[subject].supply == 0) revert MarketNotOpen();
        markets[subject].halted = halted;
        emit MarketHalted(subject, halted);
    }

    /* ------------------------------------------------------------------ member permits */

    function memberDigest(Member calldata m) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(MEMBER_TYPEHASH, m.wallet, m.xId, m.referrer, m.deadline)));
    }

    /// @notice Applies an operator-signed Member permit: opens the member's market (or hands them the unclaimed
    ///         fan market of their X account) and records their referrer. Anyone can submit it. Parts already
    ///         done are skipped, so a permit with nothing left to do is a no-op, even after its deadline.
    function register(Member calldata m, bytes calldata signature) external nonReentrant {
        _register(m, signature);
    }

    /// @notice register() for each permit, then buy(): the first buyer of a member's keys opens their market.
    function registerAndBuy(Member[] calldata members, bytes[] calldata signatures, address subject, uint256 units)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        if (members.length != signatures.length) revert LengthMismatch();
        for (uint256 i; i < members.length; ++i) {
            _register(members[i], signatures[i]);
        }
        _buy(subject, units);
    }

    function _register(Member calldata m, bytes calldata signature) internal {
        address bound = m.xId == 0 ? address(0) : subjectOfXId[m.xId];
        bool open = m.xId != 0 && bound == address(0);
        bool claimFan = bound != address(0) && markets[bound].fan && markets[bound].owner == address(0);
        bool refer = m.referrer != address(0) && referrerOf[m.wallet] == address(0);
        // Checked state first: a racing buyer may have applied this permit already.
        if (!open && !claimFan && !refer) return;
        if (block.timestamp > m.deadline) revert Expired();
        if (!isOperator[ECDSA.recover(memberDigest(m), signature)]) revert BadSignature();
        if (open) {
            _openMarket(m.wallet, m.xId);
        } else if (claimFan) {
            _claimFanMarket(bound, m.wallet);
        }
        if (refer) _setReferrer(m.wallet, m.referrer);
    }

    /* ------------------------------------------------------------------ trading */

    /// @notice Buys `units` of `subject`'s keys. Send at least the quoted total; change is refunded.
    function buy(address subject, uint256 units) external payable nonReentrant whenNotPaused {
        _buy(subject, units);
    }

    function _buy(address subject, uint256 units) internal {
        if (units == 0) revert ZeroUnits();
        Market storage m = markets[subject];
        uint256 supplyBefore = m.supply;
        if (supplyBefore == 0) revert MarketNotOpen();
        if (m.halted) revert MarketIsHalted();

        uint256 base = cumulative(supplyBefore + units) - cumulative(supplyBefore);
        Fees memory f = _fees(base, msg.sender, subject, true);
        uint256 total = base + _feeTotal(f);
        if (msg.value < total) revert InsufficientPayment(total, msg.value);

        // Holder fee goes to everyone holding before this buy (the buyer's existing keys included).
        m.accPerUnit += (f.holder * ACC_PRECISION) / supplyBefore;
        _settle(subject, msg.sender);
        uint256 balanceAfter = balanceOf[subject][msg.sender] + units;
        balanceOf[subject][msg.sender] = balanceAfter;
        uint256 supplyAfter = supplyBefore + units;
        m.supply = supplyAfter;

        lastBuyAt[subject][msg.sender] = uint40(block.timestamp);
        if (m.firstTradeAt == 0) m.firstTradeAt = uint40(block.timestamp);
        if (block.timestamp < uint256(m.firstTradeAt) + SNIPE_WINDOW && balanceAfter > SNIPE_MAX_UNITS) {
            revert SnipeLimit();
        }

        emit Trade(msg.sender, subject, true, units, base, f.creator, f.protocol, f.holder, f.referral, supplyAfter);
        _distribute(subject, m.owner, msg.sender, f);

        uint256 change = msg.value - total;
        if (change != 0) _send(msg.sender, change);
    }

    /// @notice Sells `units` back to the curve. The creator's first key can never be sold.
    function sell(address subject, uint256 units, uint256 minProceeds) external nonReentrant {
        if (units == 0) revert ZeroUnits();
        Market storage m = markets[subject];
        uint256 supplyBefore = m.supply;
        if (supplyBefore == 0) revert MarketNotOpen();
        uint256 bal = balanceOf[subject][msg.sender];
        uint256 locked = msg.sender == m.owner ? LOCKED_UNITS : 0;
        if (bal < units + locked) revert InsufficientKeys();
        uint256 supplyAfter = supplyBefore - units;
        // The locked first key is always held by the owner or FanEscrow, so this cannot trip.
        if (supplyAfter < LOCKED_UNITS) revert InsufficientKeys();

        uint256 base = cumulative(supplyBefore) - cumulative(supplyAfter);
        Fees memory f = _fees(base, msg.sender, subject, false);
        uint256 proceeds = base - _feeTotal(f);
        if (proceeds < minProceeds) revert Slippage(proceeds, minProceeds);

        _settle(subject, msg.sender);
        balanceOf[subject][msg.sender] = bal - units;
        m.supply = supplyAfter;
        // Holder fee goes to everyone still holding after this sell.
        m.accPerUnit += (f.holder * ACC_PRECISION) / supplyAfter;

        emit Trade(msg.sender, subject, false, units, base, f.creator, f.protocol, f.holder, f.referral, supplyAfter);
        _distribute(subject, m.owner, msg.sender, f);
        _send(msg.sender, proceeds);
    }

    /// @dev Credits fees. Missing referral halves go to protocol; protocol splits half stakers, half treasury.
    function _distribute(address subject, address owner_, address trader, Fees memory f) internal {
        uint256 traderHalf = f.referral / 2;
        uint256 creatorHalf = f.referral - traderHalf;
        uint256 protocolTotal = f.protocol;

        address tRef = referrerOf[trader];
        if (tRef != address(0)) earnings[tRef].referral += traderHalf;
        else protocolTotal += traderHalf;

        address cRef = owner_ == address(0) ? address(0) : referrerOf[owner_];
        if (cRef != address(0)) earnings[cRef].referral += creatorHalf;
        else protocolTotal += creatorHalf;

        uint256 stakerShare = protocolTotal / 2;
        address stakers = address(staking) == address(0) ? treasury : address(staking);
        earnings[stakers].protocol += stakerShare;
        earnings[treasury].protocol += protocolTotal - stakerShare;

        if (owner_ == address(0)) {
            if (f.creator != 0) IFanEscrow(fanEscrow).deposit{value: f.creator}(subject);
        } else {
            earnings[owner_].creator += f.creator;
        }
    }

    /* ------------------------------------------------------------------ holder rewards & claims */

    function _settle(address subject, address holder) internal {
        uint256 acc = markets[subject].accPerUnit;
        uint256 bal = balanceOf[subject][holder];
        if (bal != 0) {
            uint256 owed = (bal * (acc - rewardDebt[subject][holder])) / ACC_PRECISION;
            if (owed != 0) earnings[holder].holder += owed;
        }
        rewardDebt[subject][holder] = acc;
    }

    function pendingHolderReward(address subject, address holder) public view returns (uint256) {
        return (balanceOf[subject][holder] * (markets[subject].accPerUnit - rewardDebt[subject][holder])) / ACC_PRECISION;
    }

    /// @notice Everything `account` can claim now, given the markets whose holder rewards to settle.
    function claimable(address account, address[] calldata subjects)
        external
        view
        returns (uint256 creator, uint256 holder, uint256 referral, uint256 protocol)
    {
        Earnings memory e = earnings[account];
        holder = e.holder;
        for (uint256 i; i < subjects.length; ++i) {
            holder += pendingHolderReward(subjects[i], account);
        }
        return (e.creator, holder, e.referral, e.protocol);
    }

    /// @notice Pulls every earning: creator fees, holder rewards (settled for `subjects`), referral share
    ///         and protocol share (treasury and staking contract).
    function claim(address[] calldata subjects) external nonReentrant returns (uint256 total) {
        for (uint256 i; i < subjects.length; ++i) {
            _settle(subjects[i], msg.sender);
        }
        Earnings memory e = earnings[msg.sender];
        total = e.creator + e.holder + e.referral + e.protocol;
        if (total == 0) revert NothingToClaim();
        delete earnings[msg.sender];
        emit Claimed(msg.sender, e.creator, e.holder, e.referral, e.protocol);
        _send(msg.sender, total);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /* ------------------------------------------------------------------ admin */

    /// @notice Records who invited `user`. Set once by the operator after the invite is verified.
    function setReferrer(address user, address referrer) external onlyOperator {
        _setReferrer(user, referrer);
    }

    function _setReferrer(address user, address referrer) internal {
        if (user == address(0)) revert ZeroAddress();
        if (referrerOf[user] != address(0)) revert ReferrerAlreadySet();
        if (referrer == address(0) || referrer == user) revert InvalidReferrer();
        referrerOf[user] = referrer;
        emit ReferrerSet(user, referrer);
    }

    function setOperator(address account, bool enabled) external onlyOwner {
        isOperator[account] = enabled;
        emit OperatorSet(account, enabled);
    }

    function setFanAdmin(address account, bool enabled) external onlyOwner {
        isFanAdmin[account] = enabled;
        emit FanAdminSet(account, enabled);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setStaking(address staking_) external onlyOwner {
        staking = ISwayStaking(staking_);
        emit StakingSet(staking_);
    }

    /// @notice Set once: fan markets keep their first key and escrow in this contract until claimed.
    function setFanEscrow(address fanEscrow_) external onlyOwner {
        if (fanEscrow_ == address(0)) revert ZeroAddress();
        if (address(fanEscrow) != address(0)) revert FanEscrowAlreadySet();
        fanEscrow = IFanEscrow(fanEscrow_);
        emit FanEscrowSet(fanEscrow_);
    }

    /// @notice Pauses buys and market opening for emergencies. Sells and claims always work.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}

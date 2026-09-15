// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ITCGVaultFounderNFT} from "./interfaces/ITCGVaultFounderNFT.sol";
import {ITCGNexusToken} from "./interfaces/ITCGNexusToken.sol";
import {ITCGVaultToken} from "./interfaces/ITCGVaultToken.sol";

/**
 * @title TCGVaultInitialLaunch
 * @notice Prévente (whitepaper §6): TCGV contre USDC. Vague 1: 0,005 $/TCGV jusqu'au start de la vague 2 Founder.
 *   Vague 2: 0,008 $/TCGV. Après 10 jours de vague 2 Founder, compte à rebours 120h puis clôture.
 *   Bonus 30 % en $TCGNEXUS. Cap 4 %/wallet, hard cap 600M TCGV.
 *   Vesting: 10 % TGE, puis 10 %/mois sur 9 mois.
 *
 * @dev Uses classic ReentrancyGuard instead of ReentrancyGuardTransient for compatibility
 *      with chains (e.g. BSC) that do not yet support EIP-1153 transient storage opcodes.
 */
contract TCGVaultInitialLaunch is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct UserAllocation {
        uint256 tcgvAllocated;
        uint256 tcgvClaimed;
    }

    struct Order {
        address buyer;
        uint256 usdcAmount;
        uint256 tcgvAmount;
        uint256 nexusAmount;
        uint256 purchasedAt;
        bool cancelled;
    }

    IERC20 private immutable _tcgv;
    IERC20 private immutable _usdc;
    ITCGVaultFounderNFT private immutable _founderNFT;
    ITCGNexusToken private immutable _nexusToken;
    /// @dev `10 ** IERC20Metadata(usdc).decimals()` — prices and NEXUS scaling follow the wired stablecoin.
    uint256 private immutable _stableUnit;

    /// @notice Wave 1 price in USDC base units per 1 TCGV (`0.005 * 10**decimals`).
    uint256 public immutable PRICE_WAVE1;
    /// @notice Wave 2 price in USDC base units per 1 TCGV (`0.008 * 10**decimals`).
    uint256 public immutable PRICE_WAVE2;
    uint256 public constant FOUNDER_WAVE2_DURATION = 10 days;
    uint256 public constant PRESALE_COUNTDOWN_HOURS = 120;
    uint256 public constant HARD_CAP_TCGV = 600_000_000 * 1e18;
    uint256 public constant MAX_PER_WALLET_BP = 400; // 4 %
    uint256 private constant NEXUS_BONUS_BP = 3000;  // 30 %

    uint256 private _totalTCGVAllocated;
    uint256 private _tgeTimestamp;
    address private _treasury;

    uint256 private constant CANCEL_WINDOW = 14 days;
    uint256 private constant FINALIZE_DELAY_AFTER_PRESALE_END = 20 days;
    uint256 public constant MAX_PRESALE_DURATION = 365 days;
    uint256 private immutable _presaleStartTimestamp;

    mapping(address => UserAllocation) private _allocations;
    uint256 private _nextOrderId;
    mapping(uint256 => Order) private _orders;

    event Bought(address user, uint256 usdcAmount, uint256 tcgvAllocated, uint256 orderId, uint256 purchasedAt);
    event Claimed(address user, uint256 amount);
    event PresaleOrderCancelled(address user, uint256 orderId, uint256 usdcRefundDue, uint256 tcgvBurned, uint256 nexusClawedBack);
    event Finalized(uint256 tgeTimestamp);
    event EmergencyFinalized(uint256 tgeTimestamp, address triggeredBy);
    event TreasuryUpdated(address treasury);

    error ZeroNexusToken();
    error PresaleEnded();
    error PresaleCountdownEnded();
    error PresaleNotEnded();
    error ZeroAmount();
    error ExceedsHardCap();
    error ExceedsWalletCap();
    error AlreadyFinalized();
    error NotFinalized();
    error NothingToClaim();
    error InvalidOrder();
    error OrderAlreadyCancelled();
    error Unauthorized();
    error CancellationWindowEnded();
    error EmergencyFinalizeNotAvailable();
    error UnsupportedStableDecimals(uint8 decimals_);
    error ZeroAddress();

    constructor(address tcgv_, address usdc_, address founderNFT_, address nexusToken_, address treasury_) Ownable(msg.sender) {
        if (nexusToken_ == address(0)) revert ZeroNexusToken();
        if (tcgv_ == address(0) || usdc_ == address(0) || founderNFT_ == address(0)) revert ZeroAddress();
        uint8 d = IERC20Metadata(usdc_).decimals();
        if (d > 18) revert UnsupportedStableDecimals(d);
        _stableUnit = 10 ** uint256(d);
        // 0.005 and 0.008 USDC per TCGV in stablecoin base units.
        PRICE_WAVE1 = (5 * _stableUnit) / 1000;
        PRICE_WAVE2 = (8 * _stableUnit) / 1000;
        _tcgv = IERC20(tcgv_);
        _usdc = IERC20(usdc_);
        _founderNFT = ITCGVaultFounderNFT(founderNFT_);
        _nexusToken = ITCGNexusToken(nexusToken_);
        _treasury = treasury_ != address(0) ? treasury_ : msg.sender;
        _presaleStartTimestamp = block.timestamp;
        emit TreasuryUpdated(_treasury);
    }

    // External getters (private/external pattern)
    function tcgv() external view returns (address) { return address(_tcgv); }
    function usdc() external view returns (address) { return address(_usdc); }
    function founderNFT() external view returns (address) { return address(_founderNFT); }
    function nexusToken() external view returns (address) { return address(_nexusToken); }

    function totalTCGVAllocated() external view returns (uint256) { return _totalTCGVAllocated; }
    function tgeTimestamp() external view returns (uint256) { return _tgeTimestamp; }
    function treasury() external view returns (address) { return _treasury; }
    function presaleStartTimestamp() external view returns (uint256) { return _presaleStartTimestamp; }

    function allocations(address user) external view returns (uint256 tcgvAllocated, uint256 tcgvClaimed) {
        UserAllocation storage u = _allocations[user];
        return (u.tcgvAllocated, u.tcgvClaimed);
    }

    function setTreasury(address treasury_) external onlyOwner {
        _treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Countdown start: 10 days after Founder wave 2 starts.
    function presaleCountdownStartTime() public view returns (uint256) {
        uint256 wave2Start = _founderNFT.wave2StartTimestamp();
        if (wave2Start == 0) return type(uint256).max;
        return wave2Start + FOUNDER_WAVE2_DURATION;
    }

    /// @notice End of presale: 120h after the end of the 10-day Founder wave-2 phase.
    function presaleEndTime() public view returns (uint256) {
        uint256 countdownStart = presaleCountdownStartTime();
        if (countdownStart == type(uint256).max) return type(uint256).max;
        return countdownStart + (PRESALE_COUNTDOWN_HOURS * 1 hours);
    }

    function currentPrice() public view returns (uint256) {
        uint256 wave2Start = _founderNFT.wave2StartTimestamp();
        if (wave2Start == 0 || block.timestamp < wave2Start) return PRICE_WAVE1;
        return PRICE_WAVE2;
    }

    function maxPerWallet() public pure returns (uint256) {
        return (HARD_CAP_TCGV * MAX_PER_WALLET_BP) / 10000;
    }

    /**
     * @notice Buy TCGV with USDC. Buyer receives 30 % of amount in $TCGNEXUS.
     * @dev Reverts once the 120h countdown (starting after 10 days of Founder wave 2) has ended.
     */
    function buy(uint256 usdcAmount) external nonReentrant {
        if (_tgeTimestamp != 0) revert PresaleEnded();
        if (block.timestamp > presaleEndTime()) revert PresaleCountdownEnded();
        if (usdcAmount == 0) revert ZeroAmount();
        uint256 price = currentPrice();
        uint256 tcgvAmount = (usdcAmount * 1e18) / price;
        if (_totalTCGVAllocated + tcgvAmount > HARD_CAP_TCGV) revert ExceedsHardCap();
        UserAllocation storage u = _allocations[msg.sender];
        if (u.tcgvAllocated + tcgvAmount > maxPerWallet()) revert ExceedsWalletCap();

        uint256 orderId = _nextOrderId;
        _nextOrderId = orderId + 1;

        _totalTCGVAllocated += tcgvAmount;
        u.tcgvAllocated += tcgvAmount;

        uint256 nexusAmount = (usdcAmount * NEXUS_BONUS_BP * 1e18) / (10000 * _stableUnit);
        _orders[orderId] = Order({
            buyer: msg.sender,
            usdcAmount: usdcAmount,
            tcgvAmount: tcgvAmount,
            nexusAmount: nexusAmount,
            purchasedAt: block.timestamp,
            cancelled: false
        });

        // Mint TCGV to this contract (vested and claimed by buyer later)
        ITCGVaultToken(address(_tcgv)).mintPresale(address(this), tcgvAmount);

        if (nexusAmount > 0) {
            _nexusToken.mintPresaleBonus(msg.sender, nexusAmount);
        }

        _usdc.safeTransferFrom(msg.sender, _treasury, usdcAmount);
        emit Bought(msg.sender, usdcAmount, tcgvAmount, orderId, block.timestamp);
    }

    /// @notice MiCA cooling-off cancellation: burn TCGV + claw back NEXUS bonus.
    /// @dev USDC refunds are handled off-chain by the CASP. This contract only emits refundDue amounts for indexing.
    function cancelOrder(uint256 orderId) external nonReentrant {
        if (_tgeTimestamp != 0) revert AlreadyFinalized();
        Order storage o = _orders[orderId];
        if (o.buyer == address(0)) revert InvalidOrder();
        if (o.cancelled) revert OrderAlreadyCancelled();
        if (msg.sender != o.buyer) revert Unauthorized();
        if (block.timestamp > o.purchasedAt + CANCEL_WINDOW) revert CancellationWindowEnded();

        o.cancelled = true;

        uint256 tcgvAmount = o.tcgvAmount;
        uint256 actualNexusBurned;
        UserAllocation storage u = _allocations[msg.sender];
        u.tcgvAllocated -= tcgvAmount;
        _totalTCGVAllocated -= tcgvAmount;

        // Burn tokens held by this contract.
        ITCGVaultToken(address(_tcgv)).burnPresaleAllocation(address(this), tcgvAmount);

        if (o.nexusAmount > 0) {
            uint256 nexusBalance = IERC20(address(_nexusToken)).balanceOf(msg.sender);
            actualNexusBurned = o.nexusAmount > nexusBalance ? nexusBalance : o.nexusAmount;
            if (actualNexusBurned > 0) _nexusToken.clawBackPresaleBonus(msg.sender, actualNexusBurned);
        }

        emit PresaleOrderCancelled(
            msg.sender,
            orderId,
            o.usdcAmount,
            tcgvAmount,
            actualNexusBurned
        );
    }

    function _canFinalizeNormally() private view returns (bool) {
        uint256 end = presaleEndTime();
        if (end == type(uint256).max) return false;
        return block.timestamp >= end + FINALIZE_DELAY_AFTER_PRESALE_END;
    }

    function _finalize(bool emergency) private {
        _tgeTimestamp = block.timestamp;
        // Hard requirement: presale finalization and supply recompute must succeed; otherwise finalize reverts.
        ITCGVaultToken(address(_tcgv)).finalizePresaleAndRecompute();
        if (emergency) {
            emit EmergencyFinalized(_tgeTimestamp, msg.sender);
            return;
        }
        emit Finalized(_tgeTimestamp);
    }

    /// @notice Finalize presale and set TGE for vesting. Callable only after the 120h countdown + delay. Notifies TCGVaultToken to switch cashback from 30% to 10% and recompute supply (whitepaper §6).
    function finalize() external {
        if (_tgeTimestamp != 0) revert AlreadyFinalized();
        if (!_canFinalizeNormally()) revert PresaleNotEnded();
        _finalize(false);
    }

    /// @notice Emergency backstop: owner can finalize if presale exceeds max duration even when wave 2 never started.
    function emergencyFinalize() external onlyOwner {
        if (_tgeTimestamp != 0) revert AlreadyFinalized();
        if (block.timestamp < _presaleStartTimestamp + MAX_PRESALE_DURATION) revert EmergencyFinalizeNotAvailable();
        _finalize(true);
    }

    function releasable(address user) public view returns (uint256) {
        if (_tgeTimestamp == 0) return 0;
        UserAllocation storage u = _allocations[user];
        uint256 total = u.tcgvAllocated;
        if (total == 0) return 0;
        uint256 claimed = u.tcgvClaimed;
        uint256 elapsed = block.timestamp - _tgeTimestamp;
        uint256 monthsElapsed = elapsed / (30 days);
        if (monthsElapsed >= 9) return total - claimed;
        uint256 vested = (total * (10 + monthsElapsed * 10)) / 100;
        return vested > claimed ? vested - claimed : 0;
    }

    function claim() external nonReentrant {
        if (_tgeTimestamp == 0) revert NotFinalized();
        uint256 amount = releasable(msg.sender);
        if (amount == 0) revert NothingToClaim();
        _allocations[msg.sender].tcgvClaimed += amount;
        _tcgv.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }
}

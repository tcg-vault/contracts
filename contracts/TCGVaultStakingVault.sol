// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ITCGVaultBasicNFT} from "./interfaces/ITCGVaultBasicNFT.sol";
import {ITCGVaultToken} from "./interfaces/ITCGVaultToken.sol";
import {IPancakeFactory, IPancakePair} from "./interfaces/IPancakeV2.sol";
import {PancakeV2TWAPLib} from "./libraries/PancakeV2TWAPLib.sol";

/// @notice Share owner is blacklisted on the underlying TCGV token; withdraw and redeem are disabled for them.
error BlacklistedOwner();
/// @notice Only the underlying asset (`TCGVaultToken`) may call `forceWithdrawFromBlacklist`.
error OnlyAssetToken();
/// @notice Initial seeding deposit is below the required floor.
error InitialDepositTooSmall();
/// @notice Deposit would mint zero shares and trap assets in the vault.
error ZeroSharesDeposit();
/// @notice Buy router does not expose a valid TCGV/USDC pricing source for this vault.
error InvalidPricingSource();
/// @notice Stake amount must match the exact required threshold.
error ExactStakeRequired(uint256 requiredShares);
/// @notice Partial unstake is disabled; redeem/withdraw must remove the full position.
error FullUnstakeOnly();
/// @notice Vault shares are non-transferable; only mint (deposit) and burn (withdraw/redeem) are allowed.
error NonTransferableShares();
/// @notice ERC-4626 `assets` or `shares` argument must equal the vault-computed value for this receiver/owner.
error InvalidVaultAmount(uint256 expected, uint256 actual);
/// @notice Vault exits may not deliver the underlying into a taxed pool directly.
error ReceiverIsPair();
/// @notice No unsolicited underlying balance above tracked deposits to recover.
error NoUnsolicitedAssets();
/// @notice Stablecoin decimals above 18 are unsupported.
error UnsupportedStableDecimals(uint8 decimals_);
error ZeroAddress();

interface IBuyRouterForStaking {
    function factory() external view returns (address);
    function tcgv() external view returns (address);
    function usdc() external view returns (address);
}

/**
 * @title TCGVaultStakingVault
 * @notice ERC-4626 vault over TCGV. Used to gate Basic NFT: user must hold at least requiredStakeForBasicNFT (shares) to keep Basic NFT.
 *   On withdraw/redeem, if owner's share balance falls below requiredStakeForBasicNFT, their Basic NFT(s) are burned.
 *   Withdraw/redeem revert if the share `owner` is blacklisted on `ITCGVaultToken(asset())`. The asset token may call `forceWithdrawFromBlacklist` during blacklist to redeem all shares to the protocol vault.
 * @dev ERC-4626 deviations (integrators must not assume generic vault math):
 *   - {deposit}/{mint} only accept the exact top-up to `requiredStakeForBasicNFT` for `receiver` (see {maxMint}/{maxDeposit} and {previewMint}). Partial deposits are not supported.
 *   - {withdraw}/{redeem} are full-exit only: `assets` must equal {previewRedeem} of the owner's full balance and `shares` must equal that balance. Partial withdrawals are not supported; {previewWithdraw} always reverts.
 *   - {previewDeposit} returns the default assets→shares exchange rate (same as OpenZeppelin `ERC4626.previewDeposit`) and does **not** encode per-receiver Basic NFT top-up sizing; use {maxMint}/{maxDeposit} and {previewMint} for deposit quotes.
 *   - When a pricing router is set, dynamic Basic NFT thresholds use a Pancake V2 cumulative-price TWAP from a stored
 *     **start** `(anchorTs, anchorC)` to **now** (`block.timestamp`, current cumulative) — never shorter than
 *     `BASIC_NFT_TWAP_MIN_WINDOW`. If `now - anchorTs` exceeds `BASIC_NFT_TWAP_MAX_WINDOW`, the start slides forward on
 *     staking txs so the effective window stays capped (same chord math applied in `view` for reads).
 */
contract TCGVaultStakingVault is ERC4626, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @dev Require non-trivial seeding to reduce first-depositor manipulation surface.
    uint256 private constant MIN_INITIAL_DEPOSIT = 1 ether;
    /// @dev Human USD target for Basic NFT stake; scaled by pricing USDC decimals when configured.
    uint256 private constant BASIC_NFT_TARGET_USDC_HUMAN = 25;
    /// @dev Minimum `now - start` for pool TWAP pricing (end is always `now` / current cumulative).
    uint256 public constant BASIC_NFT_TWAP_MIN_WINDOW = 1 days;
    /// @dev When `now - start` exceeds this, the stored start slides forward so the TWAP window never grows unbounded.
    uint256 public constant BASIC_NFT_TWAP_MAX_WINDOW = 7 days;

    /// @notice Fallback minimum shares required to hold a Basic NFT when dynamic pricing is unavailable.
    uint256 private _requiredStakeForBasicNFT;
    /// @notice Basic NFT contract to call when stake drops below minimum.
    address private _basicNFTContract;
    /// @notice Optional buy router used as pricing source (same pool as buys: TCGV/USDC on Pancake V2).
    address private _basicNFTPricingRouter;
    /// @notice USDC token for dynamic Basic NFT threshold quotes.
    address private _basicNFTPricingUsdc;
    /// @notice `BASIC_NFT_TARGET_USDC_HUMAN * 10**usdc.decimals()` when dynamic pricing is configured.
    uint256 private _basicNftTargetUsdc;
    /// @notice Deposited asset accounting — ignores unsolicited ERC-20 transfers.
    uint256 private _trackedAssets;
    /// @notice Start of TWAP window (`price0` cumulative snapshot time) when dynamic pricing is active.
    uint32 private _basicNFTPricingTwapAnchorTs;
    /// @notice `price0CumulativeLast` at `_basicNFTPricingTwapAnchorTs` (set with the pricing router).
    uint256 private _basicNFTPricingTwapAnchorPrice0Cumulative;

    event RequiredStakeForBasicNFTUpdated(uint256 requiredShares);
    event BasicNFTContractUpdated(address basicNFT);
    event BasicNFTPricingRouterUpdated(address buyRouter, address usdc);
    event BasicNFTPricingTwapAnchorSet(address pair, uint32 anchorTimestamp, uint256 price0Cumulative);
    event BasicNFTPricingTwapWindowSlid(uint32 newStartTimestamp, uint256 newStartPrice0Cumulative);
    event UnsolicitedAssetsRecovered(address to, uint256 amount);

    // External getters (private/external pattern)
    function requiredStakeForBasicNFT() external view returns (uint256) {
        return _currentRequiredStakeForBasicNFT();
    }

    function basicNFTContract() external view returns (address) {
        return _basicNFTContract;
    }

    function basicNFTPricingRouter() external view returns (address) {
        return _basicNFTPricingRouter;
    }

    function basicNFTPricingUsdc() external view returns (address) {
        return _basicNFTPricingUsdc;
    }

    function basicNFTPricingTwapAnchor() external view returns (uint32 anchorTimestamp, uint256 price0Cumulative) {
        return (_basicNFTPricingTwapAnchorTs, _basicNFTPricingTwapAnchorPrice0Cumulative);
    }

    constructor(IERC20 asset_)
        ERC4626(asset_)
        ERC20("TCG-VAULT Staked TCGV", "sTCGV")
        Ownable(msg.sender)
    {
    }

    /// @inheritdoc ERC4626
    /// @dev Uses tracked deposits only so plain ERC-20 transfers cannot inflate the exchange rate.
    function totalAssets() public view virtual override returns (uint256) {
        return _trackedAssets;
    }

    /**
     * @notice Recover TCGV sent to the vault outside {deposit}/{mint}.
     * @dev Surplus = `balanceOf(vault) - _trackedAssets`. Does not touch deposited stake.
     */
    function recoverUnsolicitedAssets(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        uint256 tracked = _trackedAssets;
        if (balance <= tracked) revert NoUnsolicitedAssets();
        uint256 amount = balance - tracked;
        IERC20(asset()).safeTransfer(to, amount);
        emit UnsolicitedAssetsRecovered(to, amount);
    }

    function setRequiredStakeForBasicNFT(uint256 requiredShares) external onlyOwner {
        _requiredStakeForBasicNFT = requiredShares;
        emit RequiredStakeForBasicNFTUpdated(requiredShares);
    }

    function setBasicNFTContract(address basicNFT_) external onlyOwner {
        _basicNFTContract = basicNFT_;
        emit BasicNFTContractUpdated(basicNFT_);
    }

    /**
     * @notice Configure dynamic Basic NFT minimum stake using the same TCGV/USDC pool as the buy router.
     * @dev After `BASIC_NFT_TWAP_MIN_WINDOW` from the stored TWAP start, `requiredStakeForBasicNFT()` uses a
     *      manipulation-resistant TWAP from the pair's `price0CumulativeLast` (not spot reserves). Until then, or if
     *      the pair is empty or the TWAP is unusable, the vault uses `_requiredStakeForBasicNFT`. Each configuration
     *      captures a new start on the resolved pair.
     */
    function setBasicNFTPricingRouter(address buyRouter_) external onlyOwner {
        if (buyRouter_ == address(0)) {
            _basicNFTPricingRouter = address(0);
            _basicNFTPricingUsdc = address(0);
            _basicNftTargetUsdc = 0;
            _resetBasicNFTPricingTwapAnchor();
            emit BasicNFTPricingRouterUpdated(address(0), address(0));
            return;
        }
        IBuyRouterForStaking router_ = IBuyRouterForStaking(buyRouter_);
        address tcgv_ = router_.tcgv();
        address usdc_ = router_.usdc();
        address factory_ = router_.factory();
        if (tcgv_ != asset() || usdc_ == address(0) || factory_ == address(0)) revert InvalidPricingSource();
        uint8 d = IERC20Metadata(usdc_).decimals();
        if (d > 18) revert UnsupportedStableDecimals(d);
        _basicNFTPricingRouter = buyRouter_;
        _basicNFTPricingUsdc = usdc_;
        _basicNftTargetUsdc = BASIC_NFT_TARGET_USDC_HUMAN * (10 ** uint256(d));
        address pair = IPancakeFactory(factory_).getPair(asset(), usdc_);
        _captureBasicNFTPricingTwapAnchor(pair);
        emit BasicNFTPricingRouterUpdated(buyRouter_, usdc_);
    }

    function _resetBasicNFTPricingTwapAnchor() private {
        _basicNFTPricingTwapAnchorTs = 0;
        _basicNFTPricingTwapAnchorPrice0Cumulative = 0;
    }

    function _captureBasicNFTPricingTwapAnchor(address pair) private {
        if (pair == address(0)) {
            _resetBasicNFTPricingTwapAnchor();
            return;
        }
        (uint112 reserve0, uint112 reserve1,) = IPancakePair(pair).getReserves();
        if (reserve0 == 0 || reserve1 == 0) {
            _resetBasicNFTPricingTwapAnchor();
            return;
        }
        (uint256 c0,, uint32 t) = PancakeV2TWAPLib.currentCumulativePrices(pair);
        _basicNFTPricingTwapAnchorPrice0Cumulative = c0;
        _basicNFTPricingTwapAnchorTs = t;
        emit BasicNFTPricingTwapAnchorSet(pair, t, c0);
    }

    function _basicNftPricingPair() private view returns (address pair) {
        address router = _basicNFTPricingRouter;
        address usdc = _basicNFTPricingUsdc;
        if (router == address(0) || usdc == address(0)) return address(0);
        return IPancakeFactory(IBuyRouterForStaking(router).factory()).getPair(asset(), usdc);
    }

    /// @dev TWAP end is always `nowTs` / `cNow`; start `(effTs, effC)` is the stored anchor, possibly slid so `nowTs - effTs <= MAX` while keeping the same secant rate until capped.
    /// @dev One slide is enough: after sliding, `nowTs - effTs == BASIC_NFT_TWAP_MIN_WINDOW` (requires `MIN_WINDOW <= MAX_WINDOW`).
    function _twapEffectiveStart(uint256 startTs, uint256 startC, uint256 cNow, uint256 nowTs)
        private
        pure
        returns (uint256 effTs, uint256 effC, uint256 effDt)
    {
        effTs = startTs;
        effC = startC;
        uint256 dt = nowTs - effTs;
        if (dt > BASIC_NFT_TWAP_MAX_WINDOW) {
            uint256 D = cNow - effC;
            effC = cNow - Math.mulDiv(D, BASIC_NFT_TWAP_MIN_WINDOW, dt);
            effTs = nowTs - BASIC_NFT_TWAP_MIN_WINDOW;
        }
        effDt = nowTs - effTs;
    }

    /// @dev Persists a slid TWAP start when it is older than `BASIC_NFT_TWAP_MAX_WINDOW` (same math as {_twapEffectiveStart}).
    function _maybeSlideTwapWindow(address pair) private {
        uint32 ts = _basicNFTPricingTwapAnchorTs;
        if (pair == address(0) || ts == 0) return;
        uint256 anchorC = _basicNFTPricingTwapAnchorPrice0Cumulative;
        (uint256 cNow,,) = PancakeV2TWAPLib.currentCumulativePrices(pair);
        uint32 ts0 = ts;
        uint256 c0 = anchorC;
        uint256 effTs = uint256(ts);
        uint256 effC = anchorC;
        uint256 nowTs = block.timestamp;
        uint256 dt = nowTs - effTs;
        if (dt > BASIC_NFT_TWAP_MAX_WINDOW) {
            uint256 D = cNow - effC;
            effC = cNow - Math.mulDiv(D, BASIC_NFT_TWAP_MIN_WINDOW, dt);
            effTs = nowTs - BASIC_NFT_TWAP_MIN_WINDOW;
        }
        if (effTs != uint256(ts0) || effC != c0) {
            _basicNFTPricingTwapAnchorTs = uint32(effTs);
            _basicNFTPricingTwapAnchorPrice0Cumulative = effC;
            emit BasicNFTPricingTwapWindowSlid(uint32(effTs), effC);
        }
    }

    function _currentRequiredStakeForBasicNFT() private view returns (uint256) {
        uint256 fallbackRequired = _requiredStakeForBasicNFT;
        if (_basicNFTPricingRouter == address(0) || _basicNFTPricingUsdc == address(0)) return fallbackRequired;

        address pair = _basicNftPricingPair();
        if (pair == address(0)) return fallbackRequired;

        (uint112 reserve0, uint112 reserve1,) = IPancakePair(pair).getReserves();
        if (reserve0 == 0 || reserve1 == 0) return fallbackRequired;

        uint32 anchorTs = _basicNFTPricingTwapAnchorTs;
        if (anchorTs == 0) return fallbackRequired;

        (uint256 cNow,,) = PancakeV2TWAPLib.currentCumulativePrices(pair);
        uint256 anchorC = _basicNFTPricingTwapAnchorPrice0Cumulative;
        if (cNow <= anchorC) return fallbackRequired;

        (, uint256 effC, uint256 effDt) =
            _twapEffectiveStart(uint256(anchorTs), anchorC, cNow, block.timestamp);
        if (cNow <= effC) return fallbackRequired;
        if (effDt < BASIC_NFT_TWAP_MIN_WINDOW) return fallbackRequired;

        uint256 avgPerSec = (cNow - effC) / effDt;
        if (avgPerSec == 0) return fallbackRequired;

        // V2 `price0` cumulative always tracks reserve1/reserve0 (not "USD"). Branch on sort order vs `asset()`.
        address token0 = IPancakePair(pair).token0();
        uint256 q112 = uint256(1) << 112;
        uint256 requiredAssets = token0 == asset()
            ? Math.mulDiv(_basicNftTargetUsdc, q112, avgPerSec, Math.Rounding.Ceil)
            : Math.mulDiv(_basicNftTargetUsdc, avgPerSec, q112, Math.Rounding.Ceil);

        uint256 requiredShares = super.previewDeposit(requiredAssets);
        return requiredShares == 0 ? fallbackRequired : requiredShares;
    }

    /// @dev Shares still needed for `receiver` to reach `requiredStakeForBasicNFT`, or zero if already at/above target.
    function _stakeGap(address receiver) private view returns (uint256) {
        uint256 requiredStake = _currentRequiredStakeForBasicNFT();
        uint256 currentShares = balanceOf(receiver);
        if (requiredStake <= currentShares) return 0;
        return requiredStake - currentShares;
    }

    function _sharesToStakeFor(address receiver) private view returns (uint256) {
        uint256 gap = _stakeGap(receiver);
        if (gap == 0) revert ExactStakeRequired(_currentRequiredStakeForBasicNFT());
        return gap;
    }

    /// @inheritdoc ERC4626
    /// @dev Returns the default exchange-rate quote only; exact-stake deposit sizing is per `receiver` via {maxMint}/{maxDeposit} and {previewMint}.
    function previewDeposit(uint256 assets) public view virtual override returns (uint256) {
        return super.previewDeposit(assets);
    }

    /// @inheritdoc ERC4626
    function previewWithdraw(uint256) public view virtual override returns (uint256) {
        revert FullUnstakeOnly();
    }

    /// @inheritdoc ERC4626
    function maxMint(address receiver) public view virtual override returns (uint256) {
        uint256 gap = _stakeGap(receiver);
        if (gap == 0) return 0;
        if (totalSupply() == 0) {
            uint256 assets = super.previewMint(gap);
            if (assets < MIN_INITIAL_DEPOSIT) return 0;
        }
        return gap;
    }

    /// @inheritdoc ERC4626
    function maxDeposit(address receiver) public view virtual override returns (uint256) {
        uint256 maxShares = maxMint(receiver);
        if (maxShares == 0) return 0;
        return super.previewMint(maxShares);
    }

    /// @inheritdoc ERC4626
    function maxRedeem(address owner) public view virtual override returns (uint256) {
        if (ITCGVaultToken(asset()).isBlacklisted(owner)) return 0;
        return balanceOf(owner);
    }

    /// @inheritdoc ERC4626
    function maxWithdraw(address owner) public view virtual override returns (uint256) {
        uint256 shares = maxRedeem(owner);
        if (shares == 0) return 0;
        return super.previewRedeem(shares);
    }

    /**
     * @notice Redeem all shares of `account` and send underlying TCGV to the token's vault. Only `asset()` may call (used when blacklisting).
     * @dev Uses `super._withdraw` with `caller == owner == account` so no allowance is required. Does not apply the blacklist check on `owner`.
     */
    function forceWithdrawFromBlacklist(address account) external {
        if (msg.sender != asset()) revert OnlyAssetToken();
        _maybeSlideTwapWindow(_basicNftPricingPair());
        uint256 shares = balanceOf(account);
        if (shares == 0) return;
        uint256 assets = previewRedeem(shares);
        _withdraw(account, account, account, assets, shares);
        uint256 requiredStake = _currentRequiredStakeForBasicNFT();
        if (_basicNFTContract != address(0) && requiredStake > 0 && balanceOf(account) < requiredStake) {
            ITCGVaultBasicNFT(_basicNFTContract).burnAllFor(account);
        }
    }

    /**
     * @notice Stake to the current required level for Basic NFT.
     * @dev `assets` must equal `previewMint(maxMint(receiver))` for `receiver` at call time (pulls that many assets). Partial deposits are not supported.
     */
    function deposit(uint256 assets, address receiver) public virtual override returns (uint256) {
        _maybeSlideTwapWindow(_basicNftPricingPair());
        uint256 shares = _sharesToStakeFor(receiver);
        uint256 expectedAssets = super.previewMint(shares);
        if (assets != expectedAssets) revert InvalidVaultAmount(expectedAssets, assets);
        super.mint(shares, receiver);
        return shares;
    }

    /**
     * @notice Stake to the current required level for Basic NFT.
     * @dev `shares` must equal `maxMint(receiver)` at call time. Partial mints are not supported.
     */
    function mint(uint256 shares, address receiver) public virtual override returns (uint256) {
        _maybeSlideTwapWindow(_basicNftPricingPair());
        uint256 expectedShares = _sharesToStakeFor(receiver);
        if (shares != expectedShares) revert InvalidVaultAmount(expectedShares, shares);
        return super.mint(shares, receiver);
    }

    /**
     * @notice Unstake the full position from `owner`.
     * @dev `assets` must equal `maxWithdraw(owner)` (full exit only). Partial withdrawals are not supported.
     */
    function withdraw(uint256 assets, address receiver, address owner) public virtual override returns (uint256) {
        _maybeSlideTwapWindow(_basicNftPricingPair());
        uint256 shares = balanceOf(owner);
        if (shares == 0) {
            if (assets != 0) revert InvalidVaultAmount(0, assets);
            return 0;
        }
        uint256 expectedAssets = super.previewRedeem(shares);
        if (assets != expectedAssets) revert InvalidVaultAmount(expectedAssets, assets);
        return super.redeem(shares, receiver, owner);
    }

    /**
     * @notice Unstake the full position from `owner`.
     * @dev `shares` must equal `maxRedeem(owner)` (the owner's full balance). Partial redemptions are not supported.
     */
    function redeem(uint256 shares, address receiver, address owner) public virtual override returns (uint256) {
        _maybeSlideTwapWindow(_basicNftPricingPair());
        uint256 bal = balanceOf(owner);
        if (bal == 0) {
            if (shares != 0) revert InvalidVaultAmount(0, shares);
            return 0;
        }
        if (shares != bal) revert InvalidVaultAmount(bal, shares);
        return super.redeem(shares, receiver, owner);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal virtual override {
        if (totalSupply() == 0 && assets < MIN_INITIAL_DEPOSIT) revert InitialDepositTooSmall();
        if (shares == 0) revert ZeroSharesDeposit();
        uint256 requiredStake = _currentRequiredStakeForBasicNFT();
        if (requiredStake > 0 && balanceOf(receiver) + shares != requiredStake) revert ExactStakeRequired(requiredStake);
        // CEI: update tracked assets before ERC-20 transfer in `super._deposit` (hooks / reentrancy).
        _trackedAssets += assets;
        super._deposit(caller, receiver, assets, shares);
        if (_basicNFTContract != address(0) && requiredStake > 0 && balanceOf(receiver) >= requiredStake) {
            ITCGVaultBasicNFT(_basicNFTContract).mintFor(receiver);
        }
    }

    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal virtual override {
        if (ITCGVaultToken(asset()).isBlacklisted(owner)) revert BlacklistedOwner();
        if (ITCGVaultToken(asset()).isPair(receiver)) revert ReceiverIsPair();
        if (shares != balanceOf(owner)) revert FullUnstakeOnly();
        // CEI: decrement before `super._withdraw` burns shares and transfers assets (OZ transfers after burn).
        _trackedAssets -= assets;
        super._withdraw(caller, receiver, owner, assets, shares);
        uint256 requiredStake = _currentRequiredStakeForBasicNFT();
        if (_basicNFTContract != address(0) && requiredStake > 0 && balanceOf(owner) < requiredStake) {
            ITCGVaultBasicNFT(_basicNFTContract).burnAllFor(owner);
        }
    }

    /// @dev Shares are soulbound to staking position: block transfers while allowing mint (from=0) and burn (to=0).
    function _update(address from, address to, uint256 value) internal virtual override(ERC20) {
        if (from != address(0) && to != address(0)) revert NonTransferableShares();
        super._update(from, to, value);
    }

}

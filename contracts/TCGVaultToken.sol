// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPancakeRouter} from "./interfaces/IPancakeV2.sol";
import {ITCGNexusToken} from "./interfaces/ITCGNexusToken.sol";
import {ITCGVaultInitialLaunch} from "./interfaces/ITCGVaultInitialLaunch.sol";
import {ITCGVaultStakingVault} from "./interfaces/ITCGVaultStakingVault.sol";

/// @notice Pair address cannot be zero.
error PairZeroAddress();
/// @notice Transfer amount below minimum for buy/sell; fees would be incorrect or zero.
error MinAmountNotMet(uint256 amount, uint256 minimum);
/// @notice Only the buy router can call this.
error OnlyBuyRouter();
/// @notice Only `TCGVaultInitialLaunch` (immutable `initialLaunch`) can call this.
error OnlyInitialLaunch();
/// @notice Supply already recomputed (one-time).
error SupplyAlreadyRecomputed();
/// @notice Presale not finalized yet.
error PresaleNotFinalized();
/// @notice Allocation recipients (liquidity, team, ops) must be set before recomputeSupplyAndBurn.
error AllocationRecipientsNotSet();
/// @notice Fee recipient address cannot be zero.
error ZeroAddress();
/// @notice No team vesting amount available to claim.
error NoTeamVestingToClaim();
/// @notice No ops vesting amount available to claim.
error NoOpsVestingToClaim();
/// @notice Address is blacklisted (fraud, market manipulation, Sybil).
error Blacklisted();
/// @notice Contract is paused for security emergency.
error ContractPaused();
/// @notice Blacklist reason is required when enabling blacklist.
error EmptyBlacklistReason();
/// @notice No claimable fee balance for caller.
error NoFeesToClaim();

/**
 * @title TCGVaultToken (TCGV)
 * @notice Token A — le Moteur économique (whitepaper §4). BNB Chain, 1 milliard supply.
 * @dev Initial allocation (whitepaper §5): 60% Presale, 20% Liquidité, 4% Team (12mo cliff + 24mo vesting), 16% Ops (5% immediate + 11% over 36mo vesting).
 *
 * @dev **Routeur ON (portail / USDC)** — implémenté par `TCGVaultBuyRouter`, pas par les taxes paire ci-dessous : achat **5%** USDC (**3%** coffre / vault, **2%** structure),
 *      vente **4%** sur l’USDC (**1,5%** vault, **1%** liquidité, **1%** récompenses communautaires, **0,5%** structure). Le routeur est exclu des frais sur ce token pour éviter la double taxation.
 *      Cashback **$TCGNEXUS** : **30%** du montant TCGV acheté tant que `presaleActive`, puis **3%** — uniquement via `recordBuyAndMintCashback` appelé par le buy router (pas sur un swap paire direct).
 *
 * @dev **Routeur OFF (DEX / paire directe)** — taxes en **$TCGV** sur les transferts swap via `isPair` : achat **6%** (tiers du fee ≈ **2%** vault, **2%** structure & marketing, **2%** liquidité → `pendingAutolp`),
 *      vente **5%** du fee (**40% / 40% / 20%** du montant de taxe → **2%** vault, **2%** liquidité, **1%** structure & marketing ; poche communauté **0%** par défaut). **Aucune** attribution $TCGNEXUS sur l’achat paire (`_handleBuy`).
 *
 * @dev Access control: {DEFAULT_ADMIN_ROLE} is for granting/revoking roles only. Routine config uses {ADMIN_ROLE}.
 *      {PAUSER_ROLE} / {UNPAUSER_ROLE} split emergency stop vs resume. {BLACKLISTER_ROLE} manages blacklist.
 *      Deployer receives all roles at construction; governance can revoke narrow roles from hot wallets.
 */
contract TCGVaultToken is ERC20, AccessControl, ReentrancyGuard {
    /// @notice Routine administration: DEX routers, pairs, fee recipients, fee params, buy router, allocation recipients, fee/cashback toggles, min amounts.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    /// @notice May call pause().
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice May call unpause().
    bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");
    /// @notice May call setBlacklisted().
    bytes32 public constant BLACKLISTER_ROLE = keccak256("BLACKLISTER_ROLE");

    /// @notice Absolute cap for direct-pool buy tax (6%, deployment default).
    uint256 public constant MAX_BUY_TAX_BP = 600;
    /// @notice Absolute cap for direct-pool sell tax (5%, deployment default).
    uint256 public constant MAX_SELL_TAX_BP = 500;
    // Fee parameters (basis points, 10000 = 100%) — routeur OFF (paire); owner-modifiable within MAX_* caps
    uint256 public BUY_TAX = 600; // 6% — swap direct via paire (`isPair`)
    uint256 public SELL_TAX = 500; // 5% — idem
    /// @notice Standard-period cashback in NEXUS (after presale). Whitepaper §6: 3% — immutable.
    uint256 private constant CASHBACK_RATE = 300; // 3%
    /// @notice Presale cashback (Vagues 1 et 2). Whitepaper §6: BONUS PIONNIER 30% — immutable.
    uint256 private constant CASHBACK_RATE_PRESALE = 3000; // 30%
    /// @notice Seconds per month for vesting (30 days).
    uint256 private constant SECONDS_PER_MONTH = 30 * 24 * 3600;
    /// @notice When true, cashback uses 30%; when false (after presale finalize), uses 3%. Only set when `initialLaunch` calls finalizePresaleAndRecompute().
    bool public presaleActive = true;

    // Buy fee split (bps of fee amount; sum 10000) — routeur OFF: ≈2% + 2% + 2% notional on 6% fee
    uint256 public BUY_VAULT_SHARE = 3333;
    uint256 public BUY_MARKETING_SHARE = 3333;
    uint256 public BUY_AUTOLP_SHARE = 3334;

    // Sell fee split (bps of fee amount; sum 10000) — routeur OFF: 2% + 2% + 1% notional on 5% fee
    uint256 public SELL_VAULT_SHARE = 4000;
    uint256 public SELL_AUTOLP_SHARE = 4000;
    uint256 public SELL_MARKETING_SHARE = 2000;
    uint256 public SELL_COMMUNITY_SHARE = 0;
    
    /// @notice Registered Uniswap V2–style DEX routers for metadata / integrations; `factory == address(0)` means not registered.
    mapping(address => address) public dexFactoryForRouter;
    address public vaultAddress;
    address public marketingAddress;
    address public communityAddress;
    /// @notice $TCGNEXUS mint target for cashback (immutable). Minted only from `recordBuyAndMintCashback` (routeur ON / portail).
    address private immutable _nexusToken;
    /// @notice `TCGVaultBuyRouter` (routeur ON / USDC). Sole caller of `recordBuyAndMintCashback`; fee-excluded on this token.
    address public buyRouter;
    /// @notice Optional `TCGVaultStakingVault` over this token; when blacklisting, staked shares are redeemed to `vaultAddress` first.
    address public immutable stakingVault;
    /// @notice `TCGVaultInitialLaunch` (or test stand-in): only this address may mintPresale / finalize / burnPresaleAllocation paths guarded below. Immutable.
    address public immutable initialLaunch;
    /// @notice True after recomputeSupplyAndBurn has been called (one-time; mints 20% liquidity, 4% team vesting, 5% ops direct, 11% ops vesting).
    bool public supplyRecomputed;
    /// @notice Recipients for post-presale mint (whitepaper §5: 20% liquidity, 4% team vesting, 16% ops). Set by owner before presale end.
    address public liquidityRecipient;
    address public teamRecipient;
    address public opsRecipient;

    // Team vesting: 4% of final supply; 12-month freeze, then 24 monthly claims (full 4% by month 36).
    uint256 public teamVestingTotal;
    uint256 public teamVestingClaimed;
    uint256 public teamVestingCliffEnd; // timestamp after which vesting starts
    uint256 public teamVestingEnd;      // timestamp when full amount is vested

    // Ops vesting: 11% of final supply; no freeze, 36 monthly unlocks (full 11% by month 36). 5% is sent directly at finalize.
    uint256 public opsVestingTotal;
    uint256 public opsVestingClaimed;
    uint256 public opsVestingStart;
    uint256 public opsVestingEnd;

    // State variables
    bool public feesEnabled = true;
    bool public cashbackEnabled = true;
    /// @notice Minimum transfer amount for buy; below this, fee computation is unreliable.
    uint256 public minBuyAmount;
    /// @notice Minimum transfer amount for sell; below this, fee computation is unreliable.
    uint256 public minSellAmount;
    mapping(address => bool) public isExcludedFromFees;
    mapping(address => bool) public isPair;
    /// @notice Accumulated buy/sell-fee autolp tokens; add to LP via executePendingAutolp() to avoid updating pair reserves during sell transfer (fixes router INSUFFICIENT_INPUT_AMOUNT).
    uint256 public pendingAutolp;
    /// @notice Accrued buy/sell fee balances per recipient (pull-based claim).
    mapping(address => uint256) public pendingFeeClaims;
    /// @notice Blacklist: when true, address cannot send nor receive TCGV (fraud, market manipulation, Sybil).
    mapping(address => bool) public isBlacklisted;
    /// @notice When true, all transfers (and thus buy/sell/mint via _update) are blocked for security emergency.
    bool public paused;

    // Events
    event FeesEnabledUpdated(bool enabled);
    event CashbackEnabledUpdated(bool enabled);
    event PresaleActiveUpdated(bool active);
    event MinAmountsUpdated(uint256 minBuyAmount, uint256 minSellAmount);
    event FeesDistributed(
        uint256 vaultAmount,
        uint256 marketingAmount,
        uint256 communityAmount,
        uint256 burnAmount,
        uint256 lpAmount
    );
    event CashbackDistributed(address recipient, uint256 amount);
    event BuyFeeParamsUpdated(
        uint256 buyTaxBp,
        uint256 vaultShareBp,
        uint256 marketingShareBp,
        uint256 autolpShareBp
    );
    event SellFeeParamsUpdated(
        uint256 sellTaxBp,
        uint256 vaultShareBp,
        uint256 autolpShareBp,
        uint256 marketingShareBp,
        uint256 communityShareBp
    );
    event PresaleFinalized();
    event SupplyRecomputed(uint256 presaleSold, uint256 finalTotalSupply, uint256 mintedLiquidity, uint256 mintedTeamVesting, uint256 mintedOpsDirect, uint256 mintedOpsVesting);
    event TeamVestingClaimed(address recipient, uint256 amount);
    event PendingAutolpExecuted(uint256 amount);
    event OpsVestingClaimed(address recipient, uint256 amount);
    event BlacklistUpdated(address account, bool status, bytes32 reasonHash, string reason);
    event BlacklistTokensSeized(address account, address vault, uint256 amount);
    event Paused(address account);
    event Unpaused(address account);
    event FeeRecipientsUpdated(address vault, address marketing, address community);
    /// @notice A V2 pool was registered or removed for buy/sell fee routing (`isPair`).
    event PairActiveUpdated(address pair, bool active);
    /// @notice Fee exclusion flag for `account` (`isExcludedFromFees`). Emitted on admin setters and on deployment defaults.
    event ExcludedFromFeesUpdated(address account, bool excluded);
    /// @notice A DEX router was added (`active == true`, `factory` from `router.factory()`) or removed (`active == false`).
    event DexRouterUpdated(address router, address factory, bool active);
    /// @notice Post-presale mint recipients (liquidity / team vesting / ops).
    event AllocationRecipientsUpdated(address liquidity, address team, address ops);
    /// @notice USDC-path buy router (`recordBuyAndMintCashback` / `burn`); `address(0)` clears.
    event BuyRouterUpdated(address buyRouter);
    event FeeClaimed(address recipient, uint256 amount);

    error InvalidFeeParams();

    /// @notice Whitepaper §4.1: TCG-VAULT Token, TCGV, 1 milliard supply, BNB Chain.
    /// @param dexRouter_ Initial Uniswap V2–style router (read-only `factory()`, fee-excluded). Add more via `setDexRouter`; register pools with `setPair`.
    constructor(
        address stakingVault_,
        address dexRouter_,
        address vaultAddress_,
        address marketingAddress_,
        address communityAddress_,
        address nexusToken_,
        address initialLaunch_
    ) ERC20("TCG-VAULT Token", "TCGV") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(UNPAUSER_ROLE, msg.sender);
        _grantRole(BLACKLISTER_ROLE, msg.sender);
        if (vaultAddress_ == address(0) || marketingAddress_ == address(0) || communityAddress_ == address(0)) {
            revert ZeroAddress();
        }
        if (nexusToken_ == address(0)) revert ZeroAddress();
        if (dexRouter_ == address(0)) revert ZeroAddress();
        if (initialLaunch_ == address(0)) revert ZeroAddress();
        vaultAddress = vaultAddress_;
        marketingAddress = marketingAddress_;
        communityAddress = communityAddress_;
        _nexusToken = nexusToken_;
        initialLaunch = initialLaunch_;
        stakingVault = stakingVault_;

        emit FeeRecipientsUpdated(vaultAddress_, marketingAddress_, communityAddress_);

        // Exclude the token contract itself so internal accounting transfers (vesting, fee accounting, etc.)
        // do not accidentally trigger buy/sell fee logic.
        isExcludedFromFees[address(this)] = true;
        emit ExcludedFromFeesUpdated(address(this), true);

        _setDexRouter(dexRouter_, true);

        minBuyAmount = 10_000;
        minSellAmount = 10_000;
        emit MinAmountsUpdated(minBuyAmount, minSellAmount);

        // Initial fee / flag state (matches storage defaults) so subgraph has a full snapshot at deploy.
        emit FeesEnabledUpdated(feesEnabled);
        emit CashbackEnabledUpdated(cashbackEnabled);
        emit PresaleActiveUpdated(presaleActive);
        emit BuyFeeParamsUpdated(BUY_TAX, BUY_VAULT_SHARE, BUY_MARKETING_SHARE, BUY_AUTOLP_SHARE);
        emit SellFeeParamsUpdated(
            SELL_TAX,
            SELL_VAULT_SHARE,
            SELL_AUTOLP_SHARE,
            SELL_MARKETING_SHARE,
            SELL_COMMUNITY_SHARE
        );

        // No initial mint. Supply is minted during presale (mintPresale by launch contract) and at presale end (finalizePresaleAndRecompute mints 20% liquidity, 4% team vesting, 5% ops direct, 11% ops vesting — whitepaper §5).
    }

    /// @notice $TCGNEXUS address (immutable). Cashback only on routeur ON path via `recordBuyAndMintCashback`.
    function nexusToken() external view returns (address) {
        return _nexusToken;
    }

    /**
     * @notice Register (`active == true`) or remove (`active == false`) a Uniswap V2–style router: stores `factory` from `router.factory()`.
     * @dev Does **not** fee-exclude the DEX router. Shared Pancake/Uniswap routers must remain taxed when interacting with registered pairs.
     *      Protocol helpers (`BuyRouter`, `LiquidityWrapper`) are excluded separately via {setExcludedFromFees}/{setBuyRouter}.
     */
    function setDexRouter(address router, bool active) external onlyRole(ADMIN_ROLE) {
        _setDexRouter(router, active);
    }

    function _setDexRouter(address router, bool active) private {
        if (router == address(0)) revert ZeroAddress();
        if (active) {
            address factory_ = IPancakeRouter(router).factory();
            if (factory_ == address(0)) revert ZeroAddress();
            dexFactoryForRouter[router] = factory_;
            emit DexRouterUpdated(router, factory_, true);
        } else {
            dexFactoryForRouter[router] = address(0);
            emit DexRouterUpdated(router, address(0), false);
        }
    }

    /**
     * @notice Register (`active == true`) or disable (`active == false`) a V2 pool for taxed buys/sells.
     * @dev Fee logic uses only `isPair`. Call after the pool exists. Use one address per pool (e.g. TCGV/USDC).
     */
    function setPair(address pair, bool active) external onlyRole(ADMIN_ROLE) {
        if (pair == address(0)) revert PairZeroAddress();
        isPair[pair] = active;
        emit PairActiveUpdated(pair, active);
    }

    /**
     * @notice Update vault, marketing, and community fee recipients (NEXUS stays fixed from constructor).
     */
    function setAddresses(
        address _vaultAddress,
        address _marketingAddress,
        address _communityAddress
    ) external onlyRole(ADMIN_ROLE) {
        if (_vaultAddress == address(0) || _marketingAddress == address(0) || _communityAddress == address(0)) {
            revert ZeroAddress();
        }
        vaultAddress = _vaultAddress;
        marketingAddress = _marketingAddress;
        communityAddress = _communityAddress;
        emit FeeRecipientsUpdated(_vaultAddress, _marketingAddress, _communityAddress);
    }

    /**
     * @notice Exclude or include address from fees
     */
    function setExcludedFromFees(address account, bool excluded) external onlyRole(ADMIN_ROLE) {
        isExcludedFromFees[account] = excluded;
        emit ExcludedFromFeesUpdated(account, excluded);
    }

    /**
     * @notice Enable or disable fees
     */
    function setFeesEnabled(bool _enabled) external onlyRole(ADMIN_ROLE) {
        feesEnabled = _enabled;
        emit FeesEnabledUpdated(_enabled);
    }

    /**
     * @notice Enable or disable cashback
     */
    function setCashbackEnabled(bool _enabled) external onlyRole(ADMIN_ROLE) {
        cashbackEnabled = _enabled;
        emit CashbackEnabledUpdated(_enabled);
    }

    /**
     * @notice Set minimum amounts for buy/sell so fee computation is meaningful.
     */
    function setMinAmounts(uint256 _minBuyAmount, uint256 _minSellAmount) external onlyRole(ADMIN_ROLE) {
        minBuyAmount = _minBuyAmount;
        minSellAmount = _minSellAmount;
        emit MinAmountsUpdated(_minBuyAmount, _minSellAmount);
    }

    /**
     * @notice Blacklist an address (fraud, market manipulation, Sybil). When enabling: if `stakingVault` is set, redeems all sTCGV for `account` to `vaultAddress`; then confiscates entire wallet TCGV balance to `vaultAddress`; then sets the flag. Blacklisted addresses cannot send nor receive after.
     */
    function setBlacklisted(address account, bool status, string calldata reason) external onlyRole(BLACKLISTER_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        bytes memory reasonBytes = bytes(reason);
        if (status && reasonBytes.length == 0) revert EmptyBlacklistReason();
        bytes32 reasonHash = reasonBytes.length == 0 ? bytes32(0) : keccak256(reasonBytes);
        if (status) {
            if (stakingVault != address(0)) {
                ITCGVaultStakingVault(stakingVault).forceWithdrawFromBlacklist(account);
            }
            uint256 bal = balanceOf(account);
            if (bal > 0 && account != vaultAddress) {
                // Direct balance move: bypass fees, blacklist, and pause checks in this contract's _update.
                super._update(account, vaultAddress, bal);
                emit BlacklistTokensSeized(account, vaultAddress, bal);
            }
        }
        isBlacklisted[account] = status;
        emit BlacklistUpdated(account, status, reasonHash, reason);
    }

    /**
     * @notice Pause all transfers (emergency security). When paused, buy/sell/transfer/mintPresale (via _update) are blocked.
     */
    function pause() external onlyRole(PAUSER_ROLE) {
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Unpause the contract.
     */
    function unpause() external onlyRole(UNPAUSER_ROLE) {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Update buy fee parameters (routeur OFF / paire uniquement).
     * @dev Shares are basis points of the buy feeAmount and must sum to 10000.
     */
    function setBuyFeeParams(
        uint256 buyTaxBp,
        uint256 vaultShareBp,
        uint256 marketingShareBp,
        uint256 autolpShareBp
    ) external onlyRole(ADMIN_ROLE) {
        // Ceiling is immutable MAX_* only (not current BUY_TAX) so a mistaken zero does not permanently block restoring fees within the cap.
        if (buyTaxBp > MAX_BUY_TAX_BP) revert InvalidFeeParams();
        if (vaultShareBp + marketingShareBp + autolpShareBp != 10000) revert InvalidFeeParams();
        BUY_TAX = buyTaxBp;
        BUY_VAULT_SHARE = vaultShareBp;
        BUY_MARKETING_SHARE = marketingShareBp;
        BUY_AUTOLP_SHARE = autolpShareBp;
        emit BuyFeeParamsUpdated(buyTaxBp, vaultShareBp, marketingShareBp, autolpShareBp);
    }

    /**
     * @notice Update sell fee parameters (routeur OFF / paire uniquement).
     * @dev Shares are basis points of the sell feeAmount and must sum to 10000.
     */
    function setSellFeeParams(
        uint256 sellTaxBp,
        uint256 vaultShareBp,
        uint256 autolpShareBp,
        uint256 marketingShareBp,
        uint256 communityShareBp
    ) external onlyRole(ADMIN_ROLE) {
        // Ceiling is immutable MAX_* only (not current SELL_TAX) so a mistaken zero does not permanently block restoring fees within the cap.
        if (sellTaxBp > MAX_SELL_TAX_BP) revert InvalidFeeParams();
        if (vaultShareBp + autolpShareBp + marketingShareBp + communityShareBp != 10000) {
            revert InvalidFeeParams();
        }
        SELL_TAX = sellTaxBp;
        SELL_VAULT_SHARE = vaultShareBp;
        SELL_AUTOLP_SHARE = autolpShareBp;
        SELL_MARKETING_SHARE = marketingShareBp;
        SELL_COMMUNITY_SHARE = communityShareBp;
        emit SellFeeParamsUpdated(
            sellTaxBp,
            vaultShareBp,
            autolpShareBp,
            marketingShareBp,
            communityShareBp
        );
    }

    /**
     * @notice Set recipients for post-presale mint (whitepaper §5: 20% liquidity, 4% team vesting, 16% ops). Must be set before finalizePresaleAndRecompute().
     */
    function setAllocationRecipients(address _liquidity, address _team, address _ops) external onlyRole(ADMIN_ROLE) {
        liquidityRecipient = _liquidity;
        teamRecipient = _team;
        opsRecipient = _ops;
        emit AllocationRecipientsUpdated(_liquidity, _team, _ops);
    }

    /**
     * @notice Mint TCGV during presale; only callable by `initialLaunch` (e.g. TCGVaultInitialLaunch on each buy).
     * @dev Separate from finalizePresaleAndRecompute: this is called many times (per purchase); finalize is called once at presale end to switch cashback and mint allocation buckets.
     */
    function mintPresale(address to, uint256 amount) external {
        if (msg.sender != initialLaunch) revert OnlyInitialLaunch();
        if (to == address(0)) return;
        if (amount == 0) return;
        _mint(to, amount);
    }

    /**
     * @notice Finalize presale and recompute supply in a single call.
     * @dev Only callable by `initialLaunch` (TCGVaultInitialLaunch.finalize). Switches cashback from 30% to 3%, then mints: 20% liquidity (direct), 4% team (vesting: 12mo cliff + 24mo monthly), 5% ops (direct), 11% ops (vesting: 36mo monthly, no cliff). Called once at presale end.
     */
    function finalizePresaleAndRecompute() external {
        if (msg.sender != initialLaunch) revert OnlyInitialLaunch();
        if (supplyRecomputed) revert SupplyAlreadyRecomputed();
        if (!presaleActive) revert PresaleNotFinalized();
        if (liquidityRecipient == address(0) || teamRecipient == address(0) || opsRecipient == address(0)) revert AllocationRecipientsNotSet();

        // Finalize presale: switch cashback 30% -> 3%
        presaleActive = false;
        emit PresaleActiveUpdated(false);
        emit PresaleFinalized();

        uint256 presaleSold = ITCGVaultInitialLaunch(initialLaunch).totalTCGVAllocated();
        supplyRecomputed = true;

        if (presaleSold == 0) {
            emit SupplyRecomputed(0, 0, 0, 0, 0, 0);
            return;
        }

        uint256 finalSupply = (presaleSold * 10000) / 6000;
        uint256 currentSupply = totalSupply();
        uint256 toMint = finalSupply - currentSupply;

        // 20% liquidity, 4% team vesting, 5% ops direct, 11% ops vesting = 40%
        uint256 liquidityAmount = (finalSupply * 2000) / 10000;   // 20%
        uint256 teamVestingAmount = (finalSupply * 400) / 10000;  // 4%
        uint256 opsDirectAmount = (finalSupply * 500) / 10000;    // 5%
        uint256 opsVestingAmount = (finalSupply * 1100) / 10000;   // 11%
        uint256 sum = liquidityAmount + teamVestingAmount + opsDirectAmount + opsVestingAmount;

        if (sum > toMint && sum > 0) {
            liquidityAmount = (liquidityAmount * toMint) / sum;
            teamVestingAmount = (teamVestingAmount * toMint) / sum;
            opsDirectAmount = (opsDirectAmount * toMint) / sum;
            opsVestingAmount = toMint - liquidityAmount - teamVestingAmount - opsDirectAmount;
        }

        if (liquidityAmount > 0) _mint(liquidityRecipient, liquidityAmount);
        if (opsDirectAmount > 0) _mint(opsRecipient, opsDirectAmount);

        uint256 t = block.timestamp;
        if (teamVestingAmount > 0) {
            _mint(address(this), teamVestingAmount);
            teamVestingTotal = teamVestingAmount;
            teamVestingCliffEnd = t + 12 * SECONDS_PER_MONTH;
            teamVestingEnd = t + 36 * SECONDS_PER_MONTH; // 12mo cliff + 24mo vesting
        }
        if (opsVestingAmount > 0) {
            _mint(address(this), opsVestingAmount);
            opsVestingTotal = opsVestingAmount;
            opsVestingStart = t;
            opsVestingEnd = t + 36 * SECONDS_PER_MONTH;
        }

        emit SupplyRecomputed(presaleSold, finalSupply, liquidityAmount, teamVestingAmount, opsDirectAmount, opsVestingAmount);
    }

    /**
     * @notice Claim available team vesting. 4% of final supply: 12-month freeze, then linear vest over 24 months. Callable by anyone; tokens sent to teamRecipient.
     */
    function claimTeam() external nonReentrant {
        uint256 claimable = _teamVestingClaimable();
        if (claimable == 0) revert NoTeamVestingToClaim();
        teamVestingClaimed += claimable;
        _update(address(this), teamRecipient, claimable);
        emit TeamVestingClaimed(teamRecipient, claimable);
    }

    /**
     * @notice Claim available ops vesting. 11% of final supply: linear vest over 36 months (no freeze). Callable by anyone; tokens sent to opsRecipient.
     */
    function claimOps() external nonReentrant {
        uint256 claimable = _opsVestingClaimable();
        if (claimable == 0) revert NoOpsVestingToClaim();
        opsVestingClaimed += claimable;
        _update(address(this), opsRecipient, claimable);
        emit OpsVestingClaimed(opsRecipient, claimable);
    }

    /**
     * @notice Claim accrued buy/sell fee balance for caller.
     */
    function claimAccruedFees() external nonReentrant {
        uint256 amount = pendingFeeClaims[msg.sender];
        if (amount == 0) revert NoFeesToClaim();
        pendingFeeClaims[msg.sender] = 0;
        _update(address(this), msg.sender, amount);
        emit FeeClaimed(msg.sender, amount);
    }

    /// @dev Returns claimable team vesting amount (linear from cliff end to teamVestingEnd).
    function _teamVestingClaimable() private view returns (uint256) {
        if (teamVestingTotal == 0 || block.timestamp < teamVestingCliffEnd) return 0;
        uint256 vestDuration = teamVestingEnd - teamVestingCliffEnd;
        uint256 elapsed = block.timestamp > teamVestingEnd ? vestDuration : (block.timestamp - teamVestingCliffEnd);
        uint256 vested = (teamVestingTotal * elapsed) / vestDuration;
        return vested > teamVestingClaimed ? vested - teamVestingClaimed : 0;
    }

    /// @dev Returns claimable ops vesting amount (linear from opsVestingStart to opsVestingEnd).
    function _opsVestingClaimable() private view returns (uint256) {
        if (opsVestingTotal == 0 || block.timestamp <= opsVestingStart) return 0;
        uint256 vestDuration = opsVestingEnd - opsVestingStart;
        uint256 elapsed = block.timestamp >= opsVestingEnd ? vestDuration : (block.timestamp - opsVestingStart);
        uint256 vested = (opsVestingTotal * elapsed) / vestDuration;
        if (vested > opsVestingClaimed) return vested - opsVestingClaimed;
        return 0;
    }

    /// @notice View: claimable team vesting amount (for teamRecipient).
    function teamVestingClaimable() external view returns (uint256) {
        return _teamVestingClaimable();
    }

    /// @notice View: claimable ops vesting amount (for opsRecipient).
    function opsVestingClaimable() external view returns (uint256) {
        return _opsVestingClaimable();
    }

    /// @notice Effective cashback rate: 30% during presale (Vagues 1 et 2), 3% in standard period (whitepaper §6). Rates are constants.
    function getCashbackRate() public view returns (uint256) {
        return presaleActive ? CASHBACK_RATE_PRESALE : CASHBACK_RATE;
    }

    /**
     * @notice Set `TCGVaultBuyRouter` (routeur ON / portail USDC). Only this address can call `recordBuyAndMintCashback`.
     */
    function setBuyRouter(address _buyRouter) external onlyRole(ADMIN_ROLE) {
        address previous = buyRouter;
        if (previous != address(0) && previous != _buyRouter) {
            isExcludedFromFees[previous] = false;
            emit ExcludedFromFeesUpdated(previous, false);
        }
        buyRouter = _buyRouter;
        emit BuyRouterUpdated(_buyRouter);
        if (_buyRouter != address(0)) {
            isExcludedFromFees[_buyRouter] = true;
            emit ExcludedFromFeesUpdated(_buyRouter, true);
        }
    }

    /**
     * @notice Routeur ON only: after USDC→TCGV via buy router, mints $TCGNEXUS cashback (30% presale / 3% standard of `tcgvAmount`). Only `buyRouter`.
     */
    function recordBuyAndMintCashback(address recipient, uint256 tcgvAmount) external {
        if (msg.sender != buyRouter) revert OnlyBuyRouter();
        if (!cashbackEnabled) return;
        uint256 cashbackAmount = (tcgvAmount * getCashbackRate()) / 10000;
        if (cashbackAmount == 0) return;
        ITCGNexusToken(_nexusToken).mintCashback(recipient, cashbackAmount);
        emit CashbackDistributed(recipient, cashbackAmount);
    }

    /**
     * @notice Burn presale allocations from `from` (e.g. cooling-off cancellations).
     * @dev Used for MiCA cooling-off cancellations. Access: only `initialLaunch`.
     */
    function burnPresaleAllocation(address from, uint256 amount) external {
        if (msg.sender != initialLaunch) revert OnlyInitialLaunch();
        if (from == address(0)) revert ZeroAddress();
        if (amount == 0) return;
        _burn(from, amount);
    }

    /**
     * @notice Override transfer to apply fees
     * @dev Detects buys (from pair) and sells (to pair). Liquidity helpers should be `isExcludedFromFees` and receive withdrawals before forwarding to users.
     */
    function _update(address from, address to, uint256 amount) internal override {
        if (amount == 0) {
            super._update(from, to, 0);
            return;
        }
        if (paused) revert ContractPaused();
        if (isBlacklisted[from] || isBlacklisted[to]) revert Blacklisted();

        // Skip fees for excluded addresses
        if (isExcludedFromFees[from] || isExcludedFromFees[to] || !feesEnabled) {
            super._update(from, to, amount);
            return;
        }

        bool isBuy = isPair[from];
        bool isSell = isPair[to];

        // Apply fees only for buy or sell (enforce minimum so fees compute correctly)
        if (isBuy) {
            if (amount < minBuyAmount) revert MinAmountNotMet(amount, minBuyAmount);
            _handleBuy(from, to, amount);
        } else if (isSell) {
            if (amount < minSellAmount) revert MinAmountNotMet(amount, minSellAmount);
            _handleSell(from, to, amount);
        } else {
            // Regular transfer, no fees
            super._update(from, to, amount);
        }
    }

    /**
     * @notice Handle buy transaction with fees. Fees are taken from the buyer (to), not from the pair, for Pancake compatibility.
     */
    function _handleBuy(address from, address to, uint256 amount) private {
        uint256 feeAmount = (amount * BUY_TAX) / 10000;

        // Pair sends full amount to buyer; then buyer pays fees to vault/marketing/autolp.
        super._update(from, to, amount);
        if (feeAmount > 0) _distributeBuyFeesFrom(to, feeAmount);
        // Routeur OFF: no $TCGNEXUS on pair buy (routeur ON mints via `recordBuyAndMintCashback`).
    }

    /**
     * @notice Handle sell transaction with fees. Fees are distributed directly from the seller (from); autolp share is accumulated on this contract for manual liquidity add.
     */
    function _handleSell(address from, address to, uint256 amount) private nonReentrant {
        uint256 feeAmount = (amount * SELL_TAX) / 10000;
        uint256 transferAmount = amount - feeAmount;

        super._update(from, to, transferAmount);
        if (feeAmount > 0) _distributeSellFeesFrom(from, feeAmount);
    }

    /**
     * @notice Distribute buy fees directly from buyer (to).
     */
    function _distributeBuyFeesFrom(address from, uint256 totalFee) private {
        uint256 vaultAmount = (totalFee * BUY_VAULT_SHARE) / 10000;
        uint256 marketingAmount = (totalFee * BUY_MARKETING_SHARE) / 10000;
        uint256 autolpAmount = totalFee - vaultAmount - marketingAmount;

        if (totalFee > 0) super._update(from, address(this), totalFee);
        if (vaultAmount > 0) pendingFeeClaims[vaultAddress] += vaultAmount;
        if (marketingAmount > 0) pendingFeeClaims[marketingAddress] += marketingAmount;
        if (autolpAmount > 0) pendingAutolp += autolpAmount;
        emit FeesDistributed(vaultAmount, marketingAmount, 0, 0, autolpAmount);
    }

    /**
     * @notice Distribute sell fees directly from source (seller). Autolp share is sent to this contract and accumulated in pendingAutolp for manual liquidity add by owner.
     */
    function _distributeSellFeesFrom(address from, uint256 totalFee) private {
        uint256 vaultAmount = (totalFee * SELL_VAULT_SHARE) / 10000;
        uint256 autolpAmount = (totalFee * SELL_AUTOLP_SHARE) / 10000;
        uint256 marketingAmount = (totalFee * SELL_MARKETING_SHARE) / 10000;
        uint256 communityAmount = totalFee - vaultAmount - autolpAmount - marketingAmount;

        if (totalFee > 0) super._update(from, address(this), totalFee);
        if (vaultAmount > 0) pendingFeeClaims[vaultAddress] += vaultAmount;
        if (autolpAmount > 0) pendingAutolp += autolpAmount;
        if (marketingAmount > 0) pendingFeeClaims[marketingAddress] += marketingAmount;
        if (communityAmount > 0) pendingFeeClaims[communityAddress] += communityAmount;
        emit FeesDistributed(vaultAmount, marketingAmount, communityAmount, 0, autolpAmount);
    }

    /**
     * @notice Execute pending autolp (buy + sell fee liquidity portions).
     * @dev Liquidity is handled manually by the designated wallet off-chain. This function
     *      simply transfers the accumulated autolp tokens to the vault/liquidity wallet so
     *      it can add liquidity directly on PancakeSwap.
     */
    function executePendingAutolp() external {
        uint256 amount = pendingAutolp;
        if (amount == 0) return;
        pendingAutolp = 0;
        _update(address(this), vaultAddress, amount);
        emit PendingAutolpExecuted(amount);
    }
}

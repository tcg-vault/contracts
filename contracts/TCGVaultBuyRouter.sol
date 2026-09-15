// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITCGVaultToken} from "./interfaces/ITCGVaultToken.sol";
import {ITCGRToken} from "./interfaces/ITCGRToken.sol";
import {IPancakeFactory, IPancakePair, IPancakeRouter02} from "./interfaces/IPancakeV2.sol";

/// @notice Sent when buying with zero USDC.
error ZeroUSDC();
/// @notice Sent when selling with zero TCGV.
error ZeroTCGV();
/// @notice No TCGV received from swap.
error NoTCGVReceived();
/// @notice Output amount is less than minimum required.
error InsufficientOutputAmount();
/// @notice Transaction deadline has passed.
error Expired();
/// @notice Vault, marketing, and community must be non-zero (immutable).
error ZeroAddress();
/// @notice No claimable USDC fee balance for caller.
error NoFeesToClaim();

/**
 * @title TCGVaultBuyRouter
 * @notice **Routeur ON (portail / USDC)** — achat et vente du $TCGV contre USDC. Frais distincts du **routeur OFF** (taxes paire en TCGV sur `TCGVaultToken`).
 * @dev **Achat :** **5%** de l’USDC entrant (**3%** vault, **2%** structure), le reste est swappé en TCGV ; pas de burn TCGV. Puis `recordBuyAndMintCashback` sur le token pour **$TCGNEXUS** (**30%** prévente / **3%** standard du montant TCGV reçu — whitepaper §6).
 * @dev **Vente :** **4%** sur l’USDC reçu après swap (**1,5%** vault, **1%** liquidité, **1%** communauté, **0,5%** structure) ; pas de burn TCGV en entrée.
 * @dev **Parrainage :** si `referralToken` (TCGR) est configuré, `processValidatedBuy` peut créditer le parrain (**0,5%** du buy validé, whitepaper).
 * @dev Exclu des frais sur `TCGVaultToken` (évite double taxation avec le chemin paire). Taux cashback = `TCGVaultToken.presaleActive` / constantes du token.
 *      Utilise {ReentrancyGuardTransient} (EIP-1153) ; chaîne compatible stockage transient (Cancun+).
 */
contract TCGVaultBuyRouter is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Absolute cap for total buy fee (5%, deployment default sum: 300 + 200 + 0).
    uint256 public constant MAX_BUY_TOTAL_BP = 500;
    /// @notice Absolute cap for sell tax (4%, deployment default).
    uint256 public constant MAX_SELL_TAX_BP = 400;

    // Fee params (basis points) — owner-modifiable.
    // Buy: USDC fee split (vault + marketing + community)
    uint256 private _buyVaultBp = 300; // 3% of USDC in (vault)
    uint256 private _buyMarketingBp = 200; // 2% of USDC in (structure)
    uint256 private _buyCommunityBp = 0;

    // Sell: fee on USDC output (shares of fee amount sum to 10000)
    uint256 private _sellTaxBp = 400; // 4% of USDC received
    uint256 private _sellVaultShareBp = 3750; // 1.5% of notional
    uint256 private _sellAutolpShareBp = 2500; // 1% of notional (liquidity)
    uint256 private _sellMarketingShareBp = 1250; // 0.5% of notional (structure)
    uint256 private _sellCommunityShareBp = 2500; // 1% of notional

    address private immutable _router;
    address private immutable _factory;
    ITCGVaultToken private immutable _tcgv;
    IERC20 private immutable _usdc;
    address private immutable _vault;
    address private immutable _marketing;
    address private immutable _community;
    ITCGRToken private _referralToken;
    mapping(address => uint256) private _pendingUsdcFees;

    event BuyWithUSDC(address buyer, uint256 usdcIn, uint256 feeUSDC, uint256 tcgvOut);
    event ReferralTokenSet(address token);
    event SellTCGVForUSDC(address seller, uint256 tcgvIn, uint256 feeTCGV, uint256 usdcOut);
    event BuyFeeParamsUpdated(uint256 vaultBp, uint256 marketingBp, uint256 communityBp);
    event SellFeeParamsUpdated(
        uint256 taxBp,
        uint256 vaultShareBp,
        uint256 autolpShareBp,
        uint256 marketingShareBp,
        uint256 communityShareBp
    );
    event UsdcFeesClaimed(address recipient, uint256 amount);

    error InvalidFeeParams();

    // External getters (private/external pattern)
    function router() external view returns (address) { return _router; }
    function factory() external view returns (address) { return _factory; }
    function tcgv() external view returns (address) { return address(_tcgv); }
    function usdc() external view returns (address) { return address(_usdc); }
    function vault() external view returns (address) { return _vault; }
    function marketing() external view returns (address) { return _marketing; }
    function community() external view returns (address) { return _community; }
    function referralToken() external view returns (address) { return address(_referralToken); }

    function buyVaultBp() external view returns (uint256) { return _buyVaultBp; }
    function buyMarketingBp() external view returns (uint256) { return _buyMarketingBp; }
    function buyCommunityBp() external view returns (uint256) { return _buyCommunityBp; }

    function sellTaxBp() external view returns (uint256) { return _sellTaxBp; }
    function sellVaultShareBp() external view returns (uint256) { return _sellVaultShareBp; }
    function sellAutolpShareBp() external view returns (uint256) { return _sellAutolpShareBp; }
    function sellMarketingShareBp() external view returns (uint256) { return _sellMarketingShareBp; }
    function sellCommunityShareBp() external view returns (uint256) { return _sellCommunityShareBp; }
    function pendingUsdcFees(address recipient) external view returns (uint256) { return _pendingUsdcFees[recipient]; }

    constructor(
        address router_,
        address usdc_,
        ITCGVaultToken tcgv_,
        address vault_,
        address marketing_,
        address community_
    ) Ownable(msg.sender) {
        if (vault_ == address(0) || marketing_ == address(0) || community_ == address(0)) revert ZeroAddress();
        _router = router_;
        _factory = IPancakeRouter02(router_).factory();
        _tcgv = tcgv_;
        _usdc = IERC20(usdc_);
        _vault = vault_;
        _marketing = marketing_;
        _community = community_;
        emit ReferralTokenSet(address(0));
        emit BuyFeeParamsUpdated(_buyVaultBp, _buyMarketingBp, _buyCommunityBp);
        emit SellFeeParamsUpdated(
            _sellTaxBp,
            _sellVaultShareBp,
            _sellAutolpShareBp,
            _sellMarketingShareBp,
            _sellCommunityShareBp
        );
    }

    /**
     * @notice Set the TCGR referral token. Only this router can mint referral rewards.
     */
    function setReferralToken(address token_) external onlyOwner {
        _referralToken = ITCGRToken(token_);
        emit ReferralTokenSet(token_);
    }

    /**
     * @notice Update buy fee parameters (router mode).
     * @dev `vaultBp + marketingBp + communityBp` is taken from USDC in before swap.
     *      Each leg is capped only by `MAX_BUY_TOTAL_BP` on the sum (individual legs may be raised again after being lowered).
     */
    function setBuyFeeParams(
        uint256 vaultBp,
        uint256 marketingBp,
        uint256 communityBp
    ) external onlyOwner {
        if (vaultBp + marketingBp + communityBp > MAX_BUY_TOTAL_BP) revert InvalidFeeParams();
        _buyVaultBp = vaultBp;
        _buyMarketingBp = marketingBp;
        _buyCommunityBp = communityBp;
        emit BuyFeeParamsUpdated(vaultBp, marketingBp, communityBp);
    }

    /**
     * @notice Update sell fee parameters (router mode).
     * @dev Shares are basis points of the USDC fee amount and must sum to 10000.
     */
    function setSellFeeParams(
        uint256 taxBp,
        uint256 vaultShareBp,
        uint256 autolpShareBp,
        uint256 marketingShareBp,
        uint256 communityShareBp
    ) external onlyOwner {
        if (taxBp > MAX_SELL_TAX_BP) revert InvalidFeeParams();
        if (vaultShareBp + autolpShareBp + marketingShareBp + communityShareBp != 10000) {
            revert InvalidFeeParams();
        }
        _sellTaxBp = taxBp;
        _sellVaultShareBp = vaultShareBp;
        _sellAutolpShareBp = autolpShareBp;
        _sellMarketingShareBp = marketingShareBp;
        _sellCommunityShareBp = communityShareBp;
        emit SellFeeParamsUpdated(taxBp, vaultShareBp, autolpShareBp, marketingShareBp, communityShareBp);
    }

    /**
     * @notice Get pair address for two tokens
     */
    function _pairFor(address tokenA, address tokenB) internal view returns (address pair) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pair = IPancakeFactory(_factory).getPair(token0, token1);
    }

    /**
     * @notice Get reserves for a pair, ordered by tokenA/tokenB
     */
    function _getReserves(address tokenA, address tokenB) internal view returns (uint256 reserveA, uint256 reserveB) {
        (address token0,) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        address pair = _pairFor(tokenA, tokenB);
        (uint112 reserve0, uint112 reserve1,) = IPancakePair(pair).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    /**
     * @notice Calculate output amount using PancakeSwap V2 formula (0.25% fee: 9975/10000)
     */
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256 amountOut) {
        require(amountIn > 0, "INSUFFICIENT_INPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn * 9975;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 10000 + amountInWithFee;
        amountOut = numerator / denominator;
    }

    /**
     * @notice Swap an exact input amount along `path` (does not consume pair surplus).
     * @dev Used for USDC→TCGV buys where the router already transferred exactly `amountIn` to the first pair.
     */
    function _swapExactInput(address[] memory path, uint256 amountIn, address _to) internal {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = input < output ? (input, output) : (output, input);
            IPancakePair pair = IPancakePair(_pairFor(input, output));

            uint256 amountOutput;
            {
                (uint256 reserveInput, uint256 reserveOutput) = _getReserves(input, output);
                amountOutput = _getAmountOut(amountIn, reserveInput, reserveOutput);
            }
            (uint256 amount0Out, uint256 amount1Out) = input == token0 ? (uint256(0), amountOutput) : (amountOutput, uint256(0));
            address to = i < path.length - 2 ? _pairFor(output, path[i + 2]) : _to;
            pair.swap(amount0Out, amount1Out, to, "");
            if (i < path.length - 2) {
                // Multi-hop: next hop input is whatever landed on the intermediate pair (FoT-safe for intermediates).
                address nextPair = _pairFor(output, path[i + 2]);
                (uint256 nextReserveIn,) = _getReserves(output, path[i + 2]);
                amountIn = IERC20(output).balanceOf(nextPair) - nextReserveIn;
            }
        }
    }

    /**
     * @notice Swap supporting fee-on-transfer tokens
     * @dev Calculates input amount from balance changes to handle fee-on-transfer tokens correctly
     */
    function _swapSupportingFeeOnTransferTokens(address[] memory path, address _to) internal {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = input < output ? (input, output) : (output, input);
            IPancakePair pair = IPancakePair(_pairFor(input, output));
            
            uint256 amountInput;
            uint256 amountOutput;
            {
                // Scope to avoid stack too deep errors
                // _getReserves(input, output) returns (reserve of input, reserve of output)
                (uint256 reserveInput, uint256 reserveOutput) = _getReserves(input, output);
                amountInput = IERC20(input).balanceOf(address(pair)) - reserveInput;
                // Match PancakeSwap's getAmountOut behavior exactly (no extra buffer).
                amountOutput = _getAmountOut(amountInput, reserveInput, reserveOutput);
            }
            // amount0Out/amount1Out are in pair's token0/token1 order
            (uint256 amount0Out, uint256 amount1Out) = input == token0 ? (uint256(0), amountOutput) : (amountOutput, uint256(0));
            address to = i < path.length - 2 ? _pairFor(output, path[i + 2]) : _to;
            // data byte empty - no callback from pair
            pair.swap(amount0Out, amount1Out, to, "");
        }
    }

    /**
     * @notice Buy TCGV with USDC. 5% USDC fee (3% vault, 2% structure), rest swapped for TCGV. You get TCGV + NEXUS cashback.
     *         If TCGR is set, notifies TCGR of this validated buy so the buyer's registered referrer may receive 0.5% TCGR (whitepaper).
     * @param usdcAmount Amount of USDC to spend (must be approved to this router).
     * @param amountOutMin Minimum TCGV to receive.
     * @param deadline Swap deadline.
     */
    function buyTCGVWithUSDC(uint256 usdcAmount, uint256 amountOutMin, uint256 deadline) external nonReentrant {
        if (usdcAmount == 0) revert ZeroUSDC();
        if (deadline < block.timestamp) revert Expired();

        (uint256 tcgvToUser, uint256 feeUSDC) = _buyWithUSDC(usdcAmount, amountOutMin);

        _notifyReferralRewards(msg.sender, usdcAmount);

        emit BuyWithUSDC(msg.sender, usdcAmount, feeUSDC, tcgvToUser);
    }

    /**
     * @notice Internal helper for buying TCGV with USDC: pulls USDC, applies fees, swaps for TCGV and sends it to buyer.
     */
    function _buyWithUSDC(uint256 usdcAmount, uint256 amountOutMin) private returns (uint256 tcgvToUser, uint256 feeUSDC) {
        // Pull USDC from user (reverts on failure)
        _usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        uint256 vaultUSDC = (usdcAmount * _buyVaultBp) / 10000;
        uint256 marketingUSDC = (usdcAmount * _buyMarketingBp) / 10000;
        uint256 communityUSDC = (usdcAmount * _buyCommunityBp) / 10000;
        feeUSDC = vaultUSDC + marketingUSDC + communityUSDC;
        uint256 swapAmount = usdcAmount - feeUSDC;

        if (vaultUSDC > 0) _pendingUsdcFees[_vault] += vaultUSDC;
        if (marketingUSDC > 0) _pendingUsdcFees[_marketing] += marketingUSDC;
        if (communityUSDC > 0) _pendingUsdcFees[_community] += communityUSDC;

        // Build path [USDC, TCGV]
        address[] memory path = new address[](2);
        path[0] = address(_usdc);
        path[1] = address(_tcgv);

        // Get pair address and transfer USDC to pair
        address pair = _pairFor(path[0], path[1]);
        _usdc.safeTransfer(pair, swapAmount);

        // Record balance before swap
        uint256 balanceBefore = _tcgv.balanceOf(address(this));

        // Execute swap for exactly `swapAmount` (ignore any USDC donated to the pair).
        _swapExactInput(path, swapAmount, address(this));

        // Verify minimum output
        uint256 balanceAfter = _tcgv.balanceOf(address(this));
        uint256 tcgvReceived = balanceAfter - balanceBefore;
        if (tcgvReceived < amountOutMin) revert InsufficientOutputAmount();
        if (tcgvReceived == 0) revert NoTCGVReceived();

        // Mint NEXUS cashback and transfer TCGV to user
        tcgvToUser = tcgvReceived;
        _tcgv.recordBuyAndMintCashback(msg.sender, tcgvReceived);
        IERC20(address(_tcgv)).safeTransfer(msg.sender, tcgvToUser);
    }

    /**
     * @notice TCGR resolves buyer => referrer and mints 0.5% if a durable link was set at registration.
     */
    function _notifyReferralRewards(address buyer, uint256 usdcAmount) private {
        if (address(_referralToken) == address(0)) return;
        _referralToken.processValidatedBuy(buyer, usdcAmount);
    }

    /**
     * @notice Sell TCGV for USDC. Fee (4% of USDC out) after swap: 1.5% vault, 1% autolp (vault for manual LP), 1% community, 0.5% structure (marketing). No TCGV burn.
     */
    function sellTCGVForUSDC(uint256 amountIn, uint256 amountOutMin, uint256 deadline) external nonReentrant {
        if (amountIn == 0) revert ZeroTCGV();
        if (deadline < block.timestamp) revert Expired();

        // Pull TCGV from user
        IERC20(address(_tcgv)).safeTransferFrom(msg.sender, address(this), amountIn);

        // Build path [TCGV, USDC]
        address[] memory path = new address[](2);
        path[0] = address(_tcgv);
        path[1] = address(_usdc);

        // Get pair address and transfer TCGV to pair
        address pair = _pairFor(path[0], path[1]);
        IERC20(address(_tcgv)).safeTransfer(pair, amountIn);

        // Execute swap and get USDC
        uint256 usdcBefore = _usdc.balanceOf(address(this));
        _swapSupportingFeeOnTransferTokens(path, address(this));
        uint256 usdcAfter = _usdc.balanceOf(address(this));
        uint256 usdcReceived = usdcAfter - usdcBefore;
        if (usdcReceived == 0) revert InsufficientOutputAmount();

        // Apply sell fee in USDC on the output, split by shares.
        uint256 feeUsdc = (usdcReceived * _sellTaxBp) / 10000;
        uint256 userUsdc = usdcReceived - feeUsdc;

        // Verify minimum output
        if (userUsdc < amountOutMin) revert InsufficientOutputAmount();

        // Split and transfer USDC fees
        if (feeUsdc > 0) {
            uint256 vaultUsdc = (feeUsdc * _sellVaultShareBp) / 10000;
            uint256 autolpUsdc = (feeUsdc * _sellAutolpShareBp) / 10000;
            uint256 marketingUsdc = (feeUsdc * _sellMarketingShareBp) / 10000;
            uint256 communityUsdc = feeUsdc - vaultUsdc - autolpUsdc - marketingUsdc;

            if (vaultUsdc > 0) _pendingUsdcFees[_vault] += vaultUsdc;
            if (autolpUsdc > 0) _pendingUsdcFees[_vault] += autolpUsdc;
            if (marketingUsdc > 0) _pendingUsdcFees[_marketing] += marketingUsdc;
            if (communityUsdc > 0) _pendingUsdcFees[_community] += communityUsdc;
        }

        _usdc.safeTransfer(msg.sender, userUsdc);

        emit SellTCGVForUSDC(msg.sender, amountIn, feeUsdc, userUsdc);
    }

    /**
     * @notice Claim accrued USDC fees for caller.
     */
    function claimUsdcFees() external nonReentrant {
        uint256 amount = _pendingUsdcFees[msg.sender];
        if (amount == 0) revert NoFeesToClaim();
        _pendingUsdcFees[msg.sender] = 0;
        _usdc.safeTransfer(msg.sender, amount);
        emit UsdcFeesClaimed(msg.sender, amount);
    }

    // No need to receive native BNB/ETH; all flows are in ERC20 tokens (USDC, TCGV).
}

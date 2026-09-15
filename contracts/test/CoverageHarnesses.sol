// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PancakeV2TWAPLib} from "../libraries/PancakeV2TWAPLib.sol";
import {TCGVaultBuyRouter} from "../TCGVaultBuyRouter.sol";
import {ITCGVaultToken} from "../interfaces/ITCGVaultToken.sol";
import {TCGVaultStakingVault} from "../TCGVaultStakingVault.sol";

/// @notice Exposes TWAP library internals so zero-reserve branches are executable in tests.
contract TwapLibHarness {
    function priceFractionPerSecond(uint112 reserveNum, uint112 reserveDen) external pure returns (uint256) {
        return PancakeV2TWAPLib.priceFractionPerSecond(reserveNum, reserveDen);
    }

    function currentCumulativePrices(address pair)
        external
        view
        returns (uint256 price0Cumulative, uint256 price1Cumulative, uint32 blockTimestamp)
    {
        return PancakeV2TWAPLib.currentCumulativePrices(pair);
    }
}

/// @notice Exposes BuyRouter multi-hop swap (production buy/sell is always a 2-token path).
contract BuyRouterSwapHarness is TCGVaultBuyRouter {
    constructor(
        address router_,
        address usdc_,
        ITCGVaultToken tcgv_,
        address vault_,
        address marketing_,
        address community_
    ) TCGVaultBuyRouter(router_, usdc_, tcgv_, vault_, marketing_, community_) {}

    function swapExactInput(address[] calldata path, uint256 amountIn, address to) external {
        _swapExactInput(path, amountIn, to);
    }
}

/// @notice Exposes staking vault `_deposit` / `_withdraw` guards that public mint/redeem keep unreachable.
contract StakingVaultCoverageHarness is TCGVaultStakingVault {
    constructor(address asset_) TCGVaultStakingVault(IERC20(asset_)) {}

    function exposedDeposit(address caller, address receiver, uint256 assets, uint256 shares) external {
        _deposit(caller, receiver, assets, shares);
    }

    function exposedWithdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        external
    {
        _withdraw(caller, receiver, owner, assets, shares);
    }
}

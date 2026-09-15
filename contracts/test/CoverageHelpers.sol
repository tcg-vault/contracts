// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Router whose factory() is address(0) — covers TCGVaultToken._setDexRouter.
contract MockRouterZeroFactory {
    function factory() external pure returns (address) {
        return address(0);
    }
}

/// @notice Stablecoin with decimals() > 18 — covers UnsupportedStableDecimals.
contract MockUSDC19 {
    function decimals() external pure returns (uint8) {
        return 19;
    }
}

/// @notice 10% fee-on-transfer token — covers TCGVaultLiquidityWrapper._pullExact.
contract MockFeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee On Transfer", "FOT") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        uint256 send = amount - amount / 10;
        return super.transfer(to, send);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        uint256 send = amount - amount / 10;
        _transfer(from, to, send);
        return true;
    }
}

interface ILocalPancakeFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface ILocalPancakePair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function mint(address to) external returns (uint256 liquidity);
}

/// @notice Pancake V2–compatible router that uses `factory.getPair` (not mainnet CREATE2 init hash).
/// @dev Swap fee 0.25% (9975/10000), matching `TCGVaultBuyRouter` and Pancake.
contract LocalPancakeRouter {
    address public immutable factory;
    address public immutable WETH;

    constructor(address factory_, address weth_) {
        factory = factory_;
        WETH = weth_;
    }

    function _pairFor(address tokenA, address tokenB) internal view returns (address pair) {
        pair = ILocalPancakeFactory(factory).getPair(tokenA, tokenB);
        require(pair != address(0), "PAIR_NOT_FOUND");
    }

    function _getReserves(address tokenA, address tokenB) internal view returns (uint256 reserveA, uint256 reserveB) {
        ILocalPancakePair pair = ILocalPancakePair(_pairFor(tokenA, tokenB));
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        (reserveA, reserveB) = tokenA == pair.token0() ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256 amountOut) {
        require(amountIn > 0, "INSUFFICIENT_INPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn * 9975;
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * 10000 + amountInWithFee);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length >= 2, "INVALID_PATH");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; i++) {
            (uint256 reserveIn, uint256 reserveOut) = _getReserves(path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256,
        uint256,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        require(deadline >= block.timestamp, "EXPIRED");
        if (ILocalPancakeFactory(factory).getPair(tokenA, tokenB) == address(0)) {
            ILocalPancakeFactory(factory).createPair(tokenA, tokenB);
        }
        amountA = amountADesired;
        amountB = amountBDesired;
        address pair = _pairFor(tokenA, tokenB);
        IERC20(tokenA).transferFrom(msg.sender, pair, amountA);
        IERC20(tokenB).transferFrom(msg.sender, pair, amountB);
        liquidity = ILocalPancakePair(pair).mint(to);
    }

    function _swapSupportingFeeOnTransferTokens(address[] memory path, address _to) internal {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            ILocalPancakePair pair = ILocalPancakePair(_pairFor(input, output));
            address token0 = pair.token0();
            uint256 amountOutput;
            {
                (uint256 reserveInput, uint256 reserveOutput) = _getReserves(input, output);
                uint256 amountInput = IERC20(input).balanceOf(address(pair)) - reserveInput;
                amountOutput = getAmountOut(amountInput, reserveInput, reserveOutput);
            }
            (uint256 amount0Out, uint256 amount1Out) =
                input == token0 ? (uint256(0), amountOutput) : (amountOutput, uint256(0));
            address to = i < path.length - 2 ? _pairFor(output, path[i + 2]) : _to;
            pair.swap(amount0Out, amount1Out, to, "");
        }
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external {
        require(deadline >= block.timestamp, "EXPIRED");
        IERC20(path[0]).transferFrom(msg.sender, _pairFor(path[0], path[1]), amountIn);
        uint256 balanceBefore = IERC20(path[path.length - 1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        require(IERC20(path[path.length - 1]).balanceOf(to) - balanceBefore >= amountOutMin, "INSUFFICIENT_OUTPUT");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import "../interfaces/ITCGVaultToken.sol";

/// @notice Mock for tests: exposes totalTCGVAllocated and forwards mintPresale / finalizePresale / recomputeSupplyAndBurn to token.
contract MockPresaleLaunch {
    uint256 public totalTCGVAllocated;

    function setTotalAllocated(uint256 v) external {
        totalTCGVAllocated = v;
    }

    function mintPresale(address token, address to, uint256 amount) external {
        ITCGVaultToken(token).mintPresale(to, amount);
    }

    function finalizePresaleAndRecompute(address token) external {
        ITCGVaultToken(token).finalizePresaleAndRecompute();
    }

    function burnPresaleAllocation(address token, address from, uint256 amount) external {
        ITCGVaultToken(token).burnPresaleAllocation(from, amount);
    }
}

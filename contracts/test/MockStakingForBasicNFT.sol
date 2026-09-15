// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import "../interfaces/ITCGVaultBasicNFT.sol";

/// @notice Mock staking vault that reports balance below min so Basic NFT mintFor returns early (coverage).
contract MockStakingForBasicNFT {
    uint256 public constant MIN = 100e18;

    function requiredStakeForBasicNFT() external pure returns (uint256) {
        return MIN;
    }

    mapping(address => uint256) private _balances;
    bool private _useMapping;

    function setBalance(address account, uint256 amount) external {
        _balances[account] = amount;
        _useMapping = true;
    }

    function balanceOf(address account) external view returns (uint256) {
        if (_useMapping) return _balances[account];
        return 0;
    }

    function triggerMintFor(ITCGVaultBasicNFT nft, address account) external {
        nft.mintFor(account);
    }
}

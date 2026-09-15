// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal ERC20 used as `TCGVaultStakingVault` asset in tests: blacklist view + vault address match `TCGVaultToken` surface.
contract MockTCGVStakingAsset is ERC20 {
    mapping(address => bool) public isBlacklisted;
    mapping(address => bool) public isPair;
    address public vaultAddress;

    constructor(address vault_) ERC20("Mock TCGV", "mTCGV") {
        vaultAddress = vault_;
        _mint(msg.sender, 1_000_000 ether);
    }

    function setBlacklisted(address account, bool status) external {
        isBlacklisted[account] = status;
    }

    function setPair(address account, bool status) external {
        isPair[account] = status;
    }

    function setVaultAddress(address v) external {
        vaultAddress = v;
    }

    function callForceWithdrawFromBlacklist(address vault, address account) external {
        IStakingVaultForceWithdraw(vault).forceWithdrawFromBlacklist(account);
    }
}

interface IStakingVaultForceWithdraw {
    function forceWithdrawFromBlacklist(address account) external;
}

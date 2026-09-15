// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

interface ITCGVaultToken {
    /// @notice Return the configured vault recipient for seized funds and fee flows.
    /// @return Vault address used by TCGV token logic.
    function vaultAddress() external view returns (address);

    /// @notice Return whether `account` is a registered taxed pair.
    /// @param account Address to check.
    /// @return True when `account` is marked as an active trading pair.
    function isPair(address account) external view returns (bool);

    /// @notice Return whether an account is blacklisted by TCGV token policy.
    /// @param account Address to check.
    /// @return True when `account` is blacklisted.
    function isBlacklisted(address account) external view returns (bool);

    /// @notice Return TCGV balance for an account.
    /// @param account Address whose token balance is queried.
    /// @return Token balance held by `account`.
    function balanceOf(address account) external view returns (uint256);

    /// @notice Transfer TCGV to a recipient.
    /// @param to Recipient address.
    /// @param amount Amount of TCGV to transfer.
    /// @return True on successful transfer.
    function transfer(address to, uint256 amount) external returns (bool);

    /// @notice Transfer TCGV from one address to another using allowance.
    /// @param from Source address.
    /// @param to Recipient address.
    /// @param amount Amount of TCGV to transfer.
    /// @return True on successful transfer.
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    /// @notice Approve a spender to transfer TCGV on behalf of caller.
    /// @param spender Address receiving allowance.
    /// @param amount Allowance amount to set.
    /// @return True on successful approval.
    function approve(address spender, uint256 amount) external returns (bool);

    /// @notice Routeur ON only: mint $TCGNEXUS cashback to `recipient` (base = `tcgvAmount`). Only callable by the configured buy router.
    /// @param recipient Address that receives cashback mint.
    /// @param tcgvAmount Bought TCGV amount used as cashback base.
    function recordBuyAndMintCashback(address recipient, uint256 tcgvAmount) external;

    /// @notice Burn presale allocations from an address. Only callable by the presale finalizer.
    /// @param from Address whose presale allocation is burned.
    /// @param amount Amount of presale TCGV to burn.
    function burnPresaleAllocation(address from, uint256 amount) external;

    /// @notice Mint presale TCGV; only callable by presale finalizer (e.g. launch contract) during presale.
    /// @param to Recipient of minted presale TCGV.
    /// @param amount Amount of TCGV to mint.
    function mintPresale(address to, uint256 amount) external;

    /// @notice Finalize presale and recompute supply: 20% liquidity, 4% team vesting, 5% ops direct, 11% ops vesting.
    function finalizePresaleAndRecompute() external;
}


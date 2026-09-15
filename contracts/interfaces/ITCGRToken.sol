// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

interface ITCGRToken {
    /// @notice Process a validated buy and mint referral rewards when applicable.
    /// @param buyer Buyer address whose durable referrer link is checked.
    /// @param usdcAmount Purchase amount in USDC base units used to compute TCGR reward.
    function processValidatedBuy(address buyer, uint256 usdcAmount) external;

    /// @notice Burn TCGR from an account as part of TCGR-to-TCGV conversion flow.
    /// @param account Address whose TCGR balance is burned.
    /// @param amount Amount of TCGR to burn (18 decimals).
    function burnForConversion(address account, uint256 amount) external;

    /// @notice Return the immutable/durable referrer bound to a referee.
    /// @param referee Address that may have previously set a referrer.
    /// @return Referrer address or zero address if none is set.
    function referrerOf(address referee) external view returns (address);
}

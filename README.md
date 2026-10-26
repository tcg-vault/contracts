# TCG-VAULT Contracts

Smart contracts for the TCG Vault ecosystem on BNB Chain.

## Documentation

This README describes the **on-chain implementation** in this repository.
The Solidity source of truth is:

- `contracts/TCGVaultToken.sol`
- `contracts/TCGVaultBuyRouter.sol`

## Current Fee Model (Implemented)

Two modes: **routeur OFF** = taxes paire sur `TCGVaultToken` (TCGV) ; **routeur ON** = portail USDC sur `TCGVaultBuyRouter` (sans double taxation sur le token).

### 1) Direct DEX/Pool — `TCGVaultToken` (routeur OFF)

- **Buy tax:** `BUY_TAX = 600` (**6%** TCGV sur achat via paire).
- **Buy split (of fee amount, thirds):**
  - Vault: `BUY_VAULT_SHARE = 3333` (~**2%** notional)
  - Marketing: `BUY_MARKETING_SHARE = 3333` (~**2%** notional)
  - Auto-LP bucket: `BUY_AUTOLP_SHARE = 3334` (~**2%** notional → `pendingAutolp`)
- **Sell tax:** `SELL_TAX = 500` (**5%**).
- **Sell split (of fee amount):**
  - Vault: `SELL_VAULT_SHARE = 4000` (40% of fee → **2%** notional)
  - Auto-LP bucket: `SELL_AUTOLP_SHARE = 4000` (40% of fee → **2%** notional)
  - Marketing: `SELL_MARKETING_SHARE = 2000` (20% of fee → **1%** notional)
  - Community: `SELL_COMMUNITY_SHARE = 0` (default **0%**)

### 2) USDC Router Path — `TCGVaultBuyRouter` (routeur ON)

- **Buy (USDC -> TCGV):**
  - Fee is taken in USDC before swap.
  - Defaults:
    - Vault: `_buyVaultBp = 300` (3%)
    - Marketing: `_buyMarketingBp = 200` (2%)
    - Community: `_buyCommunityBp = 0`
  - Total default router buy fee = **5% USDC**.
  - Remaining USDC is swapped; user receives **100% of `tcgvReceived`** from swap output.

- **Sell (TCGV -> USDC):**
  - Fee is taken on USDC output after swap.
  - Defaults:
    - `_sellTaxBp = 400` (4% total fee on USDC out)
    - `_sellVaultShareBp = 3750` (37.5% of fee = 1.5% notional)
    - `_sellAutolpShareBp = 2500` (25.0% of fee = 1.0% notional)
    - `_sellMarketingShareBp = 1250` (12.5% of fee = 0.5% notional)
    - `_sellCommunityShareBp = 2500` (25.0% of fee = 1.0% notional)

## Burn Behavior

- There is **no buy/sell burn fee mechanism** in the transfer tax or router tax flows.
- Buy/sell fees are routed to pending claim balances and/or `pendingAutolp`, not burned.
- The only burn-related path in `TCGVaultToken` is `burnPresaleAllocation(...)`, gated to `initialLaunch`.

## Fee Mutability / Admin Controls

Fees are **not immutable constants**. They are configurable by privileged roles, with hard caps:

- `TCGVaultToken` (pool mode):
  - `setBuyFeeParams(...)`
  - `setSellFeeParams(...)`
- `TCGVaultBuyRouter` (router mode):
  - `setBuyFeeParams(...)`
  - `setSellFeeParams(...)`

Absolute caps:

- `TCGVaultToken` (paire): `MAX_BUY_TAX_BP = 600` (6%) and `MAX_SELL_TAX_BP = 500` (5%) — deployment defaults for routeur OFF.
- `TCGVaultBuyRouter` (portail): `MAX_BUY_TOTAL_BP = 500` (5%) and `MAX_SELL_TAX_BP = 400` (4%) — routeur ON.

Constraints:

- In token buy/sell split setters, shares must sum to `10000`.
- In token buy/sell setters, tax must be <= the contract-specific immutable cap (`MAX_BUY_TAX_BP` / `MAX_SELL_TAX_BP`). The cap is the only on-chain bound: a rate lowered below the cap can technically be set again up to the cap (this avoids permanently locking fees after a mistaken zero).
- In router buy setter, total buy fee (`vault + marketing + community`) must be <= `MAX_BUY_TOTAL_BP`.
- In router sell setter, sell split shares must sum to `10000` and tax must be <= `MAX_SELL_TAX_BP`.
- Commitment of the issuer: within these hard-coded ceilings, TCG-VAULT contractually commits, in its Terms of Use and white paper, never to raise the contribution rates; any change goes through the Gnosis Safe multisig that holds the admin roles. This commitment is contractual, not an on-chain lock.

## Notes

- NEXUS cashback on buys is minted via the **USDC portail** (`recordBuyAndMintCashback`); direct **pair** buys do not mint NEXUS (see `docs/FEE_REFERENCE.md`).
- If you use these contracts for calculators, analytics, or simulations, read fee values directly from contract state where possible rather than assuming static values.
- Founder sale and initial presale custody/refund model (direct USDC transfer to regulated recipient, event-driven cooling-off refunds) is documented in `docs/PRODUCT_LIFECYCLE.md` and `docs/WALLET_ADDRESSES.md`.

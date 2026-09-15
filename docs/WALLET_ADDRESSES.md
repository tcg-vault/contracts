# Wallet addresses — review sheet (French ↔ English ↔ `.env`)

Use the same Ethereum addresses in `.env` as in your operational wallet list. Variable names stay as in [`.env.example`](../.env.example).

| # | French (review) | English (same meaning) | Environment variable | On-chain use (summary) |
|---|-----------------|------------------------|----------------------|-------------------------|
| 1 | Wallet **Vault communautaire** (USDC) | **Community protocol vault** (USDC) | `VAULT_ADDRESS` | Vault share of **direct pool** fees (TCGV) and of **BuyRouter** USDC fees; Founder NFT mint: **30%** of USDC to vault (`TCGVaultFounderNFT`). Autolp accrual on the token is executed separately — see `executePendingAutolp` / [**FEE_REFERENCE.md**](FEE_REFERENCE.md). |
| 2 | Wallet **Marketing & Structure** | **Marketing & structure** (fees) | `MARKETING_ADDRESS` | Marketing share of direct pool fees (TCGV) and BuyRouter USDC fees. |
| 3 | Wallet **Liquidité** | **Liquidity** | `LIQUIDITY_RECIPIENT` | Post–presale finalize: TCGV liquidity allocation; **60%** of Founder NFT mint USDC (`TCGVaultFounderNFT`). |
| 4 | Wallet **Burn** (ou adresse dead) | **Burn** (`address(0)`) | *(none)* | Burn destination is `address(0)`. Swap **fees** do **not** route to a dedicated burn wallet (`BURN_ADDRESS` is not used in `.env`); burn behavior is contract-driven in `TCGVaultToken`. |
| 5 | Wallet **Récompenses communautaires** | **Community rewards** | `COMMUNITY_ADDRESS` | **BuyRouter** default sell path sends part of the **USDC** fee here (see [**FEE_REFERENCE.md**](FEE_REFERENCE.md) §2.2). **Direct pool** sell defaults give **0%** of the sell fee to community unless `SELL_COMMUNITY_SHARE` / params are changed on-chain. |
| 6 | Wallet **Réserve de structuration** (ex. 70k) | **Structuring reserve** / team reserve (e.g. 70k allocation) | `TEAM_RECIPIENT` | Post–presale finalize: team vesting recipient (`TCGVaultToken` allocation / `claimTeam`). |

### Other required `.env` addresses (same deployment, not in the 6-row table above)

| English | Environment variable | Role |
|---------|------------------------|------|
| **InitialLaunch USDC treasury / CASP sink** | `TREASURY_ADDRESS` | Primary USDC sink for `TCGVaultInitialLaunch.buy()`; this address can be a regulated CASP custody account. |
| **Optional explicit CASP USDC sink** | `CASP_USDC_ADDRESS` | If set, deploy scripts use this address as the USDC sink for both `TCGVaultInitialLaunch` (`_treasury`) and `TCGVaultFounderNFT` (`_caspUsdcRecipient`). |
| **Operations & ecosystem** | `OPS_RECIPIENT` | Post–presale: direct + vesting ops allocation; **10%** of Founder NFT mint USDC (`TCGVaultFounderNFT`). |

### Quick mapping checklist

- [ ] `VAULT_ADDRESS` = vault communautaire (USDC)  
- [ ] `MARKETING_ADDRESS` = marketing & structure  
- [ ] `LIQUIDITY_RECIPIENT` = liquidité  
- [ ] Burn address = `address(0)` (no `BURN_ADDRESS` env var)  
- [ ] `COMMUNITY_ADDRESS` = récompenses communautaires  
- [ ] `TEAM_RECIPIENT` = réserve de structuration (70k-style allocation)  
- [ ] `TREASURY_ADDRESS` filled (or `CASP_USDC_ADDRESS` set to override it in deploy scripts)  
- [ ] `OPS_RECIPIENT` filled for Founder mint and post-presale allocations  

### Cooling-off cancellation disclosure

- `TCGVaultFounderNFT.cancelFounderPurchase()` and `TCGVaultInitialLaunch.cancelOrder()` emit refund-due amounts (`usdcRefundDue`) but do not execute on-chain USDC payout.
- Refund execution is expected from the regulated recipient account that received the original USDC transfer (`_caspUsdcRecipient` / `_treasury`).
- Before paying a refund, operators must verify the event’s `nexusClawedBack` (and related unwind fields) matches the expected bonus; do not auto-refund solely on `usdcRefundDue` if clawback is incomplete (e.g. Founder NFT transferred before cancel).
- Recipient addresses can be rotated by contract owner (`setCaspUsdcRecipient`, `setTreasury`), so operations should maintain an auditable mapping of active custody addresses and change approvals.

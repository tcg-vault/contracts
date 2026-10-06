# Wallet addresses — review sheet (French ↔ English ↔ `.env`)

Use the same Ethereum addresses in `.env` as in your operational wallet list. Variable names stay as in [`.env.example`](../.env.example).

**Mainnet addresses (Livre Blanc Annexe 2, figés) :** [**ADRESSES_DEPLOIEMENT_MAINNET.md**](ADRESSES_DEPLOIEMENT_MAINNET.md).

Full BSC mainnet runbook: [**MAINNET_DEPLOYMENT.md**](MAINNET_DEPLOYMENT.md).

| # | French (review) | English (same meaning) | Environment variable | On-chain use (summary) |
|---|-----------------|------------------------|----------------------|-------------------------|
| 1 | Wallet **Coffre / Vault communautaire** | **Community protocol vault** | `VAULT_ADDRESS` | Vault share of **direct pool** fees (TCGV) and of **BuyRouter** USDC fees. Autolp accrual on the token is executed separately — see `executePendingAutolp` / [**FEE_REFERENCE.md**](FEE_REFERENCE.md). Founder paid mint USDC does **not** split here (see CASP row). |
| 2 | Wallet **Structure & Marketing** | **Marketing & structure** (fees) | `MARKETING_ADDRESS` | Marketing share of direct pool fees (TCGV) and BuyRouter USDC fees. |
| 3 | Wallet **Liquidité** | **Liquidity** | `LIQUIDITY_RECIPIENT` | Post–presale finalize: TCGV liquidity allocation 20 % (`setAllocationRecipients` / supply recompute). |
| 4 | Wallet **Burn** (ou adresse dead) | **Burn** (`address(0)`) | *(none)* | Burn destination is `address(0)`. Swap **fees** do **not** route to a dedicated burn wallet (`BURN_ADDRESS` is not used in `.env`); burn behavior is contract-driven in `TCGVaultToken`. |
| 5 | Wallet **Récompenses communautaires** | **Community rewards** | `COMMUNITY_ADDRESS` | **BuyRouter** default sell path sends part of the **USDC** fee here (see [**FEE_REFERENCE.md**](FEE_REFERENCE.md) §2.2). **Direct pool** sell defaults give **0%** of the sell fee to community unless sell params are changed on-chain. |
| 6 | Wallet **Équipe Fondatrice** | **Founding team** (4 % vesting) | `TEAM_RECIPIENT` | Post–presale finalize: team vesting 4 % — cliff 12 months + linear 24 months (`claimTeam`). **Not** the Réserve de Structuration (Annexe 3 / 70 k€ — off-contract). |

### Other required `.env` addresses (same deployment)

| English | Environment variable | Role |
|---------|------------------------|------|
| **Founder NFT CASP USDC sink** | `CASP_USDC_ADDRESS` | **Required**. `TCGVaultFounderNFT.mint()` transfers **100%** of paid USDC to `_caspUsdcRecipient` (Livre Blanc : Prévente CASP / GOin safeguarding). |
| **InitialLaunch USDC treasury / CASP sink** | `TREASURY_ADDRESS` | **Required**. Primary USDC sink for `TCGVaultInitialLaunch.buy()`. Same Prévente CASP address as `CASP_USDC_ADDRESS` for mainnet. |
| **Operations (5 % + 11 %)** | `OPS_RECIPIENT` | Post–presale: **5 %** TCGV immédiat + **11 %** vesting 36 mois (`claimOps`). Mainnet : même safe que Structure & Marketing (voir [ADRESSES…](ADRESSES_DEPLOIEMENT_MAINNET.md)). |
| **Stablecoin (mainnet)** | `USDC_ADDRESS` | **Required** on BSC mainnet (`yarn deploy:bsc`). Real BEP-20; MockUSDC refused. Testnet may omit and deploy MockUSDC. |

### Hors des 8 slots deploy (Annexe 2)

| Label LB | Role |
|----------|------|
| LP/Tokens | Détention LP — pas un recipient d’allocation token |
| Réserve de Structuration | Annexe 3 (jalon 70 k€) — **pas** `TEAM_RECIPIENT` |
| Réserve Stratégique | 5 % LB baggé on-chain dans `OPS_RECIPIENT` ; redistribution off-chain si besoin |
| Prévente (post-libération CASP) | Rotation après safeguarding — pas au deploy initial |

### Quick mapping checklist

- [ ] `VAULT_ADDRESS` = coffre / vault communautaire (frais)  
- [ ] `MARKETING_ADDRESS` = structure & marketing (frais)  
- [ ] `LIQUIDITY_RECIPIENT` = liquidité (20 % post-finalize)  
- [ ] Burn address = `address(0)` (no `BURN_ADDRESS` env var)  
- [ ] `COMMUNITY_ADDRESS` = récompenses communautaires  
- [ ] `TEAM_RECIPIENT` = **équipe fondatrice** (4 % vesting) — pas réserve de structuration  
- [ ] `CASP_USDC_ADDRESS` = Prévente CASP (Founder USDC 100 %)  
- [ ] `TREASURY_ADDRESS` = même CASP (Initial Launch USDC)  
- [ ] `OPS_RECIPIENT` = structure & marketing (5 % + 11 % ops)  
- [ ] `USDC_ADDRESS` = Binance-Peg USDC mainnet (confirm `decimals()`)  
- [ ] `BSC_RPC_URL` + `TCG_KEY` + `BSC_SCAN_API_KEY` for mainnet deploy/verify  

### Cooling-off cancellation disclosure

- `TCGVaultFounderNFT.cancelFounderPurchase()` and `TCGVaultInitialLaunch.cancelOrder()` emit refund-due amounts (`usdcRefundDue`) but do not execute on-chain USDC payout.
- Refund execution is expected from the regulated recipient account that received the original USDC transfer (`_caspUsdcRecipient` / `_treasury`).
- Before paying a refund, operators must verify the event’s `nexusClawedBack` (and related unwind fields) matches the expected bonus; do not auto-refund solely on `usdcRefundDue` if clawback is incomplete (e.g. Founder NFT transferred before cancel).
- Recipient addresses can be rotated by contract owner (`setCaspUsdcRecipient`, `setTreasury`), so operations should maintain an auditable mapping of active custody addresses and change approvals.

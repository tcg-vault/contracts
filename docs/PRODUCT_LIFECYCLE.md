# Product lifecycle (contract implementation)

Summary of how the main phases behave **in this repository’s Solidity contracts**. Authoritative fee parameters: [**FEE_REFERENCE.md**](FEE_REFERENCE.md). French summary: [**IMPLEMENTATION_NOTES_FR.md**](IMPLEMENTATION_NOTES_FR.md).

**Index of docs in this folder:** [`README.md`](README.md#documentation-in-this-folder).

## On-chain fees (defaults)

Numeric defaults, mutability (`ADMIN_ROLE`, router `onlyOwner`), caps (`TCGVaultToken.MAX_BUY_TAX_BP = 600`, `TCGVaultToken.MAX_SELL_TAX_BP = 500`, `TCGVaultBuyRouter.MAX_BUY_TOTAL_BP = 500`, `TCGVaultBuyRouter.MAX_SELL_TAX_BP = 400`), and the split between **paire (`TCGVaultToken`, routeur OFF)** and **portail USDC (`TCGVaultBuyRouter`, routeur ON)** are in [**FEE_REFERENCE.md**](FEE_REFERENCE.md). Summary:

- **Direct pool buy (routeur OFF):** **6%** TCGV; thirds to vault / marketing / `pendingAutolp` (**~2% + 2% + 2%** notional); no supply burn; **no $TCGNEXUS** on this path.
- **Direct pool sell:** **5%** TCGV; default **40% / 40% / 20%** of the fee to vault / autolp / marketing (**2% + 2% + 1%** notional; community **0%** default).
- **Router buy (routeur ON):** **5%** of USDC in (**3% + 2%** vault + marketing); **100%** of TCGV out to buyer.
- **Router sell:** **4%** of USDC out; four-way split (**FEE_REFERENCE.md** §2.2).
- **$TCGNEXUS cashback (portail):** **30%** / **3%** of TCGV via `recordBuyAndMintCashback` (`TCGVaultToken`).

## Product lifecycle

1. **Founder NFT sale (500 units)**  
   - **490** mints payants : vague 1 **245** × **200 USDC** (7 jours depuis le premier mint payant), puis vague 2 **245** × **350 USDC** (ou bascule anticipée si les 245 de vague 1 sont vendus).  
   - **10** NFT « réserve stratégique » : `mintStrategicReserve` (owner, sans USDC ni bonus NEXUS).  
   - Chaque mint payant : USDC **30%** vault / **60%** liquidité / **10%** ops (arrondis vers ops si besoin).  
   - L’acheteur reçoit **30%** du prix en NEXUS (18 décimales ; `TCGVaultFounderNFT`).

2. **Token presale (Initial Launch)**  
   - Users spend **USDC** for a **TCGV allocation** (vesting on the launch contract).  
   - Price wave 1: **0.005** USDC per 1 TCGV before Founder wave 2 starts; wave 2: **0.008** once `block.timestamp >= founderNFT.wave2StartTimestamp()`.  
   - Founder wave 2 runs for **10 days** (`FOUNDER_WAVE2_DURATION`), then a **120h** countdown starts (`presaleCountdownStartTime()`), and presale closes at `presaleEndTime()`.  
   - **Per-wallet cap:** **4%** of hard cap; **hard cap:** **600M** TCGV (18 decimals).  
   - **NEXUS bonus:** **30%** of USDC spent.  
   - After countdown, anyone can call **`finalize()`**. There is **no** early `finalize` when only the hard cap is reached.  
   - After `finalize` (TGE): **`claim()`** vests **10%** at TGE, then **10%/month** for **9** months (`releasable()`).

## Regulated custody and cancellation settlement

USDC custody and cooling-off cancellation are intentionally split between on-chain state management and regulated off-chain settlement.

- **Founder NFT (`TCGVaultFounderNFT`)**: `mint()` transfers USDC directly to `caspUsdcRecipient()` (`_caspUsdcRecipient` storage).
- **Initial Launch (`TCGVaultInitialLaunch`)**: `buy()` transfers USDC directly to `treasury()` (`_treasury` storage; deployment may use a CASP address).
- **No contract escrow**: USDC is not retained on these contracts during the 14-day cancellation window.
- **On-chain cancellation effects**: `cancelFounderPurchase()` and `cancelOrder()` unwind entitlement on-chain (burn NFT / burn allocated TCGV / claw back NEXUS bonus where applicable).
- **Refund execution**: USDC repayment is handled off-chain by the regulated recipient after indexing cancellation events (`FounderPurchaseCancelled`, `PresaleOrderCancelled`), where `usdcRefundDue` is emitted as the reconciliation amount.
- **Ops check before refund (F-2026-19267 / F-2026-15950)**: CASP/treasury operators must reconcile `nexusClawedBack` (and for Founder, current NFT ownership) before paying `usdcRefundDue`. A transfer of a Founder NFT before cancel can leave soulbound NEXUS on the original buyer while the canceller is the new owner — treat incomplete clawback as a blocked or escalated refund, not an automatic full USDC payout.

This architecture is used to satisfy the requirement that client funds are routed to regulated custody rails (CASP/treasury) instead of being held in smart contract escrow.

3. **Post-TGE trading**  
   - **`TCGVaultBuyRouter` (routeur ON):** **5%** USDC buy, **4%** USDC sell; $TCGNEXUS via token; fee-excluded on `TCGVaultToken` (no double tax).  
   - **`TCGVaultToken` (routeur OFF / paire):** **6%** buy / **5%** sell defaults in TCGV; presale flag, cashback portail uniquement, blacklist, pause, `pendingAutolp`, vesting hooks.

4. **Staking + Basic NFT**  
   - **ERC-4626** vault over TCGV. Depositing enough shares (≥ `requiredStakeForBasicNFT`) mints a **Basic NFT** to the **receiver**; withdrawing below the minimum **burns** that wallet’s Basic NFT.  
   - Basic NFT is **soulbound** (non-transferable).

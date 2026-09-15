# On-chain fee reference (source of truth)

Fee and role behavior as implemented in **`contracts/`** in this repository. Always verify live parameters on deployed instances (`BUY_TAX`, `sellTaxBp()`, etc.) before integrating.

**Two paths:**

| Mode | Contracts | Asset taxed | Default buy / sell |
|------|-----------|-------------|---------------------|
| **Routeur ON** (portail USDC) | `TCGVaultBuyRouter` + `recordBuyAndMintCashback` | **USDC** in/out | **5%** buy (3% + 2%) / **4%** sell on USDC out |
| **Routeur OFF** (DEX / paire directe) | `TCGVaultToken` on registered `isPair` | **TCGV** on swap transfer | **6%** buy / **5%** sell |

The buy router is **fee-excluded** on `TCGVaultToken` so USDC-path swaps are not taxed twice by pool fees.

**Basis points:** `10000` = 100%. **Mutability:** pool taxes — `TCGVaultToken` (`setBuyFeeParams` / `setSellFeeParams`, **`ADMIN_ROLE`**); USDC router — `TCGVaultBuyRouter` (`setBuyFeeParams` / `setSellFeeParams`, **`onlyOwner`**). Buy/sell **tax bps** are bounded only by immutable **`MAX_*`** constants (they may be raised again after being lowered, including after a mistaken zero). Router buy legs must keep **`vaultBp + marketingBp + communityBp` ≤ `MAX_BUY_TOTAL_BP`**. **Caps:** `TCGVaultToken`: **`MAX_BUY_TAX_BP = 600`**, **`MAX_SELL_TAX_BP = 500`**; `TCGVaultBuyRouter`: **`MAX_BUY_TOTAL_BP = 500`**, **`MAX_SELL_TAX_BP = 400`**. **No fee-driven TCGV supply burn** on these paths (fees accrue to recipients / `pendingAutolp`; router sends 100% of purchased TCGV to the buyer).

---

## 1. Direct V2 pool path — `TCGVaultToken` (routeur OFF)

Applies when users swap **TCGV ↔ other token** through a registered **pair** (`setPair(..., true)`). Fees are in **TCGV** on the buy/sell transfer legs.

### 1.1 Buy (pool)

| Parameter | Default (bps) | Meaning |
|-------------|---------------|---------|
| `BUY_TAX` | **600** | **6%** of bought TCGV taken as fee. |
| `BUY_VAULT_SHARE` | **3333** | **⅓** of fee → `vaultAddress` (**~2%** notional). |
| `BUY_MARKETING_SHARE` | **3333** | **⅓** of fee → `marketingAddress` (**~2%** notional). |
| `BUY_AUTOLP_SHARE` | **3334** | **⅓** of fee → `pendingAutolp` (**~2%** notional). |

### 1.2 Sell (pool)

| Parameter | Default (bps) | Meaning |
|-------------|---------------|---------|
| `SELL_TAX` | **500** | **5%** of sold TCGV taken as fee. |
| `SELL_VAULT_SHARE` | **4000** | **40%** of fee → vault (**2%** notional). |
| `SELL_AUTOLP_SHARE` | **4000** | **40%** of fee → `pendingAutolp` (**2%** notional). |
| `SELL_MARKETING_SHARE` | **2000** | **20%** of fee → marketing (**1%** notional). |
| `SELL_COMMUNITY_SHARE` | **0** | **0%** to community by default. |

### 1.3 $TCGNEXUS (portail vs paire)

| Path | $TCGNEXUS |
|------|-----------|
| **USDC portail** (`TCGVaultBuyRouter` → `recordBuyAndMintCashback`) | Yes: **30%** of TCGV received if `presaleActive`, else **3%**. |
| **Direct pair buy** (`_handleBuy`) | **No** mint on pair buys. |

Sells do not mint $TCGNEXUS.

---

## 2. USDC router path — `TCGVaultBuyRouter` (routeur ON)

Users call **`buyTCGVWithUSDC`** / **`sellTCGVForUSDC`**. Fees in **USDC** (buy) or on **USDC output** (sell).

### 2.1 Buy with USDC

| Parameter | Default (bps) | Meaning |
|-------------|---------------|---------|
| `_buyVaultBp` | **300** | **3%** of USDC in → vault (before swap). |
| `_buyMarketingBp` | **200** | **2%** of USDC in → marketing. |
| `_buyCommunityBp` | **0** | **0%** default on buy. |
| **Total USDC fee** | **500** | **5%** of USDC in; remainder swapped for TCGV. |

After swap, **100%** of TCGV goes to the buyer (no TCGV burn). $TCGNEXUS via `TCGVaultToken.recordBuyAndMintCashback`.

### 2.2 Sell for USDC

| Parameter | Default (bps) | Meaning |
|-------------|---------------|---------|
| `_sellTaxBp` | **400** | **4%** of USDC out as fee. |
| `_sellVaultShareBp` | **3750** | **1.5%** of USDC notional (of fee slice). |
| `_sellAutolpShareBp` | **2500** | **1%** notional. |
| `_sellMarketingShareBp` | **1250** | **0.5%** notional. |
| `_sellCommunityShareBp` | **2500** | **1%** notional. |

Shares sum to **10000** on the fee amount when calling `setSellFeeParams`.

### 2.3 Router admin

| Function | Who | Notes |
|----------|-----|-------|
| `setBuyFeeParams(vaultBp, marketingBp, communityBp)` | Owner | Sum of legs ≤ `MAX_BUY_TOTAL_BP` (500). |
| `setSellFeeParams(...)` | Owner | `taxBp` ≤ `MAX_SELL_TAX_BP` (400); four shares sum **10000**. |
| `setReferralToken` | Owner | Optional TCGR. |

### 2.4 TCGR referral (optional)

When `referralToken` is set, **`buyTCGVWithUSDC`** may call `processValidatedBuy` (e.g. **0.5%** — see `TCGRToken.sol`).

---

## 3. `TCGVaultToken` admin roles (fee-related)

| Role | Fee-related powers |
|------|---------------------|
| `ADMIN_ROLE` | `setBuyFeeParams`, `setSellFeeParams`, `setFeesEnabled`, `setCashbackEnabled`, `setMinAmounts`, `setDexRouter`, `setPair`, `setAddresses`, `setExcludedFromFees`, `setBuyRouter`, … |
| `PAUSER_ROLE` | `pause` |
| `UNPAUSER_ROLE` | `unpause` |
| `BLACKLISTER_ROLE` | `setBlacklisted` |
| `DEFAULT_ADMIN_ROLE` | Grant/revoke roles only. |

---

## 4. Liquidity wrapper

`TCGVaultLiquidityWrapper` sets transient storage so **add/remove liquidity** through an allowed router does **not** trigger TCGV buy/sell taxes on wrapper↔pair transfers.

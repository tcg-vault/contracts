# Hacken Second Review — Non-Fixed Findings Resolution Report

**Source:** Hacken SCA Second Review Report (08/09/2026), updated final commit `7e785d4`  
**Date:** 2026-09-12  
**Scope of this pass:** resolve Pending Fix items (except F-2026-19267 Accepted); keep Mitigated/Accepted dispositions

## Inventory (non-Fixed only)

| ID | Severity | Prior status | Disposition |
|----|----------|--------------|-------------|
| F-2026-19272 | High | Pending Fix | **Fixed** |
| F-2026-15950 | High | Mitigated | **Mitigated** (unchanged; docs reinforced) |
| F-2026-19269 | Low | Pending Fix | **Fixed** |
| F-2026-19271 | Low | Pending Fix | **Fixed** |
| F-2026-19267 | Info | Pending Fix | **Accepted** (no code change) |
| F-2026-19268 | Info | Pending Fix | **Fixed** |
| F-2026-16107 | Info | Accepted | **Accepted** (unchanged) |

All other findings in the report remain Fixed.

---

## F-2026-19272 — Hardcoded 6-decimal stablecoin (High)

**Verdict:** Valid → Fixed  

**Change:** Prices and USDC→18-dec scaling are derived from `IERC20Metadata(usdc).decimals()` at construction (or when configuring vault TWAP USDC):

- `TCGVaultFounderNFT`: immutable `WAVE1_PRICE` / `WAVE2_PRICE` = `200/350 * 10**d`
- `TCGVaultInitialLaunch`: immutable `PRICE_WAVE1` / `PRICE_WAVE2` = `0.005/0.008 * 10**d`
- `TCGRToken`: constructor takes `usdc_`; referral mint uses `10**(18-d)`
- `TCGVaultStakingVault`: `_basicNftTargetUsdc = 25 * 10**d` when pricing USDC is set

**Tests:** `test/AuditPendingFixes.test.ts` (18-dec Founder mint at 200 USDC; dust amount reverts). Full suite green.

**Auditor response:**  
Accepted. All USD-denominated constants are now scaled from the wired stablecoin’s `decimals()`. Deploying against BNB Chain 18-decimal stables no longer underprices Founder/presale or over-mints NEXUS/TCGR.

---

## F-2026-19269 — Buy fee vs pair balance swap (Low)

**Verdict:** Valid → Fixed  

**Change:** Buy path uses `_swapExactInput(path, swapAmount, …)` so output is sized from the post-fee amount transferred by the router, not `balanceOf(pair) - reserve`. Sell path still uses FoT-aware balance-delta swap for TCGV.

**Tests:** Donation to pair + dust `buyTCGVWithUSDC` cannot consume the donation / cannot bypass fee sizing.

**Auditor response:**  
Accepted. Buy swaps use the exact post-fee `swapAmount`. Pair surplus is ignored for buy output calculation.

---

## F-2026-19271 — Direct TCGV to vault (Low)

**Verdict:** Valid → Fixed  

**Change:**

- `totalAssets()` returns `_trackedAssets` (updated in `_deposit` / `_withdraw`)
- `recoverUnsolicitedAssets(to)` (owner) sweeps `balance - tracked`

**Tests:** Donation does not change `totalAssets`; owner recovers surplus; stake accounting unchanged.

**Auditor response:**  
Accepted. Exchange rate ignores unsolicited transfers; owner can recover stranded TCGV without touching deposited stake.

---

## F-2026-19268 — DEX router fee exclusion (Info)

**Verdict:** Valid → Fixed  

**Change:**

- `_setDexRouter` no longer sets `isExcludedFromFees[router]`
- `TCGVaultStakingVault._withdraw` reverts `ReceiverIsPair` if `receiver` is a registered pair

BuyRouter / LiquidityWrapper remain fee-excluded via explicit setters.

**Tests:** Constructor/router registration leaves DEX router taxable; redeem-to-pair reverts.

**Auditor response:**  
Accepted. Shared Pancake-style routers are no longer fee-excluded by `setDexRouter`. Vault exits cannot deliver underlying into a registered pair.

---

## F-2026-19267 — Founder cancel after transfer (Info)

**Verdict:** Partially valid as an ops/reconciliation concern → **Accepted** (no Solidity change)

**Reasoning:** Founder NFTs are intentionally transferable collectibles. Soulbinding or buyer-only cancel during the cooling-off window would change the product model. Clawback already clamps to the canceller’s NEXUS balance. Economic risk is off-chain refund SOP, not on-chain NFT burn correctness.

**Docs:** `docs/PRODUCT_LIFECYCLE.md` and `docs/WALLET_ADDRESSES.md` now require CASP/treasury to verify `nexusClawedBack` before paying `usdcRefundDue`.

**Auditor response:**  
Accepted as design. Founder NFTs remain transferable. Refund operators must not auto-pay full `usdcRefundDue` when `nexusClawedBack` is incomplete (e.g. NFT transferred before cancel). Presale `cancelOrder` already binds to the recorded buyer.

---

## F-2026-15950 — Off-chain refund (High, Mitigated)

**Disposition:** Remains Mitigated (MiCA/CASP custody; no on-chain escrow). Documentation for custody recipients and refund checks reinforced alongside F-2026-19267.

---

## F-2026-16107 — Indexed events (Info, Accepted)

**Disposition:** Unchanged. The Graph indexes full event data; indexed topics are a gas/design choice.

---

## Verification

```text
npx hardhat test
→ 238 passing
```

Including new file `test/AuditPendingFixes.test.ts` covering the four code fixes without expanding product scope beyond auditor remediations.

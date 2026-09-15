# TCG Vault Token Contracts

This directory contains the ERC20 token contracts for the TCG Vault ecosystem and **technical documentation** for integrators and auditors.

## Documentation in this folder

| File | Purpose |
|------|---------|
| [**README.md**](README.md) (this file) | Contract overview, deployment order, operational notes, events, admin entrypoints summary. |
| [**FEE_REFERENCE.md**](FEE_REFERENCE.md) | Frais : routeur OFF (paire / `TCGVaultToken`) vs routeur ON (USDC / `TCGVaultBuyRouter`). |
| [**PRODUCT_LIFECYCLE.md**](PRODUCT_LIFECYCLE.md) | Product phases as implemented (Founder NFT, Initial Launch, trading, staking). |
| [**IMPLEMENTATION_NOTES_FR.md**](IMPLEMENTATION_NOTES_FR.md) | French: same implementation facts (fees, presale, NFTs). |
| [**WALLET_ADDRESSES.md**](WALLET_ADDRESSES.md) | `.env` variable ↔ wallet role mapping for deploy scripts. |

---

## Contracts

### TCGVaultToken.sol (TCGV)
Token A — economic engine. BNB Chain, 1 milliard supply (fixed in contract).

**Features:**
- **Direct pair (routeur OFF):** Buy **6%** TCGV (`BUY_TAX = 600`), fee split in thirds → vault / marketing / `pendingAutolp` (**~2% + 2% + 2%** notional). Sell **5%** (`SELL_TAX = 500`), split **40% / 40% / 20%** of the fee → vault / autolp / marketing (**2% + 2% + 1%** notional; community **0%** by default). No TCGV burn on fee distribution. **No $TCGNEXUS** on pair buys — cashback **only** via `recordBuyAndMintCashback` when using **`TCGVaultBuyRouter`** (routeur ON).
- **`pendingAutolp` / `executePendingAutolp`:** liquidity accrual from fee legs; not a supply burn.

### TCGNexusToken.sol (NEXUS)
Soulbound governance / membership token.

**Features:**
- Soulbound (non transférable): no transfers between accounts; mint and burn only
- Cashback minter = `TCGVaultToken`, set at deployment (immutable)
- Presale bonus mint/burn access = immutable `FounderNFT` + `InitialLaunch` addresses only
- No generic owner mint path

### TCGVaultBuyRouter.sol
**Routeur ON (portail USDC).** Default **5%** of USDC in (**300** + **200** + **0** bps → vault / marketing / community); remainder swapped; **100%** of TCGV out to the buyer (no TCGV burn). $TCGNEXUS via `recordBuyAndMintCashback` (30% / 3% of **TCGV** received). Transient storage avoids double-taxing on `TCGVaultToken`.

**Sell (`sellTCGVForUSDC`):** default **4%** of USDC out (`sellTaxBp = 400`), split **3750 / 2500 / 1250 / 2500** → **1.5% / 1% / 0.5% / 1%** notional. Router is fee-excluded on the token.

Full tables, getters, and caps: [**FEE_REFERENCE.md**](FEE_REFERENCE.md).

### TCGVaultLiquidityWrapper.sol
Use for **adding/removing liquidity** so TCGV does **not** charge fees on those transfers. Sets transient storage (EIP-1153) before calling the DEX router; `TCGVaultToken` skips fees when this slot is set. Requires **Cancun** (or later) hardfork for `tstore`/`tload`.

### Other contracts in this repo
Founder NFT (`TCGVaultFounderNFT`), Initial Launch / presale (`TCGVaultInitialLaunch`), staking + Basic NFT (`TCGVaultStakingVault`, `TCGVaultBasicNFT`), converter, and TCGR are under `contracts/`; see [**PRODUCT_LIFECYCLE.md**](PRODUCT_LIFECYCLE.md).  
Current schedule: Founder wave 1 runs 7 days from the first mint (or until sellout), wave 2 then runs 10 days, followed by a 120h presale countdown.

## Deployment Steps

NEXUS is **immutable** on `TCGVaultToken` (constructor arg). `TCGNexusToken` needs the TCGV address as minter, so deploy in this order using the **predicted** TCGV address (Create address for `nonce` and `nonce+1` on the deployer account):

1. **Deploy TCGNexusToken** with `minter = predictedTCGVAddress`.
   ```solidity
   TCGNexusToken nexusToken = new TCGNexusToken(predictedTCGVAddress);
   ```

2. **Deploy TCGVaultToken** with `nexusToken = address(nexusToken)` (must match the address from step 1). Name, symbol and supply are fixed in the contract.
   ```solidity
   TCGVaultToken token = new TCGVaultToken(
       stakingVaultAddress,
       dexRouterAddress,
       vaultAddress,
       marketingAddress,
       communityAddress,
       address(nexusToken),
       initialLaunchAddress
   );
   ```

3. **Add initial liquidity** on your DEX and call `token.setPair(pairAddress, true)` to register the taxable pair (use `active = false` to disable a pool).

4. **Fee-exclude the liquidity wrapper** via `token.setExcludedFromFees(wrapperAddress, true)` so LP add/remove path (wrapper↔pair) is not taxed as swap. The wrapper withdraws to itself on remove, then forwards to the user.

5. **Deploy TCGVaultBuyRouter** (optional — stablecoin path on BSC) and set it on the token:
   ```solidity
   TCGVaultBuyRouter buyRouter = new TCGVaultBuyRouter(
       dexRouterAddress,
       usdcAddress,
       ITCGVaultToken(address(token)),
       vaultAddress,
       marketingAddress,
       communityAddress
   );
   token.setBuyRouter(address(buyRouter));
   ```
   Users who buy via `buyTCGVWithUSDC` pay the router’s **USDC** fee, receive **100%** of swapped TCGV (no burn), and get NEXUS cashback per token rules.

### BSC Testnet (chainId 97)

Script: `yarn deploy:bsctest` → `scripts/deployBscTestnet.ts` on Hardhat network `bsctest` (`BSCTEST_RPC_URL` + `TCG_KEY` in keystore).

- PancakeSwap V2 testnet **factory** `0x6725F303b657a9451d8BA641348b6761A6CC7a17`, **router** `0xD99D1c33F9fC3444f8101754aBC46c52416550D1` — see [Pancake docs](https://developer.pancakeswap.finance/contracts/v2/addresses).
- **USDC:** BSC testnet has no single canonical Circle USDC. The script deploys **`MockUSDC`** (6 decimals, open `mint`) unless you set **`USDC_ADDRESS`** to an existing token.

## Fee structure

Authoritative detail: [**FEE_REFERENCE.md**](FEE_REFERENCE.md).

**`TCGVaultToken` (routeur OFF / paire):** default buy **6%** (`BUY_TAX = 600`), shares **3333 / 3333 / 3334**; default sell **5%** (`SELL_TAX = 500`), shares **4000 / 4000 / 2000 / 0**. Caps **`MAX_BUY_TAX_BP = 600`**, **`MAX_SELL_TAX_BP = 500`**. **`ADMIN_ROLE`**, shares sum **10_000**; tax bps may move up or down within those caps.

**`TCGVaultBuyRouter` (routeur ON / USDC):** default **5%** USDC in (**300** + **200** + **0** bps); default sell **4%** USDC out, split **3750 / 2500 / 1250 / 2500**. Caps **`MAX_BUY_TOTAL_BP = 500`**, **`MAX_SELL_TAX_BP = 400`**. **`onlyOwner`**; buy legs sum ≤ **`MAX_BUY_TOTAL_BP`**.

## Important Notes

1. **Pair Detection:** The contract detects buys/sells by checking if transfers are to/from the PancakeSwap pair address.

2. **DEX routers:** The constructor registers one V2-style router (`dexFactoryForRouter[router] = router.factory()`). Add or remove more with `setDexRouter(router, active)` (emits `DexRouterUpdated`). Registered routers are fee-excluded. Taxed swaps are still driven by `isPair`, not by this mapping.

3. **Cashback:** NEXUS cashback on **buys** via **`recordBuyAndMintCashback`** (portail / routeur USDC): **30%** presale / **3%** after finalize. Achats **directs depuis la paire** ne mintent pas de NEXUS. NEXUS est soulbound. `TCGNexusToken`’s minter is set at deployment to `TCGVaultToken` and is immutable (no setter).

4. **Autolp:** Portions of buy/sell fees increase `pendingAutolp`; operators call `executePendingAutolp` when adding liquidity (see token NatSpec). This accrual is not a circulating-supply burn.

5. **Minimum amounts:** Buy and sell transfers below `minBuyAmount` / `minSellAmount` revert with `MinAmountNotMet`. **`ADMIN_ROLE`** can set these via `setMinAmounts`. Default is **10_000** (wei).

6. **Exclusions:** The token contract itself and the initial DEX router are excluded from fees by default; more routers added via `setDexRouter` are excluded too. Other addresses via `setExcludedFromFees` (including the deployer if you set it explicitly).

7. **Presale custody + cooling-off refunds:** In `TCGVaultFounderNFT` and `TCGVaultInitialLaunch`, USDC is transferred directly to configured custody recipients (`caspUsdcRecipient` / `treasury`) and is not escrowed in-contract during the 14-day cancellation window. Cancellation functions (`cancelFounderPurchase`, `cancelOrder`) unwind on-chain entitlements and emit refund-due events for regulated off-chain repayment (`FounderPurchaseCancelled`, `PresaleOrderCancelled`). See [**PRODUCT_LIFECYCLE.md**](PRODUCT_LIFECYCLE.md#regulated-custody-and-cancellation-settlement).

## Security Considerations

- The token uses `ReentrancyGuard` for sell operations; the buy router uses transient reentrancy protection.
- **`ADMIN_ROLE`** can toggle fees via `setFeesEnabled`; pause / unpause use **`PAUSER_ROLE`** / **`UNPAUSER_ROLE`**; blacklist uses **`BLACKLISTER_ROLE`**. **`DEFAULT_ADMIN_ROLE`** is intended for granting/revoking those roles only (deployer holds all roles at construction).
- Fee **rates and splits** are **governable** within caps (`TCGVaultToken` paire: **600/500**; `TCGVaultBuyRouter`: **500/400** on buy sum / **400** sell tax). Read on-chain values when integrating.
- Emergency patterns (pause, blacklist) are documented in the Solidity files.

## Functions

### `DEFAULT_ADMIN_ROLE` (role admin only)
- `grantRole` / `revokeRole` for `ADMIN_ROLE`, `PAUSER_ROLE`, `UNPAUSER_ROLE`, `BLACKLISTER_ROLE` (OpenZeppelin `AccessControl`).

### `ADMIN_ROLE` (routine configuration)
- `setDexRouter(address, bool)` — Register another V2 router (stores `factory()`, fee-excludes it) or remove one (`DexRouterUpdated`)
- `setPair(address, bool)` — Register or disable a V2 pool for buy/sell fee logic (`PairActiveUpdated`)
- `setAddresses(vault, marketing, community)` — Update vault / marketing / community fee recipients; emits `FeeRecipientsUpdated` (**NEXUS address is not updatable**)
- `setExcludedFromFees(address, bool)` — Exclude/include addresses from fees (emits `ExcludedFromFeesUpdated`; constructor also emits for deployer, token, and DEX router; `setBuyRouter` emits when router is non-zero)
- `setFeesEnabled(bool)` — Enable/disable fees
- `setCashbackEnabled(bool)` — Enable/disable cashback
- `setMinAmounts(uint256, uint256)` — Set minimum buy/sell amounts for fee computation
- `setBuyFeeParams` / `setSellFeeParams` — Update **paire** (routeur OFF) tax bps and splits (shares sum to 10_000; tax ≤ `MAX_BUY_TAX_BP` / `MAX_SELL_TAX_BP`)
- `setAllocationRecipients` — Liquidity / team / ops recipients required before supply recompute
- `setBuyRouter` — Wire `TCGVaultBuyRouter` (zero address clears)

### `PAUSER_ROLE` / `UNPAUSER_ROLE`
- `pause` / `unpause` respectively.

### `BLACKLISTER_ROLE`
- `setBlacklisted` — Enable/disable blacklist with required reason string when enabling.

### Public Functions
- Standard ERC20 functions (transfer, approve, etc.)

## Events

`TCGVaultToken` emits configuration events whenever state changes, **including in the constructor** (fee recipients, NEXUS, min amounts, fee toggles, buy/sell params, first DEX router, exclusions), so a subgraph can index from block 0 without missing defaults.

Notable events: `FeeRecipientsUpdated`, `MinAmountsUpdated`, `FeesEnabledUpdated`, `CashbackEnabledUpdated`, `PresaleActiveUpdated`, `BuyFeeParamsUpdated`, `SellFeeParamsUpdated`, `DexRouterUpdated`, `ExcludedFromFeesUpdated`, `PairActiveUpdated`, `PresaleFinalizerSet`, `AllocationRecipientsUpdated`, `BuyRouterUpdated`, `Paused` / `Unpaused`, `BlacklistUpdated`, `SupplyRecomputed`, vesting / fee distribution events.

- `FeesDistributed` — Buy/sell fee splits applied
- `CashbackDistributed` — NEXUS cashback minted

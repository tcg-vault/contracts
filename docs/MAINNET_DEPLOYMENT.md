# BSC Mainnet deployment runbook

Full-stack deploy for BNB Chain **chainId 56**. Do **not** use the legacy partial script (`deployTCGVault.ts`) for production.

## Scripts

| Command | Purpose |
|---------|---------|
| `yarn preflight:bsc` | Read-only checks on network `bsc` (chainId, env wallets, USDC metadata, Pancake code, deployer BNB) |
| `yarn preflight:bsc:tenderly` | Same checks on Hardhat network `tenderly` (`TENDERLY_RPC_URL`, chainId 56) |
| `yarn dryrun:bsc-env` | Env + `eth_call` checks via `BSC_RPC_URL` without deploying (works without Hardhat archive fork) |
| `yarn deploy:bsc` | Full stack on **live** BSC → [`scripts/deployBscMainnet.ts`](../scripts/deployBscMainnet.ts) |
| `yarn deploy:bsc:tenderly` | Same script on Tenderly Virtual TestNet (rehearsal only — **not** production) |
| `yarn fork:dex` / `yarn fork:full` | Pre-deploy smoke on a BSC **archive** fork (`BSC_RPC_URL` must support historical state) |
| `yarn deploy:bsc:legacy-partial` | **Avoid for mainnet** — NEXUS + TCGV + BuyRouter only |

Artifacts after deploy:

- `.cache/last-bsc-mainnet-deploy.json` — subgraph sync payload
- `.cache/last-bsc-mainnet-deploy-full.json` — full address dump for frontend/ops

## Tenderly Virtual TestNet (rehearsal)

`TENDERLY_RPC_URL` (`virtual.binance…`) is a **fork simulation**, not live BSC.  
This project’s VNet uses custom **chainId `99956`** (set `TENDERLY_CHAIN_ID` if yours differs).

```bash
yarn preflight:bsc:tenderly
yarn deploy:bsc:tenderly
```

Verify + subgraph sync are skipped automatically on Tenderly.  
Fund the deployer via the Tenderly UI if BNB balance is 0.  
Production go-live remains: `yarn deploy:bsc` with `BSC_RPC_URL` (chainId 56).

## Prerequisites

1. Hardhat network `bsc`: `BSC_RPC_URL` + `TCG_KEY` (see [`.env.example`](../.env.example)).
2. `BSC_SCAN_API_KEY` for verification (or set `SKIP_VERIFY=1` and verify later).
3. Frozen production addresses: [ADRESSES_DEPLOIEMENT_MAINNET.md](ADRESSES_DEPLOIEMENT_MAINNET.md) (values) + [WALLET_ADDRESSES.md](WALLET_ADDRESSES.md) (role sheet).
4. Real stablecoin in `USDC_ADDRESS` (MockUSDC is **refused**). Common Binance-Peg USDC: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` — always confirm `decimals()` on-chain (contracts scale from metadata).
5. Pancake V2 mainnet (hardcoded in deploy script):
   - Factory `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73`
   - Router `0x10ED43C718714eb63d5aA57B78B54704E256024E`

## Deploy order (scripted)

CREATE nonce prediction on the deployer:

1. `TCGNexusToken` (minter = predicted TCGV; bonus minters = predicted Founder + InitialLaunch)
2. `TCGVaultToken` (immutable NEXUS + InitialLaunch; Pancake router)
3. `TCGVaultFounderNFT` (USDC → `CASP_USDC_ADDRESS` **100%** on paid mint)
4. `TCGVaultInitialLaunch` (USDC → `TREASURY_ADDRESS`)
5. `token.setAllocationRecipients(LIQUIDITY, TEAM, OPS)`
6. `TCGVaultStakingVault` + `TCGVaultBasicNFT` + pricing router wiring
7. `TCGVaultBuyRouter` + `token.setBuyRouter`
8. `TCGVaultLiquidityWrapper` + fee-exclude wrapper + staking vault
9. Optional `TCGRToken` + `TCGRToTCGVConverter` (skip with `SKIP_TCGR=1`)
10. BscScan verify batch + optional subgraph sync

## Post-deploy ops

1. **Presale**
   - Founder NFT paid mints: USDC goes entirely to `caspUsdcRecipient` (`CASP_USDC_ADDRESS`). Buyer receives NEXUS bonus (30% of price, 18 decimals).
   - Initial Launch `buy()`: USDC to `treasury` (`TREASURY_ADDRESS`).
   - No on-chain USDC escrow during the cooling-off window.

2. **Finalize (TGE)**
   - After the countdown (`presaleEndTime`), call `initialLaunch.finalize()`.
   - Effects: supply recompute / allocations, NEXUS cashback mode moves to post-presale **3%** on BuyRouter buys.

3. **Pair + trading**
   - Create Pancake V2 pair TCGV/USDC (factory above or via router).
   - `token.setPair(pair, true)`.
   - Add liquidity **via `TCGVaultLiquidityWrapper`** (fee-excluded). Approvals: TCGV + USDC → wrapper, then wrapper `addLiquidity`.

4. **Verify + index**
   - Confirm contracts on BscScan (`SKIP_VERIFY=0` during deploy, or re-run verify).
   - Subgraph: deploy writes `.cache/last-bsc-mainnet-deploy.json`; sync unless `SKIP_SUBGRAPH_SYNC=1`.
   - Point frontend at the full deploy JSON addresses.

5. **Refund SOP (MiCA cooling-off)**
   - Cancellations emit `usdcRefundDue` but do **not** pay USDC on-chain.
   - CASP/treasury operators must reconcile `nexusClawedBack` (and Founder ownership) before paying refunds.
   - Do **not** auto-pay full `usdcRefundDue` if clawback is incomplete (e.g. Founder NFT transferred before cancel). See [PRODUCT_LIFECYCLE.md](PRODUCT_LIFECYCLE.md#regulated-custody-and-cancellation-settlement).

6. **Admin handoff**
   - Deployer holds `DEFAULT_ADMIN_ROLE` / Ownable at construction.
   - After wiring and smoke checks, transfer ownership / grant roles to the production multisig and revoke deployer privileges where intended.

## Optional env toggles

| Variable | Effect |
|----------|--------|
| `SKIP_TCGR=1` | Skip TCGR + converter (also skips subgraph sync) |
| `SKIP_SUBGRAPH_SYNC=1` | Keep deploy JSON; skip ABI/subgraph pipeline |
| `SKIP_VERIFY=1` | Skip BscScan verification batch |
| `BASIC_NFT_MIN_STAKE` | Decimal TCGV string for Basic NFT stake gate (default `5000`) |
| `VERIFY_WAIT_SECONDS` | Delay before verify (default `30`) |

## Preflight checklist

- [ ] `yarn test` green
- [ ] `BSC_RPC_URL=... yarn dryrun:bsc-env` passes (or `yarn preflight:bsc` on network `bsc`)
- [ ] Prefer `yarn fork:dex` / `fork:full` when an archive-capable `BSC_RPC_URL` is available
- [ ] Wallets frozen per [ADRESSES_DEPLOIEMENT_MAINNET.md](ADRESSES_DEPLOIEMENT_MAINNET.md); deployer funded with BNB
- [ ] `USDC_ADDRESS` set explicitly (Binance-Peg USDC is 18 decimals — confirm before go-live)
- [ ] CASP/treasury refund SOP documented for ops
- [ ] `yarn deploy:bsc`
- [ ] Save `.cache/last-bsc-mainnet-deploy-full.json`
- [ ] Post-deploy steps 1–6 above

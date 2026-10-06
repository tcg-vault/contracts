/**
 * Offline-ish dry-run of mainnet deploy env + on-chain prerequisites.
 *
 * Uses BSC_RPC_URL (or BSC_PUBLIC_RPC_URL fallback) with eth_call / eth_getCode only.
 * Does not deploy. Suitable when a full Hardhat archive fork is unavailable.
 *
 * Usage:
 *   BSC_RPC_URL=https://... yarn hardhat run scripts/dryRunBscMainnetEnv.ts --network hardhat
 *   # or, if hardhat has no fork, the script still uses fetch against BSC_RPC_URL directly:
 *   BSC_RPC_URL=https://bsc-dataseed.binance.org npx tsx scripts/dryRunBscMainnetEnv.ts
 */

import { config as dotenvConfig } from "dotenv";

dotenvConfig();

const PANCAKE_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const PANCAKE_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const DEFAULT_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";

const REQUIRED_ENV = [
  "VAULT_ADDRESS",
  "MARKETING_ADDRESS",
  "COMMUNITY_ADDRESS",
  "CASP_USDC_ADDRESS",
  "TREASURY_ADDRESS",
  "LIQUIDITY_RECIPIENT",
  "TEAM_RECIPIENT",
  "OPS_RECIPIENT",
] as const;

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status} for ${method}`);
  }
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) {
    throw new Error(body.error.message ?? JSON.stringify(body.error));
  }
  return body.result;
}

async function main() {
  const rpcUrl = process.env.BSC_RPC_URL?.trim() || process.env.BSC_PUBLIC_RPC_URL?.trim();
  if (!rpcUrl) {
    console.error("Set BSC_RPC_URL (or BSC_PUBLIC_RPC_URL) for dry-run chain checks.");
    process.exit(1);
  }

  let failed = 0;
  const ok = (m: string) => console.log(`✓ ${m}`);
  const bad = (m: string) => {
    console.error(`✗ ${m}`);
    failed += 1;
  };

  console.log("=".repeat(72));
  console.log("BSC mainnet env dry-run (no deploy)");
  console.log("=".repeat(72));
  console.log("RPC:", rpcUrl);

  for (const name of REQUIRED_ENV) {
    const v = process.env[name]?.trim();
    if (v) ok(`${name} set`);
    else bad(`${name} missing (freeze wallets before deploy)`);
  }

  const usdc = process.env.USDC_ADDRESS?.trim() || DEFAULT_USDC;
  if (!process.env.USDC_ADDRESS?.trim()) {
    console.warn(`! USDC_ADDRESS unset — checking default Binance-Peg USDC ${DEFAULT_USDC}`);
  } else {
    ok(`USDC_ADDRESS=${usdc}`);
  }

  try {
    const chainIdHex = (await rpc(rpcUrl, "eth_chainId", [])) as string;
    const chainId = Number.parseInt(chainIdHex, 16);
    if (chainId === 56) ok(`eth_chainId=${chainId}`);
    else bad(`eth_chainId=${chainId} (expected 56)`);

    const routerCode = (await rpc(rpcUrl, "eth_getCode", [PANCAKE_ROUTER, "latest"])) as string;
    if (routerCode && routerCode !== "0x") ok(`Pancake router has code`);
    else bad(`Pancake router empty at ${PANCAKE_ROUTER}`);

    const factoryCode = (await rpc(rpcUrl, "eth_getCode", [PANCAKE_FACTORY, "latest"])) as string;
    if (factoryCode && factoryCode !== "0x") ok(`Pancake factory has code`);
    else bad(`Pancake factory empty at ${PANCAKE_FACTORY}`);

    const usdcCode = (await rpc(rpcUrl, "eth_getCode", [usdc, "latest"])) as string;
    if (usdcCode && usdcCode !== "0x") ok(`USDC has code at ${usdc}`);
    else bad(`USDC empty at ${usdc}`);

    // decimals() selector 0x313ce567
    const decHex = (await rpc(rpcUrl, "eth_call", [{ to: usdc, data: "0x313ce567" }, "latest"])) as string;
    const decimals = Number.parseInt(decHex, 16);
    ok(`USDC decimals()=${decimals}`);
    if (decimals !== 6 && decimals !== 18) {
      console.warn(`! Unusual decimals=${decimals}; contracts scale from metadata — confirm pricing.`);
    }
  } catch (e) {
    bad(`RPC checks failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log();
  console.log("Deploy command when ready: yarn deploy:bsc");
  console.log("Full runbook: docs/MAINNET_DEPLOYMENT.md");
  if (failed > 0) {
    console.error(`Dry-run FAILED (${failed}).`);
    process.exit(1);
  }
  console.log("Dry-run PASSED for available checks.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

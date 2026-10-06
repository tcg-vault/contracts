/**
 * BSC Mainnet preflight — read-only checks before `yarn deploy:bsc`.
 *
 * Validates:
 *   - chainId === 56
 *   - required wallet / USDC env addresses present
 *   - USDC_ADDRESS has code and exposes decimals()/symbol()
 *   - Pancake V2 router + factory have code
 *   - deployer has a non-zero BNB balance
 *
 * Does not deploy contracts.
 *
 * Usage:
 *   yarn preflight:bsc
 *   yarn preflight:bsc:tenderly
 */

import { formatEther, type Address } from "viem";
import {
  CHAIN_ID_BSC_MAINNET,
  connectBscLikeDeployNetwork,
  isAllowedBscDeployChainId,
  tenderlyVirtualChainId,
} from "./connectBscLikeNetwork.js";
const PANCAKE_FACTORY_MAINNET = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73" as Address;
const PANCAKE_ROUTER_MAINNET = "0x10ED43C718714eb63d5aA57B78B54704E256024E" as Address;

const IERC20_METADATA_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

const REQUIRED_ENV = [
  "VAULT_ADDRESS",
  "MARKETING_ADDRESS",
  "COMMUNITY_ADDRESS",
  "CASP_USDC_ADDRESS",
  "TREASURY_ADDRESS",
  "LIQUIDITY_RECIPIENT",
  "TEAM_RECIPIENT",
  "OPS_RECIPIENT",
  "USDC_ADDRESS",
] as const;

function readAddress(name: string): Address | undefined {
  const v = process.env[name]?.trim();
  if (!v) return undefined;
  return v as Address;
}

async function hasCode(
  publicClient: { getCode: (args: { address: Address }) => Promise<`0x${string}` | undefined> },
  address: Address,
): Promise<boolean> {
  const code = await publicClient.getCode({ address });
  return Boolean(code && code !== "0x");
}

async function main() {
  const { publicClient, deployer, chainId, isTenderlyVirtual } =
    await connectBscLikeDeployNetwork();

  let failed = 0;
  const ok = (msg: string) => console.log(`✓ ${msg}`);
  const bad = (msg: string) => {
    console.error(`✗ ${msg}`);
    failed += 1;
  };

  console.log("=".repeat(72));
  console.log(
    isTenderlyVirtual
      ? "BSC Tenderly Virtual TestNet preflight (read-only)"
      : "BSC Mainnet preflight (read-only)",
  );
  console.log("=".repeat(72));

  if (isAllowedBscDeployChainId(chainId)) {
    ok(
      isTenderlyVirtual
        ? `chainId ${chainId} (Tenderly Virtual BSC — not production)`
        : `chainId ${chainId}`,
    );
  } else {
    bad(
      `chainId ${chainId} (expected ${CHAIN_ID_BSC_MAINNET.toString()} or Tenderly ${tenderlyVirtualChainId().toString()})`,
    );
  }

  const deployerAddr = deployer.account.address as Address;
  const bal = await publicClient.getBalance({ address: deployerAddr });
  console.log("Deployer:", deployerAddr);
  console.log("BNB balance:", formatEther(bal));
  if (bal > 0n) {
    ok("deployer has BNB for gas");
  } else {
    bad("deployer BNB balance is 0");
  }

  for (const name of REQUIRED_ENV) {
    const addr = readAddress(name);
    if (addr) {
      ok(`${name}=${addr}`);
    } else {
      bad(`missing ${name}`);
    }
  }

  if (await hasCode(publicClient, PANCAKE_ROUTER_MAINNET)) {
    ok(`Pancake router ${PANCAKE_ROUTER_MAINNET}`);
  } else {
    bad(`Pancake router has no code at ${PANCAKE_ROUTER_MAINNET}`);
  }
  if (await hasCode(publicClient, PANCAKE_FACTORY_MAINNET)) {
    ok(`Pancake factory ${PANCAKE_FACTORY_MAINNET}`);
  } else {
    bad(`Pancake factory has no code at ${PANCAKE_FACTORY_MAINNET}`);
  }

  const usdc = readAddress("USDC_ADDRESS");
  if (usdc) {
    if (!(await hasCode(publicClient, usdc))) {
      bad(`USDC_ADDRESS has no code at ${usdc}`);
    } else {
      try {
        const decimals = await publicClient.readContract({
          address: usdc,
          abi: IERC20_METADATA_ABI,
          functionName: "decimals",
        });
        const symbol = await publicClient.readContract({
          address: usdc,
          abi: IERC20_METADATA_ABI,
          functionName: "symbol",
        });
        ok(`USDC ${usdc} symbol=${symbol} decimals=${decimals}`);
        if (Number(decimals) !== 6 && Number(decimals) !== 18) {
          console.warn(
            `! Unusual stablecoin decimals=${decimals}. Contracts scale from metadata; double-check pricing.`,
          );
        }
      } catch (e) {
        bad(`USDC_ADDRESS metadata read failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  console.log();
  if (failed > 0) {
    console.error(`Preflight FAILED (${failed} check(s)). Fix before yarn deploy:bsc.`);
    process.exit(1);
  }
  console.log("Preflight PASSED. Review docs/MAINNET_DEPLOYMENT.md, then yarn deploy:bsc.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

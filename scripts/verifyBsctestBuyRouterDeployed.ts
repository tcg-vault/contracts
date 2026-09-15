/**
 * Verify the **deployed** TCGVaultBuyRouter on BSC testnet (chapel) without touching current source.
 *
 * Swaps in `legacy/chapel/TCGVaultBuyRouter.deployed.sol` (commit cd4b6ed),
 * runs Hardhat verify, then restores `contracts/TCGVaultBuyRouter.sol`.
 *
 * Requires: BSC_SCAN_API_KEY, BSCTEST_RPC_URL (see .env.example)
 *
 * Usage:
 *   yarn verify:bsctest:buyrouter
 *
 * Optional env:
 *   BUY_ROUTER_ADDRESS — default 0x3d5c… (subgraph / deployBscTestnet)
 */

import hre from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Address } from "viem";

const DEFAULT_BUY_ROUTER = "0x3d5c49910f32ed78dc83141fabf1033d7b5e52e2" as Address;

const ROOT = resolve(import.meta.dirname, "..");
const ACTIVE_ROUTER = resolve(ROOT, "contracts/TCGVaultBuyRouter.sol");
const DEPLOYED_SNAPSHOT = resolve(ROOT, "legacy/chapel/TCGVaultBuyRouter.deployed.sol");

async function main() {
  const address = (process.env.BUY_ROUTER_ADDRESS?.trim() ?? DEFAULT_BUY_ROUTER) as Address;

  const { viem } = await hre.network.connect();
  const buyRouter = await viem.getContractAt("TCGVaultBuyRouter", address);
  const [pancakeRouter, usdc, tcgv, vault, marketing, community] = await Promise.all([
    buyRouter.read.router(),
    buyRouter.read.usdc(),
    buyRouter.read.tcgv(),
    buyRouter.read.vault(),
    buyRouter.read.marketing(),
    buyRouter.read.community(),
  ]);

  console.log("BuyRouter:", address);
  console.log("Constructor args (on-chain):");
  console.log({ pancakeRouter, usdc, tcgv, vault, marketing, community });

  const backup = readFileSync(ACTIVE_ROUTER, "utf8");
  const deployed = readFileSync(DEPLOYED_SNAPSHOT, "utf8").replaceAll(
    "../contracts/interfaces/",
    "./interfaces/",
  );

  try {
    writeFileSync(ACTIVE_ROUTER, deployed, "utf8");
    console.log("\nCompiling deployed snapshot (temporarily replaced active BuyRouter)…");
    const build = spawnSync("yarn", ["hardhat", "build"], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    if (build.status !== 0) {
      throw new Error("hardhat build failed");
    }

    const network = process.env.HARDHAT_NETWORK ?? "bsctest";
    const args = [pancakeRouter, usdc, tcgv, vault, marketing, community].map(String);
    console.log("\nSubmitting verification to BscScan / Sourcify…");
    const verify = spawnSync(
      "yarn",
      [
        "hardhat",
        "verify",
        "--network",
        network,
        "--contract",
        "contracts/TCGVaultBuyRouter.sol:TCGVaultBuyRouter",
        address,
        ...args,
      ],
      { cwd: ROOT, stdio: "inherit", env: process.env },
    );
    if (verify.status !== 0) {
      throw new Error("hardhat verify failed");
    }
  } finally {
    writeFileSync(ACTIVE_ROUTER, backup, "utf8");
    console.log("\nRestored active contracts/TCGVaultBuyRouter.sol");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Migrate mainnet fee / allocation recipients to current .env values.
 *
 * Diffs on-chain state vs .env and only executes needed steps:
 *   - Redeploy TCGVaultBuyRouter if vault/marketing/community immutables differ
 *   - token.setBuyRouter / staking.setBasicNFTPricingRouter / tcgr.setMinter / buyRouter.setReferralToken
 *   - token.setAddresses (pair fee recipients)
 *   - token.setAllocationRecipients (pre-finalize only)
 *   - founder.setCaspUsdcRecipient / launch.setTreasury (skipped if already matching)
 *
 * Does NOT redeploy TCGV / NEXUS / Founder / Launch / Staking / BasicNFT / Wrapper / TCGR / Converter.
 *
 * Required env: BSC wallet vars + TCG_KEY. Optional:
 *   TCGV_ADDRESS, BUY_ROUTER_ADDRESS, FOUNDER_NFT_ADDRESS, INITIAL_LAUNCH_ADDRESS,
 *   STAKING_VAULT_ADDRESS, TCGR_ADDRESS — default from .cache/last-bsc-mainnet-deploy-full.json
 *   DRY_RUN=1 — print plan only
 *   SKIP_VERIFY=1 — skip BscScan verify of new BuyRouter (default: verify + fail if verify fails)
 *   VERIFY_WAIT_SECONDS — delay before verify (default 30)
 *
 * Usage:
 *   DRY_RUN=1 yarn migrate:bsc-wallets
 *   yarn migrate:bsc-wallets
 */

import hre from "hardhat";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, type Address, type Hex } from "viem";
import {
  CHAIN_ID_BSC_MAINNET,
  connectBscLikeDeployNetwork,
  isAllowedBscDeployChainId,
} from "./connectBscLikeNetwork.js";

const PANCAKE_ROUTER_MAINNET = "0x10ED43C718714eb63d5aA57B78B54704E256024E" as Address;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_ROOT = join(__dirname, "..");
const DEPLOY_FULL = join(CONTRACTS_ROOT, ".cache", "last-bsc-mainnet-deploy-full.json");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Verify new BuyRouter on BscScan. Retries once. Throws unless SKIP_VERIFY=1. */
function verifyBuyRouterOnBscScan(
  address: Address,
  constructorArguments: readonly string[],
): void {
  if (process.env.SKIP_VERIFY === "1") {
    console.log("SKIP_VERIFY=1 — skipping BscScan verification of BuyRouter.");
    return;
  }

  const args = [
    "hardhat",
    "verify",
    "--network",
    "bsc",
    "--contract",
    "contracts/TCGVaultBuyRouter.sol:TCGVaultBuyRouter",
    address,
    ...constructorArguments,
  ];

  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`→ BscScan verify BuyRouter (attempt ${attempt}/${maxAttempts}):`, address);
    const proc = spawnSync("yarn", args, {
      cwd: CONTRACTS_ROOT,
      encoding: "utf8",
      env: process.env,
    });
    const out = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`.trim();
    if (out) console.log(out);

    const combined = out.toLowerCase();
    if (
      proc.status === 0 ||
      combined.includes("already verified") ||
      combined.includes("has already been verified")
    ) {
      console.log("  ✓ BuyRouter verified on BscScan:", `https://bscscan.com/address/${address}#code`);
      return;
    }

    if (attempt < maxAttempts) {
      console.warn("  verify failed, retrying in 45s...");
    } else {
      throw new Error(
        `BuyRouter verification failed after ${maxAttempts} attempts.\n${out || `exit ${proc.status}`}`,
      );
    }
  }
}

function reqAddr(name: string): Address {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name}`);
  return getAddress(v) as Address;
}

function eq(a: string, b: string): boolean {
  return getAddress(a) === getAddress(b);
}

function loadDeployCache(): Record<string, unknown> {
  if (!existsSync(DEPLOY_FULL)) {
    throw new Error(`Missing ${DEPLOY_FULL}. Set contract address env overrides explicitly.`);
  }
  return JSON.parse(readFileSync(DEPLOY_FULL, "utf8")) as Record<string, unknown>;
}

function cacheOrEnv(envName: string, cacheKey: string, cache: Record<string, unknown>): Address {
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return getAddress(fromEnv) as Address;
  const fromCache = cache[cacheKey];
  if (typeof fromCache !== "string" || !fromCache) {
    throw new Error(`Missing ${envName} and cache key ${cacheKey}`);
  }
  return getAddress(fromCache) as Address;
}

async function main() {
  const dryRun = process.env.DRY_RUN === "1";
  const { viem, publicClient, deployer, chainId } = await connectBscLikeDeployNetwork();
  if (!isAllowedBscDeployChainId(chainId) || chainId !== CHAIN_ID_BSC_MAINNET) {
    console.error(`Refusing migration: expected live BSC chainId 56, got ${chainId}`);
    process.exit(1);
  }

  const cache = loadDeployCache();
  const tokenAddress = cacheOrEnv("TCGV_ADDRESS", "tcgv", cache);
  const oldBuyRouterAddress = cacheOrEnv("BUY_ROUTER_ADDRESS", "buyRouter", cache);
  const founderAddress = cacheOrEnv("FOUNDER_NFT_ADDRESS", "founderNFT", cache);
  const launchAddress = cacheOrEnv("INITIAL_LAUNCH_ADDRESS", "initialLaunch", cache);
  const stakingAddress = cacheOrEnv("STAKING_VAULT_ADDRESS", "stakingVault", cache);
  const tcgrAddress = cacheOrEnv("TCGR_ADDRESS", "tcgr", cache);
  const usdcAddress = reqAddr("USDC_ADDRESS");

  const vault = reqAddr("VAULT_ADDRESS");
  const marketing = reqAddr("MARKETING_ADDRESS");
  const community = reqAddr("COMMUNITY_ADDRESS");
  const casp = reqAddr("CASP_USDC_ADDRESS");
  const treasury = reqAddr("TREASURY_ADDRESS");
  const liquidity = reqAddr("LIQUIDITY_RECIPIENT");
  const team = reqAddr("TEAM_RECIPIENT");
  const ops = reqAddr("OPS_RECIPIENT");

  const token = await viem.getContractAt("TCGVaultToken", tokenAddress, {
    client: { wallet: deployer, public: publicClient },
  });
  const founder = await viem.getContractAt("TCGVaultFounderNFT", founderAddress, {
    client: { wallet: deployer, public: publicClient },
  });
  const launch = await viem.getContractAt("TCGVaultInitialLaunch", launchAddress, {
    client: { wallet: deployer, public: publicClient },
  });
  const staking = await viem.getContractAt("TCGVaultStakingVault", stakingAddress, {
    client: { wallet: deployer, public: publicClient },
  });
  const oldBuyRouter = await viem.getContractAt("TCGVaultBuyRouter", oldBuyRouterAddress, {
    client: { wallet: deployer, public: publicClient },
  });
  const tcgr = await viem.getContractAt("TCGRToken", tcgrAddress, {
    client: { wallet: deployer, public: publicClient },
  });

  const supplyRecomputed = (await token.read.supplyRecomputed()) as boolean;
  const onVault = (await token.read.vaultAddress()) as Address;
  const onMarketing = (await token.read.marketingAddress()) as Address;
  const onCommunity = (await token.read.communityAddress()) as Address;
  const onLiquidity = (await token.read.liquidityRecipient()) as Address;
  const onTeam = (await token.read.teamRecipient()) as Address;
  const onOps = (await token.read.opsRecipient()) as Address;
  const onBuyRouter = (await token.read.buyRouter()) as Address;
  const onCasp = (await founder.read.caspUsdcRecipient()) as Address;
  const onTreasury = (await launch.read.treasury()) as Address;
  const onPricing = (await staking.read.basicNFTPricingRouter()) as Address;
  const brVault = (await oldBuyRouter.read.vault()) as Address;
  const brMarketing = (await oldBuyRouter.read.marketing()) as Address;
  const brCommunity = (await oldBuyRouter.read.community()) as Address;
  const brReferral = (await oldBuyRouter.read.referralToken()) as Address;
  const tcgrMinter = (await tcgr.read.minter()) as Address;

  const needSetAddresses =
    !eq(onVault, vault) || !eq(onMarketing, marketing) || !eq(onCommunity, community);
  const needAlloc =
    !eq(onLiquidity, liquidity) || !eq(onTeam, team) || !eq(onOps, ops);
  const needCasp = !eq(onCasp, casp);
  const needTreasury = !eq(onTreasury, treasury);
  const needBuyRouterRedeploy =
    !eq(brVault, vault) || !eq(brMarketing, marketing) || !eq(brCommunity, community);

  console.log("=".repeat(72));
  console.log(dryRun ? "Wallet migration DRY RUN (no txs)" : "Wallet migration — live BSC");
  console.log("=".repeat(72));
  console.log("Deployer:", deployer.account.address);
  console.log("TCGV:", tokenAddress);
  console.log("Old BuyRouter:", oldBuyRouterAddress);
  console.log("supplyRecomputed:", supplyRecomputed);
  console.log();
  console.log("Plan:");
  console.log("  setAddresses:            ", needSetAddresses);
  console.log("  setAllocationRecipients: ", needAlloc, supplyRecomputed ? "(BLOCKED: already finalized)" : "");
  console.log("  setCaspUsdcRecipient:    ", needCasp);
  console.log("  setTreasury:             ", needTreasury);
  console.log("  redeploy BuyRouter:      ", needBuyRouterRedeploy);
  if (needBuyRouterRedeploy) {
    console.log("    + setBuyRouter / setBasicNFTPricingRouter / setReferralToken / tcgr.setMinter");
    console.log(
      "    + BscScan verify new BuyRouter",
      process.env.SKIP_VERIFY === "1" ? "(SKIP_VERIFY=1)" : "(required)",
    );
  }
  console.log();

  if (needAlloc && supplyRecomputed) {
    throw new Error("Cannot safely change allocation recipients after supplyRecomputed/finalize.");
  }

  if (
    !needSetAddresses &&
    !needAlloc &&
    !needCasp &&
    !needTreasury &&
    !needBuyRouterRedeploy
  ) {
    console.log("Nothing to do — on-chain already matches .env.");
    return;
  }

  if (dryRun) {
    console.log("DRY_RUN=1 — exiting without sending transactions.");
    return;
  }

  async function wait(hash: Hex) {
    return publicClient.waitForTransactionReceipt({ hash, timeout: 300_000, pollingInterval: 4_000 });
  }

  if (needSetAddresses) {
    console.log("→ token.setAddresses");
    const h = await token.write.setAddresses([vault, marketing, community], {
      account: deployer.account,
    });
    await wait(h);
    console.log("  ✓", h);
  }

  if (needAlloc) {
    console.log("→ token.setAllocationRecipients");
    const h = await token.write.setAllocationRecipients([liquidity, team, ops], {
      account: deployer.account,
    });
    await wait(h);
    console.log("  ✓", h);
  }

  if (needCasp) {
    console.log("→ founder.setCaspUsdcRecipient");
    const h = await founder.write.setCaspUsdcRecipient([casp], { account: deployer.account });
    await wait(h);
    console.log("  ✓", h);
  }

  if (needTreasury) {
    console.log("→ launch.setTreasury");
    const h = await launch.write.setTreasury([treasury], { account: deployer.account });
    await wait(h);
    console.log("  ✓", h);
  }

  let newBuyRouterAddress = onBuyRouter;
  if (needBuyRouterRedeploy) {
    console.log("→ deploy TCGVaultBuyRouter");
    const artifact = await hre.artifacts.readArtifact("TCGVaultBuyRouter");
    const deployHash = await deployer.deployContract({
      abi: artifact.abi as never,
      bytecode: artifact.bytecode as Hex,
      args: [PANCAKE_ROUTER_MAINNET, usdcAddress, tokenAddress, vault, marketing, community] as never,
    });
    const receipt = await wait(deployHash);
    if (!receipt.contractAddress) throw new Error("BuyRouter deploy missing contractAddress");
    newBuyRouterAddress = getAddress(receipt.contractAddress) as Address;
    console.log("  ✓ new BuyRouter:", newBuyRouterAddress, deployHash);

    console.log("→ token.setBuyRouter");
    let h = await token.write.setBuyRouter([newBuyRouterAddress], { account: deployer.account });
    await wait(h);
    console.log("  ✓", h);

    console.log("→ staking.setBasicNFTPricingRouter");
    h = await staking.write.setBasicNFTPricingRouter([newBuyRouterAddress], {
      account: deployer.account,
    });
    await wait(h);
    console.log("  ✓", h);

    const newBuyRouter = await viem.getContractAt("TCGVaultBuyRouter", newBuyRouterAddress, {
      client: { wallet: deployer, public: publicClient },
    });
    const referral = eq(brReferral, "0x0000000000000000000000000000000000000000")
      ? tcgrAddress
      : getAddress(brReferral);
    console.log("→ newBuyRouter.setReferralToken", referral);
    h = await newBuyRouter.write.setReferralToken([referral], { account: deployer.account });
    await wait(h);
    console.log("  ✓", h);

    if (!eq(tcgrMinter, newBuyRouterAddress)) {
      console.log("→ tcgr.setMinter(newBuyRouter)  (was", tcgrMinter, ")");
      h = await tcgr.write.setMinter([newBuyRouterAddress], { account: deployer.account });
      await wait(h);
      console.log("  ✓", h);
    }

    // Keep old router fee-excluded if it already was; ensure new one is used via setBuyRouter.
    // Optionally exclude new router is automatic via setBuyRouter path on token.

    const waitSeconds = Number(process.env.VERIFY_WAIT_SECONDS ?? "30");
    if (process.env.SKIP_VERIFY !== "1" && waitSeconds > 0) {
      console.log(`→ waiting ${waitSeconds}s before BscScan verification...`);
      await sleep(waitSeconds * 1000);
    }
    verifyBuyRouterOnBscScan(newBuyRouterAddress, [
      PANCAKE_ROUTER_MAINNET,
      usdcAddress,
      tokenAddress,
      vault,
      marketing,
      community,
    ].map(String));

    // Update deploy cache buyRouter pointer
    const updated = {
      ...cache,
      buyRouter: newBuyRouterAddress,
      vault,
      marketing,
      community,
      caspUsdc: casp,
      treasury,
      liquidityRecipient: liquidity,
      teamRecipient: team,
      opsRecipient: ops,
      previousBuyRouter: oldBuyRouterAddress,
      walletMigrationAt: new Date().toISOString(),
    };
    writeFileSync(DEPLOY_FULL, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    console.log("Updated", DEPLOY_FULL);
  }

  console.log();
  console.log("Migration complete.");
  console.log("Active BuyRouter:", newBuyRouterAddress);
  if (!eq(onPricing, newBuyRouterAddress) && needBuyRouterRedeploy) {
    console.log("Frontend / subgraph should point BuyRouter to the new address.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

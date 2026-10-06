import hre from "hardhat";
import { formatEther, getContractAddress, type Address, zeroAddress } from "viem";
import { execSync } from "node:child_process";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type VerifyJob = {
  address: Address;
  constructorArguments: readonly unknown[];
  contract?: string;
};

async function verifyOne(
  address: Address,
  constructorArguments: readonly unknown[],
  contract?: string,
): Promise<void> {
  try {
    const network = process.env.HARDHAT_NETWORK ?? "bsc";
    const args = constructorArguments.map((v) => String(v));
    const cmd = [
      "yarn hardhat verify etherscan",
      `--network ${network}`,
      ...(contract ? [`--contract "${contract}"`] : []),
      address,
      ...args,
    ].join(" ");
    execSync(cmd, { stdio: "pipe" });
    console.log(`Verified on BscScan: ${address}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes("already verified")) {
      console.log(`Already verified: ${address}`);
      return;
    }
    console.warn(`Verification failed for ${address}: ${msg}`);
  }
}

async function runQueuedVerifications(jobs: VerifyJob[]): Promise<void> {
  if (jobs.length === 0) return;
  const waitSeconds = Number(process.env.VERIFY_WAIT_SECONDS ?? "30");
  if (waitSeconds > 0) {
    console.log(`\nWaiting ${waitSeconds}s before verification batch...`);
    await sleep(waitSeconds * 1000);
  }
  console.log(`Starting verification for ${jobs.length} contracts...`);
  for (const job of jobs) {
    await verifyOne(job.address, job.constructorArguments, job.contract);
  }
}

/**
 * LEGACY / PARTIAL deployment — NEXUS + TCGV + BuyRouter only.
 *
 * For BSC mainnet full stack (Founder NFT, InitialLaunch, staking, LiquidityWrapper, TCGR),
 * use `yarn deploy:bsc` → scripts/deployBscMainnet.ts (see docs/MAINNET_DEPLOYMENT.md).
 * This script remains as `yarn deploy:bsc:legacy-partial` for non-mainnet / partial wiring.
 *
 * Initial allocation (whitepaper §5): 60% Presale, 20% Liquidité, 4% Vesting & Équipe,
 * 5% Opérationnel & Marketing (immédiat), 11% Opérationnel & Marketing (vesting).
 * Post-deploy: wire presale (InitialLaunch or deploy script order) per whitepaper §5–§6.
 *
 * NEXUS cashback (whitepaper §6): `initialLaunch` is immutable in `TCGVaultToken` constructor — `PRESALE_FINALIZER` must be the `TCGVaultInitialLaunch` address that will call `finalizePresaleAndRecompute()`.
 *
 * Usage:
 *   yarn hardhat run scripts/deployTCGVault.ts --network <network>
 *
 * Environment variables needed:
 *   - PANCAKE_ROUTER: PancakeSwap router address (required)
 *   - VAULT_ADDRESS: Vault address for fee collection (required)
 *   - MARKETING_ADDRESS: Marketing address (required)
 *   - COMMUNITY_ADDRESS: Community rewards address (required)
 *   - STABLECOIN_ADDRESS: Stablecoin address (USDT/USDC). Required on chainId 56 (MockUSDC refused).
 *   - PRESALE_FINALIZER: TCGVaultInitialLaunch address (immutable `initialLaunch`; mintPresale / finalize / burnPresaleAllocation) (required)
 *   - NEXUS_PRESALE_BONUS_FOUNDER_NFT, NEXUS_PRESALE_BONUS_INITIAL_LAUNCH: Immutable NEXUS presale bonus contracts (CREATE-predicted addresses) (required)
 *   - MOCK_USDC_MINT_DEPLOYER=0: if deploying MockUSDC, skip minting 1M USDC to deployer
 */

async function main() {
  const { viem } = await hre.network.connect();
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const verifyJobs: VerifyJob[] = [];

  console.log("Deploying contracts with account:", deployer.account.address);
  console.log("Account balance:", formatEther(await publicClient.getBalance({ address: deployer.account.address })));

  // Required address env vars: no fallback to avoid deploying with wrong recipients.
  const pancakeRouter = process.env.PANCAKE_ROUTER?.trim() as `0x${string}` | undefined;
  if (!pancakeRouter) {
    console.error("Missing PANCAKE_ROUTER env var. Refusing to deploy.");
    return;
  }
  const vaultAddress = process.env.VAULT_ADDRESS?.trim() as `0x${string}` | undefined;
  if (!vaultAddress) {
    console.error("Missing VAULT_ADDRESS env var. Refusing to deploy.");
    return;
  }
  const marketingAddress = process.env.MARKETING_ADDRESS?.trim() as `0x${string}` | undefined;
  if (!marketingAddress) {
    console.error("Missing MARKETING_ADDRESS env var. Refusing to deploy.");
    return;
  }
  const communityAddress = process.env.COMMUNITY_ADDRESS?.trim() as `0x${string}` | undefined;
  if (!communityAddress) {
    console.error("Missing COMMUNITY_ADDRESS env var. Refusing to deploy.");
    return;
  }
  let stablecoinAddress = process.env.STABLECOIN_ADDRESS as Address | undefined;
  const initialLaunchAddress = process.env.PRESALE_FINALIZER?.trim() as `0x${string}` | undefined;
  if (!initialLaunchAddress) {
    console.error("Missing PRESALE_FINALIZER env var (TCGVaultInitialLaunch address). Refusing to deploy.");
    return;
  }
  const nexusPresaleFounder = process.env.NEXUS_PRESALE_BONUS_FOUNDER_NFT?.trim() as Address | undefined;
  const nexusPresaleLaunch = process.env.NEXUS_PRESALE_BONUS_INITIAL_LAUNCH?.trim() as Address | undefined;
  if (!nexusPresaleFounder || !nexusPresaleLaunch) {
    console.error(
      "Missing NEXUS_PRESALE_BONUS_FOUNDER_NFT or NEXUS_PRESALE_BONUS_INITIAL_LAUNCH. Refusing to deploy (required for immutable NEXUS presale bonus minters).",
    );
    return;
  }
  const chainId = await publicClient.getChainId();
  if (!stablecoinAddress) {
    if (chainId === 56) {
      console.error(
        "Missing STABLECOIN_ADDRESS on BSC mainnet. MockUSDC is refused. Use yarn deploy:bsc (deployBscMainnet.ts) instead.",
      );
      process.exit(1);
    }
    console.log("\n0. Deploying MockUSDC (no STABLECOIN_ADDRESS provided)...");
    const mockUsdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
      client: { wallet: deployer },
    });
    stablecoinAddress = mockUsdc.address as Address;
    console.log("MockUSDC deployed to:", stablecoinAddress);
    if (process.env.MOCK_USDC_MINT_DEPLOYER !== "0") {
      const usdc = await viem.getContractAt("contracts/test/MockUSDC.sol:MockUSDC", stablecoinAddress);
      const mintAmount = 1_000_000n * 1_000_000n; // 1M USDC (6 decimals)
      const mintHash = await usdc.write.mint([deployer.account.address, mintAmount], { account: deployer.account });
      await publicClient.waitForTransactionReceipt({ hash: mintHash });
      console.log("Minted 1,000,000 MockUSDC to deployer.");
    }
    verifyJobs.push({
      address: stablecoinAddress,
      constructorArguments: [],
      contract: "contracts/test/MockUSDC.sol:MockUSDC",
    });
  } else {
    console.log("Using STABLECOIN_ADDRESS:", stablecoinAddress);
  }

  // Deploy TCGNexusToken first (minter = predicted TCGV), then TCGVaultToken with immutable NEXUS + initialLaunch
  let nonce = BigInt(
    await publicClient.getTransactionCount({ address: deployer.account.address, blockTag: "pending" })
  );
  const futureTcgvAddress = getContractAddress({ from: deployer.account.address, nonce: nonce + 1n });
  const nexusTokenAddress = getContractAddress({ from: deployer.account.address, nonce });

  console.log("\n1. Deploying TCGNexus Token (minter = predicted TCGV; immutable presale bonus minters from env)...");
  await viem.deployContract("TCGNexusToken", [futureTcgvAddress, nexusPresaleFounder, nexusPresaleLaunch], {
    client: { wallet: deployer },
  });
  nonce += 1n;
  console.log("TCGNexus Token deployed to:", nexusTokenAddress);
  verifyJobs.push({
    address: nexusTokenAddress,
    constructorArguments: [futureTcgvAddress, nexusPresaleFounder, nexusPresaleLaunch],
    contract: "contracts/TCGNexusToken.sol:TCGNexusToken",
  });

  console.log("\n2. Deploying TCGVaultToken (NEXUS immutable from constructor)...");
  await viem.deployContract("TCGVaultToken", [
    zeroAddress,
    pancakeRouter,
    vaultAddress,
    marketingAddress,
    communityAddress,
    nexusTokenAddress,
    initialLaunchAddress,
  ], { client: { wallet: deployer } });
  const tokenAddress = getContractAddress({ from: deployer.account.address, nonce });
  nonce += 1n;
  const token = await viem.getContractAt("TCGVaultToken", tokenAddress);
  console.log("TCGVaultToken deployed to:", tokenAddress);
  verifyJobs.push({
    address: tokenAddress,
    constructorArguments: [
      zeroAddress,
      pancakeRouter,
      vaultAddress,
      marketingAddress,
      communityAddress,
      nexusTokenAddress,
      initialLaunchAddress,
    ],
    contract: "contracts/TCGVaultToken.sol:TCGVaultToken",
  });

  // Deploy TCGVaultBuyRouter
  console.log("\n3. Deploying TCGVaultBuyRouter...");
  await viem.deployContract("TCGVaultBuyRouter", [
    pancakeRouter,
    stablecoinAddress,
    tokenAddress,
    vaultAddress,
    marketingAddress,
    communityAddress,
  ], { client: { wallet: deployer } });
  const buyRouterAddress = getContractAddress({ from: deployer.account.address, nonce });
  nonce += 1n;
  const buyRouter = await viem.getContractAt("TCGVaultBuyRouter", buyRouterAddress);
  console.log("TCGVaultBuyRouter deployed to:", buyRouterAddress);
  verifyJobs.push({
    address: buyRouterAddress,
    constructorArguments: [
      pancakeRouter,
      stablecoinAddress,
      tokenAddress,
      vaultAddress,
      marketingAddress,
      communityAddress,
    ],
    contract: "contracts/TCGVaultBuyRouter.sol:TCGVaultBuyRouter",
  });

  // Set buy router on token
  console.log("\n4. Setting buy router on TCGVaultToken...");
  const setRouterHash = await token.write.setBuyRouter([buyRouterAddress], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: setRouterHash });
  console.log("Buy router set successfully");

  console.log("\n=== Deployment Summary ===");
  console.log("TCGVaultToken:", tokenAddress);
  console.log("TCGNexus Token:", nexusTokenAddress);
  console.log("TCGVaultBuyRouter:", buyRouterAddress);
  console.log("PancakeSwap Router:", pancakeRouter);
  console.log("Stablecoin:", stablecoinAddress);
  console.log("Vault Address:", vaultAddress);
  console.log("Marketing Address:", marketingAddress);
  console.log("Community Address:", communityAddress);
  await runQueuedVerifications(verifyJobs);

  console.log("\n=== Next Steps ===");
  console.log("1. Add liquidity to PancakeSwap");
  console.log("2. Call token.setPair(pairAddress, true) to register the pair");
  console.log("3. Verify all addresses are correct");
  console.log("4. Test buy/sell transactions");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

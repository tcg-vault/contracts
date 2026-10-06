/**
 * BSC Mainnet (chainId 56) — full TCG Vault stack with PancakeSwap V2 mainnet.
 *
 * Core addresses (official Pancake docs):
 *   Factory: 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73
 *   Router:  0x10ED43C718714eb63d5aA57B78B54704E256024E
 *
 * Stablecoin:
 *   USDC_ADDRESS is required. MockUSDC is refused on chainId 56.
 *   Default Binance-Peg USDC: 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d (confirm decimals() on-chain).
 *
 * Prerequisites (Hardhat 3 keystore / env per hardhat.config.ts):
 *   - Network `bsc` with BSC_RPC_URL and TCG_KEY configured.
 *
 * Required env (see contracts/docs/WALLET_ADDRESSES.md — FR/EN labels vs .env):
 *   - VAULT_ADDRESS, MARKETING_ADDRESS, COMMUNITY_ADDRESS — fee recipients
 *   - CASP_USDC_ADDRESS — MiCA CASP sink for FounderNFT mint() (100% of paid USDC)
 *   - TREASURY_ADDRESS — InitialLaunch.buy() USDC sink (often same as CASP)
 *   - LIQUIDITY_RECIPIENT, TEAM_RECIPIENT, OPS_RECIPIENT — post-presale allocation recipients
 *   - USDC_ADDRESS — real BEP-20 stablecoin (no MockUSDC on mainnet)
 *
 * Optional env:
 *   - SKIP_TCGR=1 — do not deploy TCGR + converter
 *   - SKIP_SUBGRAPH_SYNC=1 — after deploy, skip `yarn update:subgraph:abis` + subgraph `yarn sync:pipeline`
 *   - SKIP_VERIFY=1 — skip BscScan verification batch
 *   - BASIC_NFT_MIN_STAKE — min stake as decimal TCGV string (parseEther; default: `5000`)
 *   - DEPLOY_RECEIPT_TIMEOUT_MS / DEPLOY_RECEIPT_POLL_MS / DEPLOY_RECEIPT_MAX_ATTEMPTS
 *   - DEPLOY_RETRY_GAS_LIMIT — fallback gas when RPC estimation fails (default: 3000000)
 *   - VERIFY_WAIT_SECONDS — delay before verification batch (default: 30)
 *
 * Post-deploy: see docs/MAINNET_DEPLOYMENT.md
 *
 * Usage:
 *   yarn deploy:bsc
 *   SKIP_VERIFY=1 SKIP_SUBGRAPH_SYNC=1 yarn deploy:bsc:tenderly   # Virtual TestNet rehearsal
 */

import hre from "hardhat";
import { formatEther, getContractAddress, parseEther, type Address, zeroAddress } from "viem";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAIN_ID_BSC_MAINNET,
  connectBscLikeDeployNetwork,
  isAllowedBscDeployChainId,
  tenderlyVirtualChainId,
} from "./connectBscLikeNetwork.js";

/** PancakeSwap V2 on BSC mainnet (docs). */
const PANCAKE_FACTORY_MAINNET = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73" as Address;
const PANCAKE_ROUTER_MAINNET = "0x10ED43C718714eb63d5aA57B78B54704E256024E" as Address;

/** Binance-Peg USDC (BEP-20) — confirm decimals() before go-live. */
const DEFAULT_BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Address;

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_ROOT = join(__dirname, "..");
const SUBGRAPH_DEPLOY_CACHE = join(CONTRACTS_ROOT, ".cache", "last-bsc-mainnet-deploy.json");

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
      "yarn hardhat verify",
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

function readRequiredAddress(name: string): Address | undefined {
  const v = process.env[name]?.trim();
  if (!v) return undefined;
  return v as Address;
}

function runSubgraphSyncAfterDeploy(deployJsonPath: string): void {
  console.log("\n--- Subgraph + Turbo sync ---");
  const subgraphRoot = join(CONTRACTS_ROOT, "..", "subgraph");
  const r1 = spawnSync("yarn", ["update:subgraph:abis"], {
    cwd: CONTRACTS_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (r1.status !== 0) {
    process.exit(r1.status ?? 1);
  }
  const r2 = spawnSync("yarn", ["sync:pipeline"], {
    cwd: subgraphRoot,
    stdio: "inherit",
    env: { ...process.env, DEPLOY_JSON: deployJsonPath },
  });
  if (r2.status !== 0) {
    process.exit(r2.status ?? 1);
  }
}

async function main() {
  const { viem, publicClient, deployer, chainId, isTenderlyVirtual } =
    await connectBscLikeDeployNetwork();
  const deploymentBlocks: bigint[] = [];
  const contractClient = { wallet: deployer, public: publicClient };

  if (!isAllowedBscDeployChainId(chainId)) {
    console.error(
      `Refusing to deploy: expected chainId ${CHAIN_ID_BSC_MAINNET.toString()} (live BSC) or ${tenderlyVirtualChainId().toString()} (Tenderly Virtual), got ${chainId}.`,
    );
    process.exit(1);
  }
  if (isTenderlyVirtual) {
    console.log(
      `\n⚠ Tenderly Virtual TestNet (chainId ${chainId}) — rehearsal only, NOT production mainnet.\n`,
    );
  }

  const receiptTimeoutMs = Number(process.env.DEPLOY_RECEIPT_TIMEOUT_MS ?? 300_000);
  const receiptPollMs = Number(process.env.DEPLOY_RECEIPT_POLL_MS ?? 4_000);
  const receiptMaxAttempts = Math.max(1, Number(process.env.DEPLOY_RECEIPT_MAX_ATTEMPTS ?? 5));
  const deployRetryGasLimit = BigInt(process.env.DEPLOY_RETRY_GAS_LIMIT?.trim() ?? "3000000");

  async function waitForTxReceipt(hash: `0x${string}`) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= receiptMaxAttempts; attempt++) {
      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: receiptTimeoutMs,
          pollingInterval: receiptPollMs,
        });
        return receipt;
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        const missing =
          msg.includes("could not be found") ||
          msg.includes("not be processed") ||
          msg.includes("ReceiptNotFound");
        if (!missing || attempt === receiptMaxAttempts) {
          throw e;
        }
        const backoff = Math.min(30_000, 5_000 * attempt);
        console.warn(
          `[deploy] Receipt not ready for ${hash.slice(0, 18)}… (${msg.slice(0, 100)}). Retry ${attempt}/${receiptMaxAttempts} in ${backoff}ms`,
        );
        await sleep(backoff);
      }
    }
    throw lastError;
  }

  async function deployTracked(
    contractName: string,
    constructorArgs: readonly unknown[] = [],
    deployConfig: { client?: { wallet: typeof deployer } } = {},
  ): Promise<{ address: Address }> {
    const artifact = await hre.artifacts.readArtifact(contractName);
    const wallet = deployConfig.client?.wallet ?? deployer;
    let deploymentTxHash: `0x${string}`;
    try {
      deploymentTxHash = await wallet.deployContract({
        abi: artifact.abi as never,
        bytecode: artifact.bytecode as `0x${string}`,
        args: constructorArgs as never,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isGasEstimationFailure =
        msg.includes("out of gas") ||
        msg.includes("gas required exceeds") ||
        msg.includes("Transaction creation failed");
      if (!isGasEstimationFailure) {
        throw e;
      }
      console.warn(
        `[deploy] ${contractName} failed during automatic gas estimation. Retrying with explicit gas=${deployRetryGasLimit.toString()}...`,
      );
      deploymentTxHash = await wallet.deployContract({
        abi: artifact.abi as never,
        bytecode: artifact.bytecode as `0x${string}`,
        args: constructorArgs as never,
        gas: deployRetryGasLimit,
      });
    }
    const receipt = await waitForTxReceipt(deploymentTxHash);
    if (!receipt.contractAddress) {
      throw new Error(`Deployment receipt missing contractAddress for ${contractName} (${deploymentTxHash}).`);
    }
    deploymentBlocks.push(receipt.blockNumber);
    return { address: receipt.contractAddress as Address };
  }

  const deployerAddr = deployer.account.address as Address;
  const vaultAddr = readRequiredAddress("VAULT_ADDRESS");
  const marketingAddr = readRequiredAddress("MARKETING_ADDRESS");
  const communityAddr = readRequiredAddress("COMMUNITY_ADDRESS");
  const caspUsdcAddr = readRequiredAddress("CASP_USDC_ADDRESS");
  const treasuryAddr = readRequiredAddress("TREASURY_ADDRESS");
  const liquidityRecipient = readRequiredAddress("LIQUIDITY_RECIPIENT");
  const teamRecipient = readRequiredAddress("TEAM_RECIPIENT");
  const opsRecipient = readRequiredAddress("OPS_RECIPIENT");
  const usdcAddress = readRequiredAddress("USDC_ADDRESS");

  if (
    !vaultAddr ||
    !marketingAddr ||
    !communityAddr ||
    !caspUsdcAddr ||
    !treasuryAddr ||
    !liquidityRecipient ||
    !teamRecipient ||
    !opsRecipient ||
    !usdcAddress
  ) {
    console.error(
      "Missing one or more required address env vars: VAULT_ADDRESS, MARKETING_ADDRESS, COMMUNITY_ADDRESS, CASP_USDC_ADDRESS, TREASURY_ADDRESS, LIQUIDITY_RECIPIENT, TEAM_RECIPIENT, OPS_RECIPIENT, USDC_ADDRESS. Refusing to deploy.",
    );
    console.error(
      `Hint: Binance-Peg USDC on BSC is commonly ${DEFAULT_BSC_USDC} — set USDC_ADDRESS explicitly after confirming decimals().`,
    );
    process.exit(1);
  }

  const usdcCode = await publicClient.getCode({ address: usdcAddress });
  if (!usdcCode || usdcCode === "0x") {
    console.error(`USDC_ADDRESS has no code at ${usdcAddress}. Refusing to deploy.`);
    process.exit(1);
  }

  let usdcDecimals: number;
  let usdcSymbol = "?";
  try {
    usdcDecimals = Number(
      await publicClient.readContract({
        address: usdcAddress,
        abi: IERC20_METADATA_ABI,
        functionName: "decimals",
      }),
    );
    usdcSymbol = (await publicClient.readContract({
      address: usdcAddress,
      abi: IERC20_METADATA_ABI,
      functionName: "symbol",
    })) as string;
  } catch (e) {
    console.error(`Failed to read decimals()/symbol() on USDC_ADDRESS ${usdcAddress}:`, e);
    process.exit(1);
  }

  console.log("=".repeat(72));
  console.log(
    isTenderlyVirtual
      ? `BSC Tenderly Virtual deploy — chainId ${chainId}`
      : `BSC Mainnet deploy — chainId ${chainId}`,
  );
  console.log("=".repeat(72));
  console.log("Deployer:     ", deployerAddr);
  console.log("Native bal:   ", formatEther(await publicClient.getBalance({ address: deployerAddr })));
  console.log("Vault (fees): ", vaultAddr);
  console.log("Marketing:    ", marketingAddr);
  console.log("Community:    ", communityAddr);
  console.log("CASP USDC:    ", caspUsdcAddr, "(Founder NFT: 100% of paid USDC)");
  console.log("Treasury:     ", treasuryAddr, "(InitialLaunch.buy USDC sink)");
  console.log("USDC:         ", usdcAddress, `(${usdcSymbol}, ${usdcDecimals} decimals)`);
  console.log("Pancake factory:", PANCAKE_FACTORY_MAINNET);
  console.log("Pancake router: ", PANCAKE_ROUTER_MAINNET);
  console.log();
  console.log("MockUSDC is disabled on mainnet.");
  console.log();

  const verifyJobs: VerifyJob[] = [];

  let nonce = BigInt(
    await publicClient.getTransactionCount({ address: deployerAddr, blockTag: "pending" }),
  );

  const nexusTokenAddress = getContractAddress({ from: deployerAddr, nonce }) as Address;
  const tokenAddress = getContractAddress({ from: deployerAddr, nonce: nonce + 1n }) as Address;
  const founderNFTAddress = getContractAddress({ from: deployerAddr, nonce: nonce + 2n }) as Address;
  const initialLaunchAddress = getContractAddress({ from: deployerAddr, nonce: nonce + 3n }) as Address;

  console.log("--- Core (CREATE nonce prediction) ---");
  console.log("Predicted NEXUS:         ", nexusTokenAddress);
  console.log("Predicted TCGV:          ", tokenAddress);
  console.log("Predicted FounderNFT:    ", founderNFTAddress);
  console.log("Predicted InitialLaunch: ", initialLaunchAddress);
  console.log();

  await deployTracked("contracts/TCGNexusToken.sol:TCGNexusToken", [tokenAddress, founderNFTAddress, initialLaunchAddress], {
    client: { wallet: deployer },
  });
  nonce += 1n;
  console.log("TCGNexusToken:", nexusTokenAddress);
  verifyJobs.push({
    address: nexusTokenAddress,
    constructorArguments: [tokenAddress, founderNFTAddress, initialLaunchAddress],
    contract: "contracts/TCGNexusToken.sol:TCGNexusToken",
  });

  await deployTracked(
    "TCGVaultToken",
    [
      zeroAddress,
      PANCAKE_ROUTER_MAINNET,
      vaultAddr,
      marketingAddr,
      communityAddr,
      nexusTokenAddress,
      initialLaunchAddress,
    ],
    { client: { wallet: deployer } },
  );
  nonce += 1n;
  console.log("TCGVaultToken:", tokenAddress);
  verifyJobs.push({
    address: tokenAddress,
    constructorArguments: [
      zeroAddress,
      PANCAKE_ROUTER_MAINNET,
      vaultAddr,
      marketingAddr,
      communityAddr,
      nexusTokenAddress,
      initialLaunchAddress,
    ],
    contract: "contracts/TCGVaultToken.sol:TCGVaultToken",
  });

  await deployTracked(
    "TCGVaultFounderNFT",
    [usdcAddress, nexusTokenAddress, caspUsdcAddr],
    {
      client: { wallet: deployer },
    },
  );
  nonce += 1n;
  console.log("TCGVaultFounderNFT:", founderNFTAddress);
  verifyJobs.push({
    address: founderNFTAddress,
    constructorArguments: [usdcAddress, nexusTokenAddress, caspUsdcAddr],
    contract: "contracts/TCGVaultFounderNFT.sol:TCGVaultFounderNFT",
  });

  await deployTracked(
    "TCGVaultInitialLaunch",
    [tokenAddress, usdcAddress, founderNFTAddress, nexusTokenAddress, treasuryAddr],
    { client: { wallet: deployer } },
  );
  nonce += 1n;
  console.log("TCGVaultInitialLaunch:", initialLaunchAddress);
  verifyJobs.push({
    address: initialLaunchAddress,
    constructorArguments: [
      tokenAddress,
      usdcAddress,
      founderNFTAddress,
      nexusTokenAddress,
      treasuryAddr,
    ],
    contract: "contracts/TCGVaultInitialLaunch.sol:TCGVaultInitialLaunch",
  });

  const token = await viem.getContractAt("TCGVaultToken", tokenAddress, {
    client: contractClient,
  });
  let h: `0x${string}`;

  console.log("--- Allocation recipients (pre-presale finalize) ---");
  console.log("Liquidity recipient:", liquidityRecipient);
  console.log("Team recipient:     ", teamRecipient);
  console.log("Ops recipient:      ", opsRecipient);

  const setAllocHash = await token.write.setAllocationRecipients(
    [liquidityRecipient, teamRecipient, opsRecipient],
    { account: deployer.account },
  );
  await waitForTxReceipt(setAllocHash);
  console.log("token.setAllocationRecipients ✓");

  console.log("Nexus presale bonus minters (immutable): FounderNFT + InitialLaunch");
  console.log();

  console.log("--- Staking vault + Basic NFT (ERC-4626 + soulbound gate) ---");
  const stakingVault = await deployTracked("TCGVaultStakingVault", [tokenAddress], {
    client: { wallet: deployer },
  });
  const stakingVaultAddress = stakingVault.address as Address;
  console.log("TCGVaultStakingVault:", stakingVaultAddress);
  verifyJobs.push({
    address: stakingVaultAddress,
    constructorArguments: [tokenAddress],
    contract: "contracts/TCGVaultStakingVault.sol:TCGVaultStakingVault",
  });

  const basicNFT = await deployTracked("TCGVaultBasicNFT", [stakingVaultAddress], {
    client: { wallet: deployer },
  });
  const basicNFTAddress = basicNFT.address as Address;
  console.log("TCGVaultBasicNFT:", basicNFTAddress);
  verifyJobs.push({
    address: basicNFTAddress,
    constructorArguments: [stakingVaultAddress],
    contract: "contracts/TCGVaultBasicNFT.sol:TCGVaultBasicNFT",
  });

  const minStakeForBasic = process.env.BASIC_NFT_MIN_STAKE?.trim()
    ? parseEther(process.env.BASIC_NFT_MIN_STAKE.trim())
    : parseEther("5000");
  const stakingVaultContract = await viem.getContractAt("TCGVaultStakingVault", stakingVaultAddress, {
    client: contractClient,
  });
  h = await stakingVaultContract.write.setRequiredStakeForBasicNFT([minStakeForBasic], { account: deployer.account });
  await waitForTxReceipt(h);
  h = await stakingVaultContract.write.setBasicNFTContract([basicNFTAddress], { account: deployer.account });
  await waitForTxReceipt(h);
  console.log(
    "stakingVault.setRequiredStakeForBasicNFT / setBasicNFTContract ✓ (required shares:",
    minStakeForBasic.toString(),
    ")",
  );

  h = await token.write.setExcludedFromFees([stakingVaultAddress, true], { account: deployer.account });
  await waitForTxReceipt(h);
  console.log("token.setExcludedFromFees(stakingVault) ✓ (deposits are full-amount)");
  console.log();

  console.log("--- BuyRouter + Liquidity wrapper ---");
  const buyRouter = await deployTracked(
    "TCGVaultBuyRouter",
    [
      PANCAKE_ROUTER_MAINNET,
      usdcAddress,
      tokenAddress,
      vaultAddr,
      marketingAddr,
      communityAddr,
    ],
    { client: { wallet: deployer } },
  );
  const buyRouterAddress = buyRouter.address as Address;
  console.log("TCGVaultBuyRouter:", buyRouterAddress);
  verifyJobs.push({
    address: buyRouterAddress,
    constructorArguments: [
      PANCAKE_ROUTER_MAINNET,
      usdcAddress,
      tokenAddress,
      vaultAddr,
      marketingAddr,
      communityAddr,
    ],
    contract: "contracts/TCGVaultBuyRouter.sol:TCGVaultBuyRouter",
  });

  h = await token.write.setBuyRouter([buyRouterAddress], { account: deployer.account });
  await waitForTxReceipt(h);
  console.log("token.setBuyRouter ✓");

  h = await stakingVaultContract.write.setBasicNFTPricingRouter([buyRouterAddress], { account: deployer.account });
  await waitForTxReceipt(h);
  console.log("stakingVault.setBasicNFTPricingRouter(buyRouter) ✓ (dynamic ~25 USDC threshold)");

  const wrapper = await deployTracked(
    "contracts/TCGVaultLiquidityWrapper.sol:TCGVaultLiquidityWrapper",
    [tokenAddress, PANCAKE_ROUTER_MAINNET],
    { client: { wallet: deployer } },
  );
  const wrapperAddress = wrapper.address as Address;
  console.log("TCGVaultLiquidityWrapper:", wrapperAddress);
  verifyJobs.push({
    address: wrapperAddress,
    constructorArguments: [tokenAddress, PANCAKE_ROUTER_MAINNET],
    contract: "contracts/TCGVaultLiquidityWrapper.sol:TCGVaultLiquidityWrapper",
  });

  h = await token.write.setExcludedFromFees([wrapperAddress, true], { account: deployer.account });
  await waitForTxReceipt(h);
  console.log("token.setExcludedFromFees(wrapper) ✓");
  console.log();

  let tcgrAddress: Address | undefined;
  let converterAddress: Address | undefined;
  if (process.env.SKIP_TCGR !== "1") {
    console.log("--- TCGR + converter (1:1) ---");
    const tcgr = await deployTracked("TCGRToken", [buyRouterAddress, usdcAddress], { client: { wallet: deployer } });
    tcgrAddress = tcgr.address as Address;
    verifyJobs.push({
      address: tcgrAddress,
      constructorArguments: [buyRouterAddress, usdcAddress],
      contract: "contracts/TCGRToken.sol:TCGRToken",
    });
    const buyRouterContract = await viem.getContractAt("TCGVaultBuyRouter", buyRouterAddress, {
      client: contractClient,
    });
    h = await buyRouterContract.write.setReferralToken([tcgrAddress], { account: deployer.account });
    await waitForTxReceipt(h);

    const converter = await deployTracked(
      "TCGRToTCGVConverter",
      [tcgrAddress, tokenAddress, parseEther("1")],
      { client: { wallet: deployer } },
    );
    converterAddress = converter.address as Address;
    verifyJobs.push({
      address: converterAddress,
      constructorArguments: [tcgrAddress, tokenAddress, parseEther("1")],
      contract: "contracts/TCGRToTCGVConverter.sol:TCGRToTCGVConverter",
    });
    const tcgrC = await viem.getContractAt("TCGRToken", tcgrAddress, {
      client: contractClient,
    });
    h = await tcgrC.write.setConverter([converterAddress], { account: deployer.account });
    await waitForTxReceipt(h);
    console.log("TCGRToken:", tcgrAddress);
    console.log("TCGRToTCGVConverter:", converterAddress, "(fund converter with TCGV before convert)");
    console.log();
  }

  const startBlock = Number(deploymentBlocks.reduce((a, b) => (a < b ? a : b)));
  const lowerAddr = (a: Address) => a.toLowerCase() as Address;

  const out = {
    chainId: Number(chainId),
    network: isTenderlyVirtual ? "tenderly-virtual-bsc" : "bsc",
    pancakeFactory: PANCAKE_FACTORY_MAINNET,
    pancakeRouter: PANCAKE_ROUTER_MAINNET,
    usdc: usdcAddress,
    usdcSymbol,
    usdcDecimals,
    usdcIsMock: false,
    tcgv: tokenAddress,
    nexus: nexusTokenAddress,
    founderNFT: founderNFTAddress,
    initialLaunch: initialLaunchAddress,
    stakingVault: stakingVaultAddress,
    basicNFT: basicNFTAddress,
    basicNftMinStakeWei: minStakeForBasic.toString(),
    buyRouter: buyRouterAddress,
    liquidityWrapper: wrapperAddress,
    vault: vaultAddr,
    marketing: marketingAddr,
    community: communityAddr,
    caspUsdc: caspUsdcAddr,
    treasury: treasuryAddr,
    liquidityRecipient,
    teamRecipient,
    opsRecipient,
    tcgr: tcgrAddress ?? null,
    tcgrConverter: converterAddress ?? null,
    startBlock,
  };

  const deployJsonForSubgraph = {
    chainId: Number(chainId),
    startBlock,
    skipTcgr: process.env.SKIP_TCGR === "1",
    addresses: {
      tcgv: lowerAddr(tokenAddress),
      nexus: lowerAddr(nexusTokenAddress),
      buyRouter: lowerAddr(buyRouterAddress),
      stakingVault: lowerAddr(stakingVaultAddress),
      basicNFT: lowerAddr(basicNFTAddress),
      founderNFT: lowerAddr(founderNFTAddress),
      initialLaunch: lowerAddr(initialLaunchAddress),
      liquidityWrapper: lowerAddr(wrapperAddress),
      tcgr: tcgrAddress ? lowerAddr(tcgrAddress) : null,
      tcgrConverter: converterAddress ? lowerAddr(converterAddress) : null,
    },
  };

  console.log("=".repeat(72));
  console.log("Deployment JSON (save for frontend / ops)");
  console.log("=".repeat(72));
  console.log(JSON.stringify(out, null, 2));
  console.log();

  mkdirSync(join(CONTRACTS_ROOT, ".cache"), { recursive: true });
  writeFileSync(SUBGRAPH_DEPLOY_CACHE, `${JSON.stringify(deployJsonForSubgraph, null, 2)}\n`, "utf8");
  writeFileSync(
    join(CONTRACTS_ROOT, ".cache", "last-bsc-mainnet-deploy-full.json"),
    `${JSON.stringify(out, null, 2)}\n`,
    "utf8",
  );
  console.log("Wrote:", SUBGRAPH_DEPLOY_CACHE);
  console.log("Wrote:", join(CONTRACTS_ROOT, ".cache", "last-bsc-mainnet-deploy-full.json"));

  if (isTenderlyVirtual || process.env.SKIP_SUBGRAPH_SYNC === "1") {
    console.log(
      isTenderlyVirtual
        ? "Tenderly Virtual — skipping subgraph ABI sync + Turbo pipeline."
        : "SKIP_SUBGRAPH_SYNC=1 — skipping subgraph ABI sync + Turbo pipeline.",
    );
  } else if (process.env.SKIP_TCGR === "1") {
    console.log(
      "SKIP_TCGR=1 — skipping subgraph sync (manifest requires TCGR + converter addresses).",
    );
  } else {
    runSubgraphSyncAfterDeploy(SUBGRAPH_DEPLOY_CACHE);
  }

  if (isTenderlyVirtual || process.env.SKIP_VERIFY === "1") {
    console.log(
      isTenderlyVirtual
        ? "Tenderly Virtual — skipping BscScan verification."
        : "SKIP_VERIFY=1 — skipping BscScan verification.",
    );
  } else {
    await runQueuedVerifications(verifyJobs);
  }

  console.log();
  console.log("Next steps (see docs/MAINNET_DEPLOYMENT.md):");
  console.log("  1. Run Founder NFT sale + InitialLaunch.buy (USDC → CASP/treasury).");
  console.log("  2. After countdown, initialLaunch.finalize() → supply recompute + 3% NEXUS mode.");
  console.log("  3. Create TCGV/USDC pair on Pancake; token.setPair(pair, true).");
  console.log("  4. Add liquidity via LiquidityWrapper (approve TCGV + USDC, addLiquidity).");
  console.log("  5. Confirm BscScan verify + subgraph/frontend addresses.");
  console.log("  6. Refund SOP: never auto-pay usdcRefundDue without nexusClawedBack check.");
  console.log("  7. Plan DEFAULT_ADMIN_ROLE / Ownable handoff to multisig after wiring.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

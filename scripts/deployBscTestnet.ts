/**
 * BSC Testnet (chainId 97) — full TCG Vault stack with PancakeSwap V2 testnet.
 *
 * Core addresses (official Pancake docs):
 *   Factory: 0x6725F303b657a9451d8BA641348b6761A6CC7a17
 *   Router:  0xD99D1c33F9fC3444f8101754aBC46c52416550D1
 *
 * Stablecoin:
 *   There is no widely canonical Circle USDC on BSC testnet. By default this script deploys
 *   `MockUSDC` (6 decimals, open `mint` — testnet only). To use another token, set USDC_ADDRESS.
 *
 * Prerequisites (Hardhat 3 keystore / env per hardhat.config.ts):
 *   - Network `bsctest` with BSCTEST_RPC_URL and TCG_KEY configured.
 *
 * Required env (see contracts/docs/WALLET_ADDRESSES.md — FR/EN labels vs .env):
 *   - VAULT_ADDRESS (community vault USDC), MARKETING_ADDRESS, COMMUNITY_ADDRESS — fee recipients
 *   - CASP_USDC_ADDRESS — MiCA CASP sink for FounderNFT and InitialLaunch USDC flows (required)
 *   - TREASURY_ADDRESS — InitialLaunch treasury alias (required)
 *   - LIQUIDITY_RECIPIENT, OPS_RECIPIENT — post-presale allocation recipients
 *   - TEAM_RECIPIENT — post-presale token allocation recipient (with LIQUIDITY_RECIPIENT, OPS_RECIPIENT)
 *
 * Optional env:
 *   - USDC_ADDRESS — skip MockUSDC deploy and use this 6-decimal stablecoin
 *   - SKIP_TCGR=1 — do not deploy TCGR + converter
 *   - SKIP_SUBGRAPH_SYNC=1 — after deploy, skip `yarn update:subgraph:abis` + subgraph `yarn sync:pipeline`
 *   - Manual subgraph cache (`.cache/last-bsctest-deploy.json`): if `stakingVault` / `basicNFT` are null,
 *     set `STAKING_VAULT_ADDRESS` and `BASIC_NFT_ADDRESS` when running subgraph `sync:pipeline`.
 *   - MOCK_USDC_MINT_DEPLOYER=0 — when deploying MockUSDC, skip minting 1M USDC to deployer
 *   - BASIC_NFT_MIN_STAKE — min stake as **decimal TCGV string** (e.g. `5000`); parsed with `parseEther` (default: `5000`)
 *   - DEPLOY_RECEIPT_TIMEOUT_MS — per-attempt waitForTransactionReceipt timeout (default: 300000)
 *   - DEPLOY_RECEIPT_POLL_MS — polling interval ms (default: 4000; slower helps flaky BSC testnet RPCs)
 *   - DEPLOY_RECEIPT_MAX_ATTEMPTS — retries when receipt is missing (default: 5)
 *   - DEPLOY_RETRY_GAS_LIMIT — fallback gas limit for deployment tx when RPC auto-estimation fails
 *     with "out of gas: gas required exceeds ..." (default: 3000000)
 *
 * Gas (BSC testnet):
 *   - If txs fail with "transaction underpriced", set BSCTEST_GAS_PRICE_WEI in .env (wei), e.g.
 *     15000000000 for 15 gwei. Default in hardhat.config.ts is 11 gwei when the env is unset.
 *
 * If TCGR is skipped, subgraph/Turbo sync is skipped (manifest requires TCGR + converter addresses).
 *
 * Usage:
 *   yarn deploy:bsctest
 */

import hre from "hardhat";
import { formatEther, getContractAddress, parseEther, type Address, zeroAddress } from "viem";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHAIN_ID_BSC_TESTNET = 97n;

/** PancakeSwap V2 on BSC testnet (docs). */
const PANCAKE_FACTORY_TESTNET = "0x6725F303b657a9451d8BA641348b6761A6CC7a17" as Address;
const PANCAKE_ROUTER_TESTNET = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1" as Address;

const USDC_6 = 1_000_000n;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_ROOT = join(__dirname, "..");
const SUBGRAPH_DEPLOY_CACHE = join(CONTRACTS_ROOT, ".cache", "last-bsctest-deploy.json");

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
    const network = process.env.HARDHAT_NETWORK ?? "bsctest";
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
  const { viem } = await hre.network.connect();
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const deploymentBlocks: bigint[] = [];

  const receiptTimeoutMs = Number(process.env.DEPLOY_RECEIPT_TIMEOUT_MS ?? 300_000);
  const receiptPollMs = Number(process.env.DEPLOY_RECEIPT_POLL_MS ?? 4_000);
  const receiptMaxAttempts = Math.max(1, Number(process.env.DEPLOY_RECEIPT_MAX_ATTEMPTS ?? 5));
  const deployRetryGasLimit = BigInt(process.env.DEPLOY_RETRY_GAS_LIMIT?.trim() ?? "3000000");

  /**
   * BSC testnet RPCs often lag or return null receipts briefly; viem's default timeout/poll
   * can throw TransactionReceiptNotFoundError even when the tx will confirm.
   */
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
    /**
     * Avoid `viem.sendDeploymentTransaction()` here: it does an immediate
     * `eth_getTransactionByHash`, which is flaky on BSC testnet RPCs and can throw
     * `TransactionNotFoundError` even though the tx was accepted.
     *
     * We deploy from bytecode, then wait for the receipt directly.
     */
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

  if (
    !vaultAddr ||
    !marketingAddr ||
    !communityAddr ||
    !caspUsdcAddr ||
    !treasuryAddr ||
    !liquidityRecipient ||
    !teamRecipient ||
    !opsRecipient
  ) {
    console.error(
      "Missing one or more required address env vars: VAULT_ADDRESS, MARKETING_ADDRESS, COMMUNITY_ADDRESS, CASP_USDC_ADDRESS, TREASURY_ADDRESS, LIQUIDITY_RECIPIENT, TEAM_RECIPIENT, OPS_RECIPIENT. Refusing to deploy.",
    );
    return;
  }

  console.log("=".repeat(72));
  console.log("BSC Testnet deploy — chainId 97");
  console.log("=".repeat(72));
  console.log("Deployer:     ", deployerAddr);
  console.log("Native bal:   ", formatEther(await publicClient.getBalance({ address: deployerAddr })));
  console.log("Vault (fees): ", vaultAddr);
  console.log("Marketing:    ", marketingAddr);
  console.log("Community:    ", communityAddr);
  console.log("CASP USDC:    ", caspUsdcAddr, "(Founder NFT + InitialLaunch USDC sink)");
  console.log("Treasury:     ", treasuryAddr, "(InitialLaunch treasury)");
  console.log("Pancake factory (ref):", PANCAKE_FACTORY_TESTNET);
  console.log("Pancake router:       ", PANCAKE_ROUTER_TESTNET);
  console.log();
  const verifyJobs: VerifyJob[] = [];

  let usdcAddress = process.env.USDC_ADDRESS?.trim() as Address | undefined;
  if (usdcAddress) {
    console.log("Using USDC_ADDRESS:", usdcAddress);
  } else {
    console.log("Deploying MockUSDC (6 decimals, testnet — open mint)…");
    const mock = await deployTracked("contracts/test/MockUSDC.sol:MockUSDC", [], {
      client: { wallet: deployer },
    });
    usdcAddress = mock.address as Address;
    console.log("MockUSDC:", usdcAddress);
    if (process.env.MOCK_USDC_MINT_DEPLOYER !== "0") {
      const m = await viem.getContractAt("contracts/test/MockUSDC.sol:MockUSDC", usdcAddress);
      const mintAmt = 1_000_000n * USDC_6;
      const mintHash = await m.write.mint([deployerAddr, mintAmt], { account: deployer.account });
      await waitForTxReceipt(mintHash);
      console.log(`Minted ${Number(mintAmt) / 1e6} USDC to deployer for tests.`);
    }
    verifyJobs.push({
      address: usdcAddress,
      constructorArguments: [],
      contract: "contracts/test/MockUSDC.sol:MockUSDC",
    });
  }
  console.log();

  let nonce = BigInt(
    await publicClient.getTransactionCount({ address: deployerAddr, blockTag: "pending" }),
  );

  const nexusTokenAddress = getContractAddress({ from: deployerAddr, nonce }) as Address;
  const tokenAddress = getContractAddress({ from: deployerAddr, nonce: nonce + 1n }) as Address;
  const founderNFTAddress = getContractAddress({ from: deployerAddr, nonce: nonce + 2n }) as Address;
  const initialLaunchAddress = getContractAddress({ from: deployerAddr, nonce: nonce + 3n }) as Address;

  console.log("--- Core (CREATE2-style nonce prediction) ---");

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
      PANCAKE_ROUTER_TESTNET,
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
      PANCAKE_ROUTER_TESTNET,
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

  const nexusToken = await viem.getContractAt("TCGNexusToken", nexusTokenAddress);
  const token = await viem.getContractAt("TCGVaultToken", tokenAddress);
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
  const stakingVaultContract = await viem.getContractAt("TCGVaultStakingVault", stakingVaultAddress);
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
  console.log("Note: TCGV staking vault is now configured via the TCGVaultToken constructor (no on-chain setter).");
  console.log();

  console.log("--- BuyRouter + Liquidity wrapper ---");
  const buyRouter = await deployTracked(
    "TCGVaultBuyRouter",
    [
      PANCAKE_ROUTER_TESTNET,
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
      PANCAKE_ROUTER_TESTNET,
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
    [tokenAddress, PANCAKE_ROUTER_TESTNET],
    { client: { wallet: deployer } },
  );
  const wrapperAddress = wrapper.address as Address;
  nonce += 1n;
  console.log("TCGVaultLiquidityWrapper:", wrapperAddress);
  verifyJobs.push({
    address: wrapperAddress,
    constructorArguments: [tokenAddress, PANCAKE_ROUTER_TESTNET],
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
    nonce += 1n;
    verifyJobs.push({
      address: tcgrAddress,
      constructorArguments: [buyRouterAddress, usdcAddress],
      contract: "contracts/TCGRToken.sol:TCGRToken",
    });
    const buyRouter = await viem.getContractAt("TCGVaultBuyRouter", buyRouterAddress);
    h = await buyRouter.write.setReferralToken([tcgrAddress], { account: deployer.account });
    await waitForTxReceipt(h);

    const converter = await deployTracked(
      "TCGRToTCGVConverter",
      [tcgrAddress, tokenAddress, parseEther("1")],
      { client: { wallet: deployer } },
    );
    converterAddress = converter.address as Address;
    nonce += 1n;
    verifyJobs.push({
      address: converterAddress,
      constructorArguments: [tcgrAddress, tokenAddress, parseEther("1")],
      contract: "contracts/TCGRToTCGVConverter.sol:TCGRToTCGVConverter",
    });
    const tcgrC = await viem.getContractAt("TCGRToken", tcgrAddress);
    h = await tcgrC.write.setConverter([converterAddress], { account: deployer.account });
    await waitForTxReceipt(h);
    console.log("TCGRToken:", tcgrAddress);
    console.log("TCGRToTCGVConverter:", converterAddress, "(fund converter with TCGV before convert)");
    console.log();
  }

  const startBlock = Number(deploymentBlocks.reduce((a, b) => (a < b ? a : b)));
  const lowerAddr = (a: Address) => a.toLowerCase() as Address;

  const out = {
    chainId: Number(CHAIN_ID_BSC_TESTNET),
    pancakeFactory: PANCAKE_FACTORY_TESTNET,
    pancakeRouter: PANCAKE_ROUTER_TESTNET,
    usdc: usdcAddress,
    usdcIsMock: !process.env.USDC_ADDRESS?.trim(),
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
    treasury: treasuryAddr,
    tcgr: tcgrAddress ?? null,
    tcgrConverter: converterAddress ?? null,
    startBlock,
  };

  const deployJsonForSubgraph = {
    chainId: Number(CHAIN_ID_BSC_TESTNET),
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

  if (process.env.SKIP_SUBGRAPH_SYNC === "1") {
    console.log("SKIP_SUBGRAPH_SYNC=1 — skipping subgraph ABI sync + Turbo pipeline.");
  } else if (process.env.SKIP_TCGR === "1") {
    console.log(
      "SKIP_TCGR=1 — skipping subgraph sync (manifest requires TCGR + converter addresses).",
    );
  } else {
    mkdirSync(join(CONTRACTS_ROOT, ".cache"), { recursive: true });
    writeFileSync(SUBGRAPH_DEPLOY_CACHE, `${JSON.stringify(deployJsonForSubgraph, null, 2)}\n`, "utf8");
    runSubgraphSyncAfterDeploy(SUBGRAPH_DEPLOY_CACHE);
  }

  await runQueuedVerifications(verifyJobs);
  console.log();
  console.log("Next steps:");
  console.log("  1. Run presale (Founder NFT + InitialLaunch.buy).");
  console.log("  2. After countdown, initialLaunch.finalize() → token supply recompute + 10% NEXUS mode.");
  console.log("  3. Create TCGV/USDC pair on Pancake testnet (factory above) or router; token.setPair(pair, true).");
  console.log("  4. Add liquidity via LiquidityWrapper (approve TCGV + USDC, addLiquidity).");
  console.log("  5. Optional: token.setMinAmounts(minBuy, minSell) for small pools.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

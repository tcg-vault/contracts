/**
 * Full flow on BSC fork: Presale (Founder NFT + InitialLaunch with USDC) → Finalize → Claim → optional DEX.
 *
 * Unit tests (TCGVaultFounderNFTAndLaunch.test.ts) cover presale edge cases (PresaleEnded, caps, vesting).
 * This script asserts the general flow end-to-end and expands with large-scale (multiple buyers, allocation consistency).
 *
 * Requires a BSC mainnet fork (TCGVaultToken constructor calls PancakeSwap router).
 *
 * Recommended — Hardhat fork (no Anvil/Docker needed; pass RPC via env):
 *   BSC_RPC_URL="https://your-bsc-rpc-url" yarn hardhat run scripts/testFullFlowOnBSCFork.ts --network hardhat
 *
 * Optional — Anvil fork (e.g. Docker):
 *   docker run --rm -it -p 8545:8545 --entrypoint anvil ghcr.io/foundry-rs/foundry:latest \
 *     --fork-url "https://<your-bsc-rpc>" --hardfork cancun --host 0.0.0.0 --port=8545
 *   yarn hardhat run scripts/testFullFlowOnBSCFork.ts --network localhost
 *
 * On Phase 4 revert the script prints revert reason and simulation decode (no env needed).
 *
 * Flow:
 *   1. Deploy: TCGVaultToken, TCGNexusToken, TCGVaultFounderNFT, TCGVaultInitialLaunch, BuyRouter, Wrapper, TCGR, Converter (USDC = real BSC USDC).
 *   2. Fund all accounts with real USDC via storage cheatcode (token initialLaunch is immutable = InitialLaunch; NEXUS presale bonus minters set in Nexus constructor).
 *   3. Trader buys TCGV (wave 1).
 *   4. Mint 245 Founder NFTs (paid, trader) so wave 2 starts; exhaust paid supply to PAID_TOTAL (490); wave-2 buys; large-scale multiple buyers.
 *   5. Time travel 121h, finalize; assert buy() reverts (PresaleEnded).
 *   6. Trader claims 10% TGE; vesting over 9 months.
 *   7. Optional: TCGV/USDC DEX liquidity, USDC→TCGV swap, BuyRouter referral, TCGR→TCGV convert.
 */

import hre from "hardhat";
import {
  parseEther,
  formatEther,
  zeroAddress,
  getContractAddress,
  encodeFunctionData,
  decodeErrorResult,
  keccak256,
  encodeAbiParameters,
  toHex,
  type Address,
} from "viem";

const PANCAKE_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E" as Address;
const PANCAKE_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73" as Address;
/** BSC USDC (BEP20). 6 decimals. Balance at slot 1 (Anvil/Hardhat setStorageAt). */
const BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Address;
const USDC_DECIMALS = 6;

/** BSC USDC _balances mapping at slot 1 (keyThenSlot = keccak256(h(account).1)). Verified on fork. */
const BSC_USDC_BALANCES_SLOT = 1;

/**
 * Storage slot for mapping(address => uint256) at slot p: keccak256(h(k) . p) per Solidity layout.
 */
function mappingSlotForKey(account: Address, mappingSlot: number): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [account, BigInt(mappingSlot)],
    ),
  ) as `0x${string}`;
}

/** Ensure 32-byte hex string for storage (0x + 64 hex chars). */
function toStorageHex(v: `0x${string}` | Uint8Array): string {
  if (typeof v === "string") return v.startsWith("0x") ? v : `0x${v}`;
  return "0x" + Array.from(v).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Set storage at (address, slot, value). Use networkHelpers.setStorageAt (Hardhat) or anvil_setStorageAt (Anvil/localhost). */
type SetStorageAtFn = (address: string, slotHex: string, valueHex: string) => Promise<void>;

/** Set BSC USDC balance via storage slot (cheatcode). Amount in token decimals (e.g. 6 for USDC). */
async function setBSCUSDCBalance(
  account: Address,
  usdcContract: Address,
  amount: bigint,
  setStorageAt: SetStorageAtFn,
  usdcForVerify?: { read: { balanceOf: (args: [Address]) => Promise<bigint> } },
  balancesSlot = BSC_USDC_BALANCES_SLOT,
): Promise<void> {
  const addressStr = (typeof usdcContract === "string" ? usdcContract : String(usdcContract)).toLowerCase();
  const storageSlot = mappingSlotForKey(account, balancesSlot);
  const value = toHex(amount, { size: 32 });
  await setStorageAt(addressStr, toStorageHex(storageSlot as `0x${string}`), toStorageHex(value as `0x${string}`));
  if (usdcForVerify) {
    const balance = await usdcForVerify.read.balanceOf([account]);
    if (balance !== amount) throw new Error(`setBSCUSDCBalance verify failed for ${account} (slot ${balancesSlot}): expected ${amount}, got ${balance}`);
  }
}

const FOUNDER_NFT_WAVE1_CAP = 245;
const WAVE1_TRADER_MINTS = 245;
/** Must match `TCGVaultInitialLaunch.FINALIZE_DELAY_AFTER_PRESALE_END` (private; not on ABI). */
const FINALIZE_DELAY_AFTER_PRESALE_END_SEC = 20 * 24 * 3600;
const USDC_6 = 1_000_000n; // 1 USDC = 1e6

/**
 * Print revert reason from a caught error (viem contract errors have cause/shortMessage/data).
 * Then run debug_traceCall so we see the call tree. Always runs on Phase 4 revert (no TRACE env needed).
 */
function formatRevertReason(e: unknown): string {
  if (e instanceof Error && "cause" in e && e.cause && typeof e.cause === "object") {
    const c = e.cause as { shortMessage?: string; data?: unknown; message?: string };
    let out = c.shortMessage ?? c.message ?? "reverted";
    const data = c.data;
    if (data && typeof data === "string" && data.startsWith("0x")) {
      try {
        const decoded = decodeErrorResult({
          data: data as `0x${string}`,
          abi: [
            { type: "error", name: "ExceedsSupply", inputs: [] },
            { type: "error", name: "OwnerWaveQuotaExceeded", inputs: [] },
            { type: "error", name: "ReservedForOwner", inputs: [] },
            { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
          ],
        });
        out += ` [decoded: ${decoded.errorName}${decoded.args?.length ? " " + JSON.stringify(decoded.args) : ""}]`;
      } catch {
        out += " | data: " + data.slice(0, 66) + (data.length > 66 ? "..." : "");
      }
    } else if (data) out += " | " + String(data);
    return out;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Trace a contract call using debug_traceCall (Anvil supports it; use --hardfork cancun if needed).
 * Logs to console so it's visible when script is run.
 */
async function traceCall(
  publicClient: { request: (args: { method: string; params: unknown[] }) => Promise<unknown> },
  opts: { to: Address; data: `0x${string}`; from: Address; value?: bigint },
): Promise<void> {
  const call = {
    from: opts.from,
    to: opts.to,
    data: opts.data,
    value: opts.value ?? 0n,
    gas: 30_000_000n,
  };
  try {
    // Anvil: debug_traceCall(call, block, { tracer: "callTracer" })
    const trace = (await publicClient.request({
      method: "debug_traceCall",
      params: [call, "latest", { tracer: "callTracer" }],
    })) as Record<string, unknown>;
    const prune = (obj: unknown, depth = 0): unknown => {
      if (depth > 6) return "[...]";
      if (Array.isArray(obj)) return obj.map((x) => prune(x, depth + 1));
      if (obj && typeof obj === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k === "input" && typeof v === "string" && v.length > 70) out[k] = v.slice(0, 70) + "...";
          else out[k] = prune(v, depth + 1);
        }
        return out;
      }
      return obj;
    };
    console.log("\n--- Trace (debug_traceCall) ---");
    console.log(JSON.stringify(prune(trace), null, 2));
    if (trace.error) console.log("Revert in trace:", trace.error);
    console.log("--- End trace ---\n");
  } catch (tracerErr) {
    console.log("Tracer failed (node may not support debug_traceCall or use different params):", tracerErr instanceof Error ? tracerErr.message : tracerErr);
  }
}

/** Simulate mint via eth_call to get revert data; decode and log. */
async function simulateMintAndLogRevert(
  publicClient: { call: (args: { to: Address; data: `0x${string}`; account: Address }) => Promise<unknown> },
  founderNFTAddress: Address,
  founderNFTAbi: readonly unknown[],
  from: Address,
): Promise<void> {
  const data = encodeFunctionData({
    abi: founderNFTAbi as Parameters<typeof encodeFunctionData>[0]["abi"],
    functionName: "mint",
    args: [],
  });
  try {
    await publicClient.call({ to: founderNFTAddress, data, account: from });
  } catch (simErr: unknown) {
    const err = simErr as { data?: unknown; cause?: { data?: unknown } };
    const revertData = err.data ?? (err.cause && typeof err.cause === "object" && "data" in err.cause ? (err.cause as { data: unknown }).data : undefined);
    if (revertData && typeof revertData === "string" && revertData.startsWith("0x") && revertData.length > 10) {
      console.log("Simulation revert data (hex):", revertData.slice(0, 138) + (revertData.length > 138 ? "..." : ""));
      try {
        const decoded = decodeErrorResult({
          data: revertData as `0x${string}`,
          abi: [
            { type: "error", name: "ExceedsSupply", inputs: [] },
            { type: "error", name: "OwnerWaveQuotaExceeded", inputs: [] },
            { type: "error", name: "ReservedForOwner", inputs: [] },
            { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
            { type: "error", name: "ERC20InsufficientBalance", inputs: [{ name: "from", type: "address" }, { name: "balance", type: "uint256" }, { name: "needed", type: "uint256" }] },
            { type: "error", name: "ERC20InsufficientAllowance", inputs: [{ name: "spender", type: "address" }, { name: "allowance", type: "uint256" }, { name: "needed", type: "uint256" }] },
          ],
        });
        console.log("Decoded revert:", decoded.errorName, decoded.args ? JSON.stringify(decoded.args) : "");
      } catch {
        // ignore
      }
    } else {
      console.log("Simulation error (no revert data):", simErr instanceof Error ? simErr.message : String(simErr));
    }
  }
}

async function main() {
  const { viem, networkHelpers } = await hre.network.connect();
  const wallets = await viem.getWalletClients();
  if (!wallets || wallets.length < 2) {
    throw new Error("Need at least 2 wallet accounts (deployer, trader)");
  }
  const deployer = wallets[0]!;
  const trader = wallets[1]!;
  const wave2Buyer = wallets[2] ?? wallets[1]!;
  const whale = wallets[3] ?? wallets[1]!;

  // Top up native balance for gas on Anvil/Hardhat fork (no DEX path; TCGV/USDC only for trading).
  try {
    const richBalanceHex = "0x3635C9ADC5DEA0000000";
    const provider = (hre as { network?: { provider?: { request?: (a: { method: string; params: unknown[] }) => Promise<unknown> } } }).network?.provider;
    if (provider?.request) {
      for (const w of [deployer, trader, wave2Buyer, whale]) {
        await provider.request({ method: "anvil_setBalance", params: [w.account.address, richBalanceHex] });
      }
    }
  } catch {
    // Pre-funded default accounts on Hardhat, or live network — no cheatcode.
  }

  const vaultReceiver = await viem.deployContract("FeeReceiver", [], { client: { wallet: deployer } });
  const marketingReceiver = await viem.deployContract("FeeReceiver", [], { client: { wallet: deployer } });
  const communityReceiver = await viem.deployContract("FeeReceiver", [], { client: { wallet: deployer } });
  const liquidityReceiver = await viem.deployContract("FeeReceiver", [], { client: { wallet: deployer } });
  const opsReceiver = await viem.deployContract("FeeReceiver", [], { client: { wallet: deployer } });
  const vaultAddr = vaultReceiver.address as Address;
  const marketingAddr = marketingReceiver.address as Address;
  const communityAddr = communityReceiver.address as Address;
  const liquidityAddr = liquidityReceiver.address as Address;
  const opsAddr = opsReceiver.address as Address;

  const publicClient = await viem.getPublicClient();

  // Storage cheat: Hardhat network uses networkHelpers.setStorageAt; Anvil (localhost) uses anvil_setStorageAt.
  const setStorageAt: SetStorageAtFn = async (address: string, slotHex: string, valueHex: string) => {
    if (networkHelpers?.setStorageAt) await networkHelpers.setStorageAt(address, slotHex, valueHex);
    else await (publicClient as { request: (args: { method: string; params: unknown[] }) => Promise<unknown> }).request({ method: "anvil_setStorageAt", params: [address, slotHex, valueHex] });
  };

  console.log("=".repeat(80));
  console.log("TCG Vault — Full flow on BSC fork (Presale → Finalize → Claim)");
  console.log("=".repeat(80));
  console.log("Deployer:", deployer.account.address);
  console.log("Trader:  ", trader.account.address);
  console.log();

  let nonce = BigInt(
    await publicClient.getTransactionCount({ address: deployer.account.address, blockTag: "pending" })
  );

  // --- Phase 1: Deploy core contracts (use real BSC USDC) ---
  // CREATE order (nonce .. nonce+3): Nexus, TCGV, FounderNFT, InitialLaunch — all addresses predicted up front.
  // TCGVaultToken.stakingVault is immutable → predict TCGVaultStakingVault at nonce+4 and deploy it immediately after InitialLaunch.
  console.log("--- Phase 1: Deploy core contracts (USDC = real BSC USDC) ---");

  const nexusTokenAddress = getContractAddress({ from: deployer.account.address, nonce }) as Address;
  const tokenAddress = getContractAddress({ from: deployer.account.address, nonce: nonce + 1n }) as Address;
  const founderNFTAddress = getContractAddress({ from: deployer.account.address, nonce: nonce + 2n }) as Address;
  const initialLaunchAddress = getContractAddress({ from: deployer.account.address, nonce: nonce + 3n }) as Address;
  const stakingVaultAddress = getContractAddress({ from: deployer.account.address, nonce: nonce + 4n }) as Address;

  await viem.deployContract("contracts/TCGNexusToken.sol:TCGNexusToken", [tokenAddress, founderNFTAddress, initialLaunchAddress], {
    client: { wallet: deployer },
  });
  nonce += 1n;

  await viem.deployContract("TCGVaultToken", [
    stakingVaultAddress,
    PANCAKE_ROUTER,
    vaultAddr,
    marketingAddr,
    communityAddr,
    nexusTokenAddress,
    initialLaunchAddress,
  ], { client: { wallet: deployer } });
  nonce += 1n;

  await viem.deployContract("TCGVaultFounderNFT", [BSC_USDC, nexusTokenAddress, vaultAddr], {
    client: { wallet: deployer },
  });
  nonce += 1n;

  await viem.deployContract("TCGVaultInitialLaunch", [
    tokenAddress,
    BSC_USDC,
    founderNFTAddress,
    nexusTokenAddress,
    vaultAddr,
  ], { client: { wallet: deployer } });
  nonce += 1n;

  await viem.deployContract("TCGVaultStakingVault", [tokenAddress], { client: { wallet: deployer } });
  nonce += 1n;

  const nexusToken = await viem.getContractAt("TCGNexusToken", nexusTokenAddress);
  const token = await viem.getContractAt("TCGVaultToken", tokenAddress);
  const founderNFT = await viem.getContractAt("TCGVaultFounderNFT", founderNFTAddress);
  const initialLaunch = await viem.getContractAt("TCGVaultInitialLaunch", initialLaunchAddress);

  console.log("TCGNexusToken:", nexusTokenAddress);
  console.log("TCGVaultToken:", tokenAddress);
  console.log("TCGVaultFounderNFT:", founderNFTAddress);
  console.log("TCGVaultInitialLaunch:", initialLaunchAddress);
  console.log("TCGVaultStakingVault:", stakingVaultAddress);

  console.log("Presale finalizer (immutable) = InitialLaunch; Nexus presale bonus minters = FounderNFT + InitialLaunch (constructor).");
  console.log();

  // --- Phase 2: BuyRouter & Wrapper (for optional DEX later) ---
  console.log("--- Phase 2: BuyRouter & Wrapper ---");
  const buyRouter = await viem.deployContract("TCGVaultBuyRouter", [
    PANCAKE_ROUTER,
    BSC_USDC,
    tokenAddress,
    vaultAddr,
    marketingAddr,
    communityAddr,
  ], { client: { wallet: deployer } });
  await token.write.setBuyRouter([buyRouter.address as Address], { account: deployer.account });
  const wrapper = await viem.deployContract(
    "contracts/TCGVaultLiquidityWrapper.sol:TCGVaultLiquidityWrapper",
    [tokenAddress, PANCAKE_ROUTER],
    { client: { wallet: deployer } },
  );
  await token.write.setExcludedFromFees([wrapper.address as Address, true], { account: deployer.account });

  const tcgr = await viem.deployContract("TCGRToken", [buyRouter.address as Address, usdcAddress as Address], { client: { wallet: deployer } });
  const tcgrAddress = tcgr.address as Address;
  await buyRouter.write.setReferralToken([tcgrAddress], { account: deployer.account });
  const converter = await viem.deployContract("TCGRToTCGVConverter", [
    tcgrAddress,
    tokenAddress,
    parseEther("1"),
  ], { client: { wallet: deployer } });
  const converterAddress = converter.address as Address;
  await tcgr.write.setConverter([converterAddress], { account: deployer.account });
  console.log("TCGRToken (referral):", tcgrAddress);
  console.log("TCGRToTCGVConverter (1:1):", converterAddress);
  console.log("BuyRouter and Wrapper set.");
  console.log();

  // --- Fund all accounts with real USDC via storage cheatcode ---
  const usdc = await viem.getContractAt('BEP20TokenImplementation', BSC_USDC);
  const BIG_USDC = 50_000_000n * USDC_6;
  await setBSCUSDCBalance(deployer.account.address, BSC_USDC, BIG_USDC, setStorageAt, usdc);
  await setBSCUSDCBalance(trader.account.address, BSC_USDC, BIG_USDC, setStorageAt, usdc);
  await setBSCUSDCBalance(wave2Buyer.account.address, BSC_USDC, 100_000n * USDC_6, setStorageAt, usdc);
  await setBSCUSDCBalance(whale.account.address, BSC_USDC, BIG_USDC, setStorageAt, usdc);
  console.log("Funded deployer, trader, wave2Buyer, whale with real USDC (cheatcode); balanceOf verified.");

  // --- Phase 3: Trader buy (wave 1) ---
  console.log("--- Phase 3: Trader buy in wave 1 ---");
  const buyUsdcAmount = 1_000n * USDC_6;
  await usdc.write.approve([initialLaunchAddress, buyUsdcAmount], { account: trader.account });
  await initialLaunch.write.buy([buyUsdcAmount], { account: trader.account });
  const allocated = (await initialLaunch.read.allocations([trader.account.address])) as readonly [bigint, bigint];
  console.log(`Trader bought with ${Number(buyUsdcAmount) / 1e6} USDC; TCGV allocated: ${formatEther(allocated[0])}`);
  console.log();

  // --- Phase 4: Mint 245 paid Founder NFTs (wave 1) so wave 2 starts ---
  console.log("--- Phase 4: Mint 245 Founder NFTs (wave 2 starts) ---");
  const wave1Price = 200n * USDC_6;
  let deployerUsdcBalance = await usdc.read.balanceOf([deployer.account.address]);
  let deployerAllowance = await usdc.read.allowance([deployer.account.address, founderNFTAddress]);
  if (deployerUsdcBalance === 0n) {
    console.log("Deployer USDC balance was 0; retrying with balances at slot 0 (some BEP20 use slot 0).");
    await setBSCUSDCBalance(deployer.account.address, BSC_USDC, BIG_USDC, setStorageAt, undefined, 0);
    deployerUsdcBalance = await usdc.read.balanceOf([deployer.account.address]);
    deployerAllowance = await usdc.read.allowance([deployer.account.address, founderNFTAddress]);
  }
  console.log("Deployer USDC balance:", deployerUsdcBalance.toString(), "| allowance for Founder NFT:", deployerAllowance.toString(), "| need:", wave1Price.toString());
  try {
    await usdc.write.approve([founderNFTAddress, wave1Price * BigInt(WAVE1_TRADER_MINTS)], { account: trader.account });
    for (let i = 0; i < WAVE1_TRADER_MINTS; i++) {
      await founderNFT.write.mint({ account: trader.account });
      if ((i + 1) % 50 === 0) console.log(`  Minted ${i + 1}/${WAVE1_TRADER_MINTS} (trader, wave 1)`);
    }
  } catch (e: unknown) {
    console.log("\n--- Phase 4 mint reverted ---");
    console.log("Revert reason:", formatRevertReason(e));
    await simulateMintAndLogRevert(
      publicClient as { call: (args: { to: Address; data: `0x${string}`; account: Address }) => Promise<unknown> },
      founderNFTAddress,
      founderNFT.abi,
      trader.account.address,
    );
    const data = encodeFunctionData({
      abi: founderNFT.abi,
      functionName: "mint",
      args: [],
    });
    await traceCall(publicClient as { request: (args: { method: string; params: unknown[] }) => Promise<unknown> }, {
      to: founderNFTAddress,
      data,
      from: trader.account.address,
    });
    throw e;
  }
  const soldCount = await founderNFT.read.soldCount();
  const w2 = await founderNFT.read.wave2StartTimestamp();
  if (soldCount !== BigInt(FOUNDER_NFT_WAVE1_CAP)) throw new Error(`Expected soldCount ${FOUNDER_NFT_WAVE1_CAP}, got ${soldCount}`);
  if (w2 === 0n) throw new Error("wave2StartTimestamp should be set after 245 wave-1 paid mints");
  console.log(`Founder NFT soldCount: ${soldCount}, wave2StartTimestamp: ${w2}`);
  console.log();

  // --- Phase 4.A: Founder NFT wave 2 price and supply edge ---
  console.log("--- Phase 4.A: Founder NFT wave 2 price & cap edge ---");
  const nftPriceBefore = await founderNFT.read.currentPrice();
  console.log("FounderNFT currentPrice before extra mint (expected 350):", Number(nftPriceBefore) / 1e6);
  const wave2NftPrice = 350n * USDC_6;
  await usdc.write.approve([founderNFTAddress, wave2NftPrice], { account: trader.account });
  await founderNFT.write.mint({ account: trader.account });
  const soldCountAfterOne = await founderNFT.read.soldCount();
  const nftPriceAfter = await founderNFT.read.currentPrice();
  console.log("Founder NFT soldCount after extra mint (expected 246):", soldCountAfterOne);
  console.log("FounderNFT currentPrice after extra mint (should stay 350):", Number(nftPriceAfter) / 1e6);
  console.log();

  // --- Phase 4.B: Exhaust Founder NFT paid supply to PAID_TOTAL (490) ---
  console.log("--- Phase 4.B: Exhaust Founder NFT paid supply to PAID_TOTAL ---");
  const paidTotal = await founderNFT.read.PAID_TOTAL();
  let paidSold = await founderNFT.read.soldCount();
  console.log("PAID_TOTAL:", paidTotal.toString(), "| already sold:", paidSold.toString());
  if (paidSold < paidTotal) {
    const remaining = paidTotal - paidSold;
    const wave2PriceUsdc = 350n * USDC_6;
    await usdc.write.approve([founderNFTAddress, wave2PriceUsdc * remaining], { account: trader.account });
    for (let j = 0n; j < remaining; j++) {
      await founderNFT.write.mint({ account: trader.account });
    }
  }
  const soldCountAfterAllPaid = await founderNFT.read.soldCount();
  if (soldCountAfterAllPaid !== paidTotal) throw new Error(`Expected soldCount ${paidTotal}, got ${soldCountAfterAllPaid}`);
  console.log("Founder NFT soldCount after exhausting PAID_TOTAL:", soldCountAfterAllPaid.toString());
  // Expected-revert test: one more mint must revert with ExceedsSupply (no try/catch on happy path).
  try {
    await founderNFT.write.mint({ account: trader.account });
    throw new Error("Extra paid mint should revert with ExceedsSupply");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("revert") && !msg.includes("ExceedsSupply")) console.log("Extra paid mint reverted as expected (ExceedsSupply):", msg);
  }
  console.log();

  // --- Phase 4.5: Wave 2 presale buy at higher price (0.008 $/TCGV) ---
  console.log("--- Phase 4.5: Wave 2 presale buy (higher price) ---");
  const wave2PriceRaw = await initialLaunch.read.currentPrice();
  console.log("InitialLaunch currentPrice (USDC, 6 decimals):", Number(wave2PriceRaw) / 1e6);
  const wave2BuyUsdcAmount = 1_000n * USDC_6;
  const wave2BeforeAlloc = (await initialLaunch.read.allocations([wave2Buyer.account.address])) as readonly [bigint, bigint];
  await usdc.write.approve([initialLaunchAddress, wave2BuyUsdcAmount], { account: wave2Buyer.account });
  await initialLaunch.write.buy([wave2BuyUsdcAmount], { account: wave2Buyer.account });
  const wave2Allocated = (await initialLaunch.read.allocations([wave2Buyer.account.address])) as readonly [bigint, bigint];
  const wave2Delta = wave2Allocated[0] - wave2BeforeAlloc[0];
  console.log(
    `Wave 2 buyer spent ${Number(wave2BuyUsdcAmount) / 1e6} USDC; additional TCGV allocated at wave 2 price: ${formatEther(
      wave2Delta,
    )} (total for this address: ${formatEther(wave2Allocated[0])})`,
  );
  console.log();

  // --- Phase 4.5b: Large-scale — multiple wave-2 buyers (use wallets 3+ so we don't duplicate wave2Buyer) ---
  console.log("--- Phase 4.5b: Large-scale (multiple wave-2 buyers) ---");
  const extraBuyers = wallets.slice(3, Math.min(7, wallets.length));
  const perBuyerUsdc = [500n * USDC_6, 300n * USDC_6, 800n * USDC_6, 200n * USDC_6];
  const buyerAddresses: Address[] = [trader.account.address, wave2Buyer.account.address];
  for (let i = 0; i < extraBuyers.length; i++) {
    const acc = extraBuyers[i]!;
    const usdcAmt = perBuyerUsdc[i % perBuyerUsdc.length]!;
    await setBSCUSDCBalance(acc.account.address, BSC_USDC, 10_000n * USDC_6, setStorageAt, usdc);
    await usdc.write.approve([initialLaunchAddress, usdcAmt], { account: acc.account });
    await initialLaunch.write.buy([usdcAmt], { account: acc.account });
    buyerAddresses.push(acc.account.address);
  }
  let totalFromAllocations = 0n;
  for (const addr of buyerAddresses) {
    const [alloc] = (await initialLaunch.read.allocations([addr])) as readonly [bigint, bigint];
    totalFromAllocations += alloc;
  }
  const totalAllocatedCheck = await initialLaunch.read.totalTCGVAllocated();
  if (totalFromAllocations !== totalAllocatedCheck) throw new Error(`totalTCGVAllocated ${totalAllocatedCheck} != sum of allocations ${totalFromAllocations}`);
  console.log("Total TCGV allocated (presale):", formatEther(totalAllocatedCheck), "| sum of allocations:", formatEther(totalFromAllocations), "[OK]");
  console.log();

  // --- Phase 4.6: Presale HARD_CAP_TCGV edge (ExceedsHardCap) ---
  // Expected-revert test: buy above hard cap must revert.
  console.log("--- Phase 4.6: Presale HARD_CAP_TCGV edge ---");
  try {
    const hardCap = await initialLaunch.read.HARD_CAP_TCGV();
    const priceNow = await initialLaunch.read.currentPrice();
    const usdcForCap = (hardCap * priceNow) / (10n ** 18n);
    const usdcAboveCap = usdcForCap + USDC_6;
    console.log("HARD_CAP_TCGV:", formatEther(hardCap));
    console.log("Attempting buy that exceeds HARD_CAP_TCGV with USDC:", Number(usdcAboveCap) / 1e6);
    await usdc.write.approve([initialLaunchAddress, usdcAboveCap], { account: whale.account });
    await initialLaunch.write.buy([usdcAboveCap], { account: whale.account });
    console.warn("Hard cap buy did NOT revert as expected (check HARD_CAP_TCGV).");
  } catch (e) {
    console.log("Hard cap buy reverted as expected (ExceedsHardCap):", e instanceof Error ? e.message : e);
  }
  console.log();

  // --- Phase 4.7: Anti-whale cap (4% per wallet) ---
  // Expected-revert test: whale buy above per-wallet cap must revert.
  console.log("--- Phase 4.7: Anti-whale cap (4% per wallet) ---");
  try {
    const maxPerWallet = await initialLaunch.read.maxPerWallet();
    const wave2Price = await initialLaunch.read.currentPrice();
    const usdcForMax = (maxPerWallet * wave2Price) / (10n ** 18n);
    const usdcAboveMax = usdcForMax + USDC_6;
    console.log("maxPerWallet (TCGV):", formatEther(maxPerWallet));
    console.log("Attempting whale buy with USDC (just above cap):", Number(usdcAboveMax) / 1e6);

    await usdc.write.approve([initialLaunchAddress, usdcAboveMax], { account: whale.account });
    await initialLaunch.write.buy([usdcAboveMax], { account: whale.account });
    console.warn("Whale buy did NOT revert as expected (check cap config).");
  } catch (e) {
    console.log("Whale buy reverted as expected (wallet cap working):", e instanceof Error ? e.message : e);
  }
  console.log();

  // --- Phase 5: Time travel past presale end + finalize delay, then finalize ---
  // `presaleEndTime()` = Founder `wave2Start` + 10d + 120h. `finalize()` requires
  // `block.timestamp >= presaleEndTime() + 20d` (see `_canFinalizeNormally` in TCGVaultInitialLaunch).
  console.log("--- Phase 5: Warp to presale end + 20d delay, set recipients, finalize ---");
  const presaleEnd = await initialLaunch.read.presaleEndTime();
  const maxU256 = 2n ** 256n - 1n;
  if (presaleEnd >= maxU256) throw new Error("presaleEndTime is unset (max); Founder wave2 / countdown not linked");
  const head = await publicClient.getBlock({ blockTag: "latest" });
  const nowTs = head.timestamp;
  const finalizeEligibleTs = presaleEnd + BigInt(FINALIZE_DELAY_AFTER_PRESALE_END_SEC) + 1n;
  const warpSec = finalizeEligibleTs > nowTs ? finalizeEligibleTs - nowTs : 0n;
  console.log(
    `presaleEndTime=${presaleEnd} now=${nowTs} → warp +${warpSec.toString()}s (incl. ${FINALIZE_DELAY_AFTER_PRESALE_END_SEC}s post-end delay)`,
  );
  try {
    if (warpSec > 0n) {
      if (networkHelpers?.time) {
        await networkHelpers.time.increase(Number(warpSec));
        await networkHelpers.mine();
      } else {
        const rpc = publicClient as { request: (args: { method: string; params: unknown[] }) => Promise<unknown> };
        await rpc.request({ method: "evm_increaseTime", params: [Number(warpSec)] });
        await rpc.request({ method: "evm_mine", params: [] });
      }
      console.log("Time warped and block mined.");
    } else {
      console.log("Already past finalize window; mining one block.");
      if (networkHelpers?.mine) await networkHelpers.mine();
      else await (publicClient as { request: (args: { method: string; params: unknown[] }) => Promise<unknown> }).request({ method: "evm_mine", params: [] });
    }
  } catch (e) {
    console.warn("Time travel not supported (e.g. live RPC); skipping. Finalize may revert.", e instanceof Error ? e.message : e);
  }

  await token.write.setAllocationRecipients([deployer.account.address, deployer.account.address, deployer.account.address], { account: deployer.account });
  await initialLaunch.write.finalize({ account: deployer.account });
  const tgeTs = await initialLaunch.read.tgeTimestamp();
  if (tgeTs === 0n) throw new Error("finalize: tgeTimestamp must be set");
  console.log("Presale finalized. TGE timestamp:", tgeTs.toString());
  const totalAllocated = await initialLaunch.read.totalTCGVAllocated();
  console.log("Total TCGV allocated (presale):", formatEther(totalAllocated));

  // Expected-revert test: buy() after finalize must revert with PresaleEnded.
  try {
    await usdc.write.approve([initialLaunchAddress, USDC_6], { account: trader.account });
    await initialLaunch.write.buy([USDC_6], { account: trader.account });
    throw new Error("buy() after finalize should revert with PresaleEnded");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("PresaleEnded") && !msg.includes("revert")) console.log("buy after finalize reverted as expected (PresaleEnded):", msg);
  }

  const totalSupplyAfter = await token.read.totalSupply();
  const expectedFinalSupply = (totalAllocated * 10000n) / 6000n;
  console.log("TCGV totalSupply after recompute:", formatEther(totalSupplyAfter));
  console.log("TCGV expected finalSupply from whitepaper ratio (60% presale):", formatEther(expectedFinalSupply));
  console.log();

  // --- Phase 6: Trader claims vested TCGV ---
  console.log("--- Phase 6: Trader claims (10% TGE) ---");
  const traderAllocForReleasable = (await initialLaunch.read.allocations([trader.account.address])) as readonly [bigint, bigint];
  const releasable = await initialLaunch.read.releasable([trader.account.address]);
  const expectedTge = (traderAllocForReleasable[0] * 10n) / 100n;
  if (releasable !== expectedTge) throw new Error(`releasable at TGE: expected 10% = ${formatEther(expectedTge)}, got ${formatEther(releasable)}`);
  console.log("Releasable for trader (10% TGE):", formatEther(releasable));
  await initialLaunch.write.claim({ account: trader.account });
  const traderTcgv = await token.read.balanceOf([trader.account.address]);
  if (traderTcgv !== releasable) throw new Error(`Trader TCGV after claim: expected ${formatEther(releasable)}, got ${formatEther(traderTcgv)}`);
  console.log("Trader TCGV balance after claim:", formatEther(traderTcgv));
  console.log();

  // --- Phase 6.N: NEXUS 30% presale bonuses ---
  console.log("--- Phase 6.N: NEXUS 30% presale bonuses ---");
  const nexusTrader = await nexusToken.read.balanceOf([trader.account.address]);
  const nexusWave2Buyer = await nexusToken.read.balanceOf([wave2Buyer.account.address]);
  console.log("NEXUS balance for trader (should reflect presale buys + Founder NFTs):", formatEther(nexusTrader));
  console.log("NEXUS balance for wave2Buyer (should reflect presale wave2 buy):", formatEther(nexusWave2Buyer));
  console.log();

  // --- Phase 6.5: Vesting schedule over 9 months (10% per month) ---
  console.log("--- Phase 6.5: Vesting over 9 months ---");
  const traderAlloc = (await initialLaunch.read.allocations([trader.account.address])) as readonly [bigint, bigint];
  console.log("Trader total allocation:", formatEther(traderAlloc[0]));
  for (let month = 1; month <= 9; month++) {
    try {
      if (networkHelpers?.time) {
        await networkHelpers.time.increase(30 * 24 * 3600);
        await networkHelpers.mine();
      } else {
        const rpc = publicClient as { request: (args: { method: string; params: unknown[] }) => Promise<unknown> };
        await rpc.request({ method: "evm_increaseTime", params: [30 * 24 * 3600] });
        await rpc.request({ method: "evm_mine", params: [] });
      }
    } catch (e) {
      console.warn(`Time travel for vesting month ${month} failed:`, e instanceof Error ? e.message : e);
    }

    const monthReleasable = await initialLaunch.read.releasable([trader.account.address]);
    console.log(`Month ${month}: releasable for trader:`, formatEther(monthReleasable));
    if (monthReleasable > 0n) {
      await initialLaunch.write.claim({ account: trader.account });
      const bal = await token.read.balanceOf([trader.account.address]);
      console.log(`Month ${month}: trader TCGV balance after claim:`, formatEther(bal));
    }
  }
  const finalAlloc = (await initialLaunch.read.allocations([trader.account.address])) as readonly [bigint, bigint];
  console.log("Trader final claimed/allocated:", {
    allocated: formatEther(finalAlloc[0]),
    claimed: formatEther(finalAlloc[1]),
  });
  console.log();

  // --- Phase 7 (optional): TCGV/USDC pair, add liquidity, swap, BuyRouter USDC buy ---
  console.log("--- Phase 7: TCGV/USDC pair, add liquidity and DEX ---");
  try {
    const deployerAddr = String(deployer.account.address);
    const traderAddr = String(trader.account.address);
    await setBSCUSDCBalance(deployerAddr as Address, BSC_USDC, 10_000_000n * 10n ** BigInt(USDC_DECIMALS), setStorageAt, usdc);
    await setBSCUSDCBalance(traderAddr as Address, BSC_USDC, 1_000_000n * 10n ** BigInt(USDC_DECIMALS), setStorageAt, usdc);
    const deployerUsdcBal = (await usdc.read.balanceOf([deployer.account.address])) as bigint;
    console.log("BSC USDC deployer balance (cheatcode):", Number(deployerUsdcBal) / 1e6, "USDC");

    const pancakeFactory = await viem.getContractAt("PancakeFactory", PANCAKE_FACTORY);
    const pancakeRouter = await viem.getContractAt("PancakeRouter", PANCAKE_ROUTER);
    let pairAddress = (await pancakeFactory.read.getPair([tokenAddress, BSC_USDC])) as Address;
    if (pairAddress === zeroAddress) {
      await pancakeFactory.write.createPair([tokenAddress, BSC_USDC], { account: deployer.account });
      pairAddress = (await pancakeFactory.read.getPair([tokenAddress, BSC_USDC])) as Address;
    }
    await token.write.setPair([pairAddress, true], { account: deployer.account });
    await token.write.setMinAmounts([1n, 1n], { account: deployer.account });

    const deployerTcgv = await token.read.balanceOf([deployer.account.address]);
    const liqTcgv = deployerTcgv / 2n;
    const liqUsdc = 100_000n * 10n ** BigInt(USDC_DECIMALS);
    const dexDeadline = BigInt((await publicClient.getBlock()).timestamp) + 3600n;
    if (liqTcgv > 0n && deployerUsdcBal >= liqUsdc) {
      await token.write.approve([wrapper.address as Address, liqTcgv], { account: deployer.account });
      await usdc.write.approve([wrapper.address as Address, liqUsdc], { account: deployer.account });
      await wrapper.write.addLiquidity(
        [PANCAKE_ROUTER, BSC_USDC, liqTcgv, liqUsdc, 0n, 0n, dexDeadline],
        { account: deployer.account },
      );
      console.log(`Liquidity added: ${formatEther(liqTcgv)} TCGV + ${Number(liqUsdc) / 1e6} USDC`);
    }

    const path = [BSC_USDC, tokenAddress];
    const swapUsdcAmount = 1_000n * 10n ** BigInt(USDC_DECIMALS);
    await usdc.write.approve([PANCAKE_ROUTER, swapUsdcAmount], { account: trader.account });
    const swapCalldata = encodeFunctionData({
      abi: pancakeRouter.abi,
      functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
      args: [swapUsdcAmount, 0n, path, trader.account.address, dexDeadline],
    });
    await trader.sendTransaction({ to: PANCAKE_ROUTER, data: swapCalldata, value: 0n });
    const traderTcgvAfter = await token.read.balanceOf([trader.account.address]);
    console.log("After DEX buy (1000 USDC): trader TCGV", formatEther(traderTcgvAfter));

    // --- Phase 7.1: Buy via BuyRouter (USDC); TCGR rewards parrain enregistré sur TCGR (whitepaper) ---
    const buyUsdcAmount = 500n * 10n ** BigInt(USDC_DECIMALS);
    await tcgr.write.setReferrer([deployer.account.address], { account: trader.account });
    await usdc.write.approve([buyRouter.address as Address, buyUsdcAmount], { account: trader.account });
    const referrerTcgrBefore = await tcgr.read.balanceOf([deployer.account.address]);
    await buyRouter.write.buyTCGVWithUSDC([buyUsdcAmount, 0n, dexDeadline], {
      account: trader.account,
    });
    const referrerTcgrAfter = await tcgr.read.balanceOf([deployer.account.address]);
    const tcgrDelta = referrerTcgrAfter - referrerTcgrBefore;
    console.log("Buy via BuyRouter (USDC) with referrer=deployer: 500 USDC → referrer TCGR:", formatEther(tcgrDelta));

    // --- Phase 7.2: Convert TCGR → TCGV ---
    const deployerTcgrBal = await tcgr.read.balanceOf([deployer.account.address]);
    if (deployerTcgrBal > 0n) {
      const fundAmount = parseEther("5000");
      const traderTcgvBal = await token.read.balanceOf([trader.account.address]);
      if (traderTcgvBal >= fundAmount) {
        await token.write.transfer([converterAddress, fundAmount], { account: trader.account });
        const targetConvertAmount = deployerTcgrBal / 2n;
        if (targetConvertAmount > 0n) {
          let unlockedTcgr = await tcgr.read.unlockedReferralBalance([deployer.account.address]);
          if (unlockedTcgr < targetConvertAmount) {
            const bucket = await tcgr.read.REFERRAL_VESTING_BUCKET();
            console.log(
              "TCGR unlock before convert:",
              formatEther(unlockedTcgr),
              "available, target",
              formatEther(targetConvertAmount),
              "→ warping one vesting bucket",
            );
            try {
              if (networkHelpers?.time) {
                await networkHelpers.time.increase(Number(bucket) + 1);
                await networkHelpers.mine();
              } else {
                const rpc = publicClient as { request: (args: { method: string; params: unknown[] }) => Promise<unknown> };
                await rpc.request({ method: "evm_increaseTime", params: [Number(bucket) + 1] });
                await rpc.request({ method: "evm_mine", params: [] });
              }
            } catch (e) {
              console.warn("Could not warp for TCGR unlock; conversion will use current unlocked amount:", e instanceof Error ? e.message : e);
            }
            unlockedTcgr = await tcgr.read.unlockedReferralBalance([deployer.account.address]);
          }

          const convertAmount = unlockedTcgr < targetConvertAmount ? unlockedTcgr : targetConvertAmount;
          if (convertAmount > 0n) {
            const deployerTcgvBefore = await token.read.balanceOf([deployer.account.address]);
            await tcgr.write.approve([converterAddress, convertAmount], { account: deployer.account });
            await converter.write.convert([convertAmount, convertAmount], { account: deployer.account });
            const deployerTcgvAfter = await token.read.balanceOf([deployer.account.address]);
            const tcgvOut = deployerTcgvAfter - deployerTcgvBefore;
            console.log("Convert TCGR→TCGV: burned", formatEther(convertAmount), "TCGR → received", formatEther(tcgvOut), "TCGV (1:1)");
            if (tcgvOut !== convertAmount) throw new Error(`Converter ratio mismatch: expected ${convertAmount}, got ${tcgvOut}`);
          } else {
            console.log("Convert TCGR→TCGV skipped: no unlocked TCGR available after vesting check.");
          }
        }
      }
    }
  } catch (e) {
    console.warn("Phase 7 (DEX) skipped or failed (need BSC fork with PancakeSwap + USDC):", e instanceof Error ? e.message : e);
  }
  console.log();

  console.log("=".repeat(80));
  console.log("Full flow summary");
  console.log("=".repeat(80));
  console.log("Token:      ", tokenAddress);
  console.log("Nexus:      ", nexusTokenAddress);
  console.log("TCGR (ref): ", tcgrAddress);
  console.log("Founder NFT:", founderNFTAddress);
  console.log("InitialLaunch:", initialLaunchAddress);
  console.log("Presale → Finalize → Claim → DEX buy + referral (TCGR) completed successfully.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

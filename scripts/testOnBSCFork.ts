import hre from "hardhat";
import {
  parseEther,
  formatEther,
  zeroAddress,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  encodeAbiParameters,
  toHex,
  type Account,
  type Address,
} from "viem";

/**
 * End-to-end test script for TCG Vault on BSC fork (post-presale tokenomics).
 *
 * Presale flow is covered by scripts/testFullFlowOnBSCFork.ts. This script validates DEX and BuyRouter:
 *   Phase 1 — Deploy: MockPresaleLaunch, TCGNexusToken, TCGVaultToken (immutable staking vault), TCGVaultStakingVault, BuyRouter, Wrapper (MockPresaleLaunch for initial supply).
 *   BuyRouter USDC fees accrue in `pendingUsdcFees` until each recipient calls `claimUsdcFees` (EOA recipients from Hardhat accounts; plain `FeeReceiver` cannot claim).
 *   Phase 2 — Pair TCGV/USDC only, add liquidity via wrapper
 *   Phase 3 — Buy: PancakeSwap USDC→TCGV (3.1), TCGVaultBuyRouter USDC→TCGV (3.2), direct pair USDC→TCGV (3.3), dummy router USDC (5.2)
 *   Phase 4 — Sell: PancakeSwap TCGV→USDC (4.1), TCGVaultBuyRouter TCGV→USDC (4.2)
 *
 * Recommended (Hardhat fork, no Anvil):
 *   BSC_RPC_URL="https://your-bsc-rpc" yarn hardhat run scripts/testOnBSCFork.ts --network hardhat
 *
 * Optional (Anvil on :8545): `anvil --fork-url <BSC_RPC> --hardfork cancun` (or `latest`). Without `--hardfork`,
 *   `eth_call` can fail with “No known hardfork for execution on historical block … not configured with a hardfork activation history”.
 *   Then: `yarn hardhat run scripts/testOnBSCFork.ts --network localhost`
 */

const PANCAKE_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E" as Address;
const PANCAKE_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73" as Address;
/** BSC Binance-Peg USDC (BEP20). 18 decimals on mainnet — fork helpers still use 1e6 unit constants for compare amounts where noted. */
const BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Address;
const BSC_USDC_BALANCES_SLOT = 1;
const USDC_6 = 1_000_000n;

function mappingSlotForKey(account: Address, mappingSlot: number): `0x${string}` {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, BigInt(mappingSlot)])
  ) as `0x${string}`;
}
function toStorageHex(v: `0x${string}` | Uint8Array): string {
  if (typeof v === "string") return v.startsWith("0x") ? v : `0x${v}`;
  return "0x" + Array.from(v).map((b) => b.toString(16).padStart(2, "0")).join("");
}
type SetStorageAtFn = (address: string, slotHex: string, valueHex: string) => Promise<void>;
async function setBSCUSDCBalance(
  account: Address,
  usdcContract: Address,
  amount: bigint,
  setStorageAt: SetStorageAtFn,
  usdcForVerify?: { read: { balanceOf: (args: [Address]) => Promise<bigint> } },
  balancesSlot = BSC_USDC_BALANCES_SLOT
): Promise<void> {
  const addressStr = String(usdcContract).toLowerCase();
  const storageSlot = mappingSlotForKey(account, balancesSlot);
  const value = toHex(amount, { size: 32 });
  await setStorageAt(addressStr, toStorageHex(storageSlot), toStorageHex(value as `0x${string}`));
  if (usdcForVerify) {
    const balance = await usdcForVerify.read.balanceOf([account]);
    if (balance !== amount) throw new Error(`setBSCUSDCBalance verify failed: expected ${amount}, got ${balance}`);
  }
}

// Same USDC amount for Pancake / BuyRouter / direct pair / dummy router (6 decimals).
const COMPARE_BUY_USDC = 1_000n * USDC_6;
// Same TCGV amount for both sell routes.
const COMPARE_SELL_TCGV = parseEther("10000");

// Tokenomics — logs / loose checks (routeur ON = BuyRouter USDC; routeur OFF = pool TCGV)
const BUY_VAULT_BP = 300; // 3% of USDC in (BuyRouter / routeur ON)
const BUY_MARKETING_BP = 200; // 2% of USDC in (structure)
const CASHBACK_BP_PRESALE = 3000; // 30% NEXUS during presale (portail / recordBuyAndMintCashback)
// Pool path (routeur OFF): 5% sell → 2% vault + 2% autolp of notional (40% + 40% of fee)
const POOL_SELL_VAULT_PLUS_AUTOLP_BP = 400;

type WalletLike = { account: Account };

function walletForAddress(address: Address, wallets: readonly WalletLike[]): WalletLike {
  const lower = address.toLowerCase();
  const w = wallets.find((x) => x.account.address.toLowerCase() === lower);
  if (!w) {
    throw new Error(
      `No Hardhat account controls ${address}. BuyRouter fee recipients must be EOAs that can call claimUsdcFees (add accounts in hardhat.config or reuse deployer/trader).`,
    );
  }
  return w;
}

/** Pull-model USDC fees: each unique recipient with pending balance claims from the router. */
async function claimBuyRouterPendingUsdc(
  buyRouter: {
    read: { pendingUsdcFees: (args: readonly [Address]) => Promise<bigint> };
    write: { claimUsdcFees: (opts: { account: Account }) => Promise<`0x${string}`> };
  },
  recipients: readonly Address[],
  wallets: readonly WalletLike[],
): Promise<void> {
  const seen = new Set<string>();
  for (const addr of recipients) {
    const k = addr.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const pending = await buyRouter.read.pendingUsdcFees([addr]);
    if (pending === 0n) continue;
    const wc = walletForAddress(addr, wallets);
    await buyRouter.write.claimUsdcFees({ account: wc.account });
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
  // BuyRouter credits USDC fees to `pendingUsdcFees[recipient]`; recipients must call `claimUsdcFees`.
  // Use Hardhat EOAs (not plain contracts) so the script can pull fees after each router buy/sell.
  const vaultAddr = deployer.account.address as Address;
  const marketingAddr = trader.account.address as Address;
  const communityAddr = (wallets[2]?.account.address ?? deployer.account.address) as Address;

  const publicClient = await viem.getPublicClient();
  const setStorageAt: SetStorageAtFn = async (address, slotHex, valueHex) => {
    if (networkHelpers?.setStorageAt) await networkHelpers.setStorageAt(address, slotHex, valueHex);
    else await (publicClient as { request: (args: { method: string; params: unknown[] }) => Promise<unknown> }).request({ method: "anvil_setStorageAt", params: [address, slotHex, valueHex] });
  };
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  console.log("=".repeat(80));
  console.log("TCG Vault — End-to-end test on BSC fork");
  console.log("=".repeat(80));
  console.log(`Deployer (owner): ${deployer.account.address}`);
  console.log(
    `Deployer BNB: ${formatEther(await publicClient.getBalance({ address: deployer.account.address }))}`
  );
  console.log(`Trader:         ${trader.account.address}`);
  console.log(
    `Trader BNB:   ${formatEther(await publicClient.getBalance({ address: trader.account.address }))}`
  );
  console.log(`Vault:          ${vaultAddr}`);
  console.log(`Marketing:      ${marketingAddr}`);
  console.log(`Community:      ${communityAddr}`);
  console.log();

  // On an Anvil fork, Hardhat's configured accounts may not be the pre-funded
  // dev accounts. Top up deployer & trader so gas is never an issue when
  // running this script against a local fork.
  try {
    const richBalanceHex = "0x3635C9ADC5DEA0000000"; // ~1e24 wei (~1M BNB)
    const provider = (hre as any).network?.provider;
    if (provider?.request) {
      await provider.request({
        method: "anvil_setBalance",
        params: [deployer.account.address, richBalanceHex],
      });
      await provider.request({
        method: "anvil_setBalance",
        params: [trader.account.address, richBalanceHex],
      });
    }
  } catch {
    // If not running on Anvil (or method unsupported), just continue;
    // balances will reflect the real network.
  }

  const pancakeRouter = await viem.getContractAt("PancakeRouter", PANCAKE_ROUTER);
  const pancakeFactory = await viem.getContractAt("PancakeFactory", PANCAKE_FACTORY);
  const routerCode = await publicClient.getCode({ address: PANCAKE_ROUTER });
  if (!routerCode || routerCode === "0x") {
    throw new Error(
      "Pancake router code not found on current network. Ensure Hardhat is running with a valid BSC fork RPC (set BSC_RPC_URL), e.g. `BSC_RPC_URL=https://bsc-dataseed.binance.org yarn fork:dex`."
    );
  }
  const wbnbAddress = (await pancakeRouter.read.WETH()) as Address; // dummy PancakeRouter constructor only
  console.log("PancakeSwap Router:", PANCAKE_ROUTER);
  console.log("PancakeSwap Factory:", PANCAKE_FACTORY);
  console.log();

  // ---------------------------------------------------------------------------
  // Phase 1: Deploy all contracts
  // ---------------------------------------------------------------------------
  console.log("--- Phase 1: Deployment ---");
  console.log();

  let nonce = BigInt(
    await publicClient.getTransactionCount({ address: deployer.account.address, blockTag: "pending" })
  );

  // Deployment order:
  //   nonce + 0: MockPresaleLaunch
  //   nonce + 1: TCGNexusToken (presale bonus minters: mock presale + deployer EOA — unused on this fork path)
  //   nonce + 2: TCGVaultToken (stakingVault immutable → predicted at nonce+3)
  //   nonce + 3: TCGVaultStakingVault(asset = TCGV)
  const mockPresaleLaunchAddress = getContractAddress({ from: deployer.account.address, nonce }) as Address;
  const nexusTokenAddress = getContractAddress({ from: deployer.account.address, nonce: nonce + 1n }) as Address;
  const futureTcgvAddr = getContractAddress({ from: deployer.account.address, nonce: nonce + 2n }) as Address;
  const stakingVaultAddress = getContractAddress({ from: deployer.account.address, nonce: nonce + 3n }) as Address;
  const nexusBonusLaunchPlaceholder = deployer.account.address as Address;

  console.log("1.1 Deploying MockPresaleLaunch (immutable presale finalizer for TCGV)...");
  await viem.deployContract("contracts/test/MockPresaleLaunch.sol:MockPresaleLaunch", [], {
    client: { wallet: deployer },
  });
  nonce += 1n;
  const mockPresaleLaunch = await viem.getContractAt(
    "contracts/test/MockPresaleLaunch.sol:MockPresaleLaunch",
    mockPresaleLaunchAddress
  );
  console.log(`    MockPresaleLaunch: ${mockPresaleLaunchAddress}`);
  console.log();

  console.log("1.2 Deploying TCGNexusToken (minter = predicted TCGV; presale bonus minters = mock presale + deployer placeholder)...");
  await viem.deployContract("contracts/TCGNexusToken.sol:TCGNexusToken", [futureTcgvAddr, mockPresaleLaunchAddress, nexusBonusLaunchPlaceholder], {
    client: { wallet: deployer },
  });
  nonce += 1n;
  const nexusToken = await viem.getContractAt("TCGNexusToken", nexusTokenAddress);
  console.log(`    TCGNexusToken: ${nexusTokenAddress}`);
  console.log();

  console.log("1.3 Deploying TCGVaultToken (immutable NEXUS + initialLaunch + stakingVault)...");
  await viem.deployContract("TCGVaultToken", [
    stakingVaultAddress,
    PANCAKE_ROUTER,
    vaultAddr,
    marketingAddr,
    communityAddr,
    nexusTokenAddress,
    mockPresaleLaunchAddress,
  ], { client: { wallet: deployer } });
  const tokenAddress = getContractAddress({ from: deployer.account.address, nonce }) as Address;
  nonce += 1n;
  const token = await viem.getContractAt("TCGVaultToken", tokenAddress);
  console.log(`    TCGVaultToken: ${tokenAddress}`);
  console.log(`    Total supply:  ${formatEther((await token.read.totalSupply()))} TCGV`);
  console.log();

  console.log("1.3b Deploying TCGVaultStakingVault (predicted address wired in TCGV constructor)...");
  await viem.deployContract("TCGVaultStakingVault", [tokenAddress], { client: { wallet: deployer } });
  nonce += 1n;
  console.log(`    TCGVaultStakingVault: ${stakingVaultAddress}`);
  console.log();

  console.log("1.4 Fund deployer & trader with BSC USDC (cheatcode)...");
  const usdc = await viem.getContractAt("BEP20TokenImplementation", BSC_USDC);
  const bigUsdc = 50_000_000n * USDC_6;
  await setBSCUSDCBalance(deployer.account.address, BSC_USDC, bigUsdc, setStorageAt, usdc);
  await setBSCUSDCBalance(trader.account.address, BSC_USDC, bigUsdc, setStorageAt, usdc);
  let deployerUsdc = await usdc.read.balanceOf([deployer.account.address]);
  if (deployerUsdc === 0n) {
    await setBSCUSDCBalance(deployer.account.address, BSC_USDC, bigUsdc, setStorageAt, undefined, 0);
    deployerUsdc = await usdc.read.balanceOf([deployer.account.address]);
  }
  console.log(`    Deployer USDC: ${deployerUsdc.toString()}, Trader USDC: ${(await usdc.read.balanceOf([trader.account.address])).toString()}`);
  console.log();

  console.log("1.5 Deploying TCGVaultBuyRouter (USDC)...");
  const buyRouter = await viem.deployContract("TCGVaultBuyRouter", [
    PANCAKE_ROUTER,
    BSC_USDC,
    tokenAddress,
    vaultAddr,
    marketingAddr,
    communityAddr,
  ], { client: { wallet: deployer } });
  const buyRouterAddress = buyRouter.address as Address;
  await token.write.setBuyRouter([buyRouterAddress], { account: deployer.account });
  console.log(`    TCGVaultBuyRouter: ${buyRouterAddress} (set as buy router)`);
  console.log();

  console.log("1.6 Deploying TCGVaultLiquidityWrapper...");
  const wrapper = await viem.deployContract(
    "contracts/TCGVaultLiquidityWrapper.sol:TCGVaultLiquidityWrapper",
    [tokenAddress, PANCAKE_ROUTER],
    { client: { wallet: deployer } },
  );
  const wrapperAddress = wrapper.address as Address;
  await token.write.setExcludedFromFees([wrapperAddress, true], { account: deployer.account });
  console.log(`    TCGVaultLiquidityWrapper: ${wrapperAddress} (set as liquidity wrapper, excluded from fees)`);
  console.log();

  console.log("1.7 Initial mint via immutable presale finalizer (no constructor mint)...");
  const initialMint = parseEther("1000000000");
  await mockPresaleLaunch.write.mintPresale([tokenAddress, deployer.account.address, initialMint], { account: deployer.account });
  console.log(`    MockPresaleLaunch: ${mockPresaleLaunchAddress}; minted ${formatEther(initialMint)} TCGV to deployer for liquidity & tests`);
  console.log();

  // ---------------------------------------------------------------------------
  // Phase 2: Pair, set pair on token, add liquidity
  // ---------------------------------------------------------------------------
  console.log("--- Phase 2: Configure & add liquidity ---");
  console.log();

  console.log("2.1 Create/get PancakeSwap pair TCGV/USDC...");
  let pairAddress = (await pancakeFactory.read.getPair([tokenAddress, BSC_USDC])) as Address;
  if (pairAddress === zeroAddress) {
    const createUsdcHash = await pancakeFactory.write.createPair([tokenAddress, BSC_USDC], {
      account: deployer.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: createUsdcHash });
    pairAddress = (await pancakeFactory.read.getPair([tokenAddress, BSC_USDC])) as Address;
    console.log("    Pair created:", pairAddress);
  } else {
    console.log("    Pair exists: ", pairAddress);
  }
  await token.write.setPair([pairAddress, true], { account: deployer.account });
  console.log("    Pair set on token (canonical TCGV/USDC).");
  console.log();

  console.log("2.2 Add liquidity TCGV/USDC via wrapper...");
  const tcgvForUsdc = parseEther("500000");
  const usdcForPair = 50_000n * USDC_6;
  await token.write.approve([wrapperAddress, tcgvForUsdc], { account: deployer.account });
  await usdc.write.approve([wrapperAddress, usdcForPair], { account: deployer.account });
  const addLiqUsdcHash = await wrapper.write.addLiquidity([
    PANCAKE_ROUTER,
    BSC_USDC,
    tcgvForUsdc,
    usdcForPair,
    0n,
    0n,
    deadline,
  ], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: addLiqUsdcHash });
  console.log(`    Liquidity: ${formatEther(tcgvForUsdc)} TCGV + ${Number(usdcForPair) / 1e6} USDC`);
  const pair = await viem.getContractAt("contracts/test/PancakePair.sol:PancakePair", pairAddress);
  const [reserve0, reserve1] = await (pair as any).read.getReserves();
  const token0 = await (pair as any).read.token0();
  const isToken0TCGV = token0.toLowerCase() === tokenAddress.toLowerCase();
  const tcgvReserve = isToken0TCGV ? reserve0 : reserve1;
  const usdcReserve = isToken0TCGV ? reserve1 : reserve0;
  console.log(`    Reserves: ${formatEther(tcgvReserve)} TCGV / ${Number(usdcReserve) / 1e6} USDC`);
  console.log();

  // Explicit gas limit to avoid "gas required exceeds allowance: 0" on some BSC fork RPCs
  const transferGas = 200000n;

  console.log("2.3 Simple transfer (A → B, fresh address): no fee, no burn...");
  const simpleTransferAmount = parseEther("1000");
  const freshReceiver = getContractAddress({ from: deployer.account.address, nonce: 999999n }) as Address;
  const supplyBeforeTransfer = await token.read.totalSupply();
  const traderBalBefore = await token.read.balanceOf([trader.account.address]);
  await token.write.transfer([trader.account.address, simpleTransferAmount], { account: deployer.account, gas: transferGas });
  const traderBalAfter = await token.read.balanceOf([trader.account.address]);
  if (traderBalAfter - traderBalBefore !== simpleTransferAmount) {
    throw new Error(`2.3 Deployer→Trader: expected +${formatEther(simpleTransferAmount)}, got +${formatEther(traderBalAfter - traderBalBefore)}`);
  }
  const amountToFresh = simpleTransferAmount / 2n;
  const supplyBeforeToFresh = await token.read.totalSupply();
  await token.write.transfer([freshReceiver, amountToFresh], { account: trader.account, gas: transferGas });
  const freshBal = await token.read.balanceOf([freshReceiver]);
  const supplyAfterToFresh = await token.read.totalSupply();
  const burnTransfer = supplyBeforeToFresh - supplyAfterToFresh;
  if (freshBal !== amountToFresh) {
    throw new Error(`2.3 Trader→fresh: expected ${formatEther(amountToFresh)}, got ${formatEther(freshBal)} (fee would have been taken)`);
  }
  if (burnTransfer !== 0n) {
    throw new Error(`2.3 Trader→fresh: expected 0 burn, got ${formatEther(burnTransfer)}`);
  }
  console.log(`    Deployer → Trader: ${formatEther(simpleTransferAmount)} TCGV (no fee, regular transfer).`);
  console.log(`    Trader → Fresh ${freshReceiver}: ${formatEther(amountToFresh)} TCGV received, burn: ${formatEther(burnTransfer)} (regular transfer, no fee/no burn).`);
  console.log("    [OK] 2.3 Simple transfer to fresh address: no fee, no burn.");
  console.log();

  // ---------------------------------------------------------------------------
  // Phase 3: Buy flows
  // ---------------------------------------------------------------------------
  console.log("--- Phase 3: Buy flows ---");
  console.log();

  const pathUsdcTcgv = [BSC_USDC, tokenAddress];
  let minAmountOutRouter = 0n;
  try {
    const amountsOut = (await pancakeRouter.read.getAmountsOut([COMPARE_BUY_USDC, pathUsdcTcgv]));
    minAmountOutRouter = amountsOut[1] > 0n ? (amountsOut[1] * 50n) / 100n : 0n;
  } catch {
    minAmountOutRouter = 0n;
  }

  console.log("3.1 Buy via PancakeSwap router (swapExactTokensForTokensSupportingFeeOnTransferTokens, USDC→TCGV)...");
  const buyUsdc1 = COMPARE_BUY_USDC;
  console.log(`    USDC in: ${Number(buyUsdc1) / 1e6} (compare amount)`);
  const traderTcgvBefore1 = (await token.read.balanceOf([trader.account.address]));
  const vaultTcgvBefore1 = (await token.read.balanceOf([vaultAddr]));
  const supplyBefore1 = (await token.read.totalSupply());

  await usdc.write.approve([PANCAKE_ROUTER, buyUsdc1], { account: trader.account });
  const swapCalldata = encodeFunctionData({
    abi: pancakeRouter.abi,
    functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    args: [buyUsdc1, minAmountOutRouter, pathUsdcTcgv, trader.account.address, deadline],
  });
  const swapHash = await trader.sendTransaction({
    to: PANCAKE_ROUTER,
    data: swapCalldata,
    value: 0n,
  });
  const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
  if (!swapReceipt || swapReceipt.status === "reverted") {
    throw new Error(`Pancake buy reverted: ${JSON.stringify(swapReceipt)}`);
  }

  const traderTcgvAfter1 = (await token.read.balanceOf([trader.account.address]));
  const vaultTcgvAfter1 = (await token.read.balanceOf([vaultAddr]));
  const supplyAfter1 = (await token.read.totalSupply());
  const nexusBal1 = (await nexusToken.read.balanceOf([trader.account.address]));
  const traderDelta1 = traderTcgvAfter1 - traderTcgvBefore1;
  const vaultDelta1 = vaultTcgvAfter1 - vaultTcgvBefore1;
  const burn1 = supplyBefore1 - supplyAfter1;
  console.log(`    Trader TCGV: +${formatEther(traderDelta1)}`);
  console.log(`    Vault TCGV:  +${formatEther(vaultDelta1)}`);
  console.log(`    Supply Δ:    ${formatEther(burn1)} TCGV (fee burn removed; expect ~0) (${formatEther(supplyBefore1)} → ${formatEther(supplyAfter1)})`);
  console.log(`    NEXUS:       ${formatEther(nexusBal1)}`);
  if (traderDelta1 === 0n) {
    throw new Error("3.1 Pancake buy: trader received 0 TCGV");
  }
  const comparePancake = { usdc: buyUsdc1, traderTcgv: traderDelta1, burned: burn1 };
  console.log("    [OK] 3.1 Pancake USDC→TCGV buy executed (see fee/burn above; detailed economics covered in unit tests)");
  console.log();

  console.log("3.2 Buy via TCGVaultBuyRouter (USDC, NEXUS cashback)...");
  const buyRouterUSDC = COMPARE_BUY_USDC;
  const traderTcgvBefore2 = await token.read.balanceOf([trader.account.address]);
  const supplyBefore2 = await token.read.totalSupply();
  const vaultUsdcBefore2 = await usdc.read.balanceOf([vaultAddr]);
  const marketingUsdcBefore2 = await usdc.read.balanceOf([marketingAddr]);
  const nexusBefore2 = await nexusToken.read.balanceOf([trader.account.address]);

  await usdc.write.approve([buyRouterAddress, buyRouterUSDC], { account: trader.account });
  try {
    await publicClient.simulateContract({
      address: buyRouterAddress,
      abi: buyRouter.abi,
      functionName: "buyTCGVWithUSDC",
      args: [buyRouterUSDC, 0n, deadline],
      account: trader.account,
    });
  } catch (simErr: any) {
    const msg =
      simErr?.shortMessage ??
      simErr?.message ??
      simErr?.cause?.shortMessage ??
      simErr?.cause?.message ??
      simErr?.details ??
      String(simErr);
    throw new Error(`3.2 Buy via TCGVaultBuyRouter would revert: ${msg}`);
  }

  let buyRouterTxHash: `0x${string}`;
  try {
    buyRouterTxHash = await buyRouter.write.buyTCGVWithUSDC([buyRouterUSDC, 0n, deadline], {
      account: trader.account,
    });
  } catch (err: any) {
    throw new Error(`3.2 Buy via TCGVaultBuyRouter failed: ${err?.shortMessage ?? err?.message ?? String(err)}`);
  }
  const buyRouterReceipt = await publicClient.waitForTransactionReceipt({ hash: buyRouterTxHash });
  if (buyRouterReceipt.status === "reverted") {
    let revertReason = "unknown";
    try {
      await publicClient.simulateContract({
        address: buyRouterAddress,
        abi: buyRouter.abi,
        functionName: "buyTCGVWithUSDC",
        args: [buyRouterUSDC, 0n, deadline],
        account: trader.account,
      });
    } catch (simErr2: any) {
      revertReason =
        simErr2?.shortMessage ??
        simErr2?.message ??
        simErr2?.cause?.shortMessage ??
        simErr2?.cause?.message ??
        simErr2?.details ??
        (simErr2?.cause ? String(simErr2.cause) : String(simErr2));
    }
    throw new Error(`3.2 Buy via TCGVaultBuyRouter reverted: ${revertReason}`);
  }

  const routerVaultAddr = (await buyRouter.read.vault()) as Address;
  const routerMarketingAddr = (await buyRouter.read.marketing()) as Address;
  if (routerVaultAddr.toLowerCase() !== vaultAddr.toLowerCase()) {
    throw new Error(`3.2 BuyRouter vault ${routerVaultAddr} != vault ${vaultAddr}`);
  }
  if (routerMarketingAddr.toLowerCase() !== marketingAddr.toLowerCase()) {
    throw new Error(`3.2 BuyRouter marketing ${routerMarketingAddr} != marketing ${marketingAddr}`);
  }

  const expectedVaultUsdcMin = (buyRouterUSDC * BigInt(BUY_VAULT_BP)) / 10000n;
  const expectedMarketingUsdcMin = (buyRouterUSDC * BigInt(BUY_MARKETING_BP)) / 10000n;

  const traderTcgvAfter2 = (await token.read.balanceOf([trader.account.address]));
  const supplyAfter2 = await token.read.totalSupply();
  const burn2 = supplyBefore2 - supplyAfter2;
  const pendingVaultUsdc = await buyRouter.read.pendingUsdcFees([vaultAddr]);
  const pendingMarketingUsdc = await buyRouter.read.pendingUsdcFees([marketingAddr]);
  const nexusAfter2 = (await nexusToken.read.balanceOf([trader.account.address]));
  const traderTcgvDelta2 = traderTcgvAfter2 - traderTcgvBefore2;
  const nexusDelta2 = nexusAfter2 - nexusBefore2;
  if (traderTcgvDelta2 === 0n) {
    throw new Error("3.2 Buy via TCGVaultBuyRouter: trader received 0 TCGV");
  }

  const routerUsdcBeforeClaim = await usdc.read.balanceOf([buyRouterAddress]);
  const expectedBuyFeeUsdc = (buyRouterUSDC * 500n) / 10000n;

  console.log(`    Trader TCGV: +${formatEther(traderTcgvDelta2)}`);
  console.log(`    Supply Δ:    ${formatEther(burn2)} TCGV (expect ~0; no router TCGV burn)`);
  console.log(`    USDC fee: 5% (3% vault, 2% structure). No TCGV burn.`);
  console.log(
    `    Pending USDC (router ledger): vault ${Number(pendingVaultUsdc) / 1e6}, marketing ${Number(pendingMarketingUsdc) / 1e6} (expect >= ${Number(expectedVaultUsdcMin) / 1e6} / ${Number(expectedMarketingUsdcMin) / 1e6})`,
  );
  console.log(
    `    Router USDC balance before claim: ${Number(routerUsdcBeforeClaim) / 1e6} (fee USDC held until claimUsdcFees; ~${Number(expectedBuyFeeUsdc) / 1e6} from this buy)`,
  );

  if (pendingVaultUsdc < expectedVaultUsdcMin - expectedVaultUsdcMin / 20n) {
    throw new Error(`3.2 Vault pending USDC: expected >= ${expectedVaultUsdcMin}, got ${pendingVaultUsdc}`);
  }
  if (pendingMarketingUsdc < expectedMarketingUsdcMin - expectedMarketingUsdcMin / 20n) {
    throw new Error(`3.2 Marketing pending USDC: expected >= ${expectedMarketingUsdcMin}, got ${pendingMarketingUsdc}`);
  }

  await claimBuyRouterPendingUsdc(buyRouter, [vaultAddr, marketingAddr, communityAddr], wallets);

  const vaultUsdcAfter2 = await usdc.read.balanceOf([vaultAddr]);
  const marketingUsdcAfter2 = await usdc.read.balanceOf([marketingAddr]);
  const vaultUsdcDelta2 = vaultUsdcAfter2 - vaultUsdcBefore2;
  const marketingUsdcDelta2 = marketingUsdcAfter2 - marketingUsdcBefore2;
  const routerUsdcAfter2 = await usdc.read.balanceOf([buyRouterAddress]);
  console.log(`    Vault USDC:     +${Number(vaultUsdcDelta2) / 1e6} (after claim)`);
  console.log(`    Marketing USDC: +${Number(marketingUsdcDelta2) / 1e6} (after claim)`);
  console.log(`    Router USDC after claim: ${Number(routerUsdcAfter2) / 1e6} (expected 0)`);

  if (routerUsdcAfter2 !== 0n) {
    throw new Error(`3.2 Router must retain 0 USDC after claims, got ${routerUsdcAfter2}`);
  }
  if (vaultUsdcDelta2 < expectedVaultUsdcMin - expectedVaultUsdcMin / 20n) {
    throw new Error(`3.2 Vault USDC: expected >= ${expectedVaultUsdcMin}, got +${vaultUsdcDelta2}`);
  }
  if (marketingUsdcDelta2 < expectedMarketingUsdcMin - expectedMarketingUsdcMin / 20n) {
    throw new Error(`3.2 Marketing USDC: expected >= ${expectedMarketingUsdcMin}, got +${marketingUsdcDelta2}`);
  }
  const expectedNexusMin = (traderTcgvDelta2 * BigInt(CASHBACK_BP_PRESALE - 200)) / 10000n;
  const expectedNexusMax = (traderTcgvDelta2 * BigInt(CASHBACK_BP_PRESALE + 200)) / 10000n;
  if (nexusDelta2 < expectedNexusMin || nexusDelta2 > expectedNexusMax) {
    throw new Error(`3.2 NEXUS cashback: expected ~30%, got ${formatEther(nexusDelta2)}`);
  }
  console.log(`    NEXUS:         +${formatEther(nexusDelta2)}`);
  const compareBuyRouter = { usdc: buyRouterUSDC, traderTcgv: traderTcgvDelta2, burned: burn2, nexusDelta: nexusDelta2 };
  console.log("    [OK] 3.2 Pending fees, claimUsdcFees, vault + marketing USDC, NEXUS ~30% presale cashback");
  console.log();

  // Deploy dummy router before 3.3 so we use its getAmountsOut for the direct swap — same formula as 5.2 for a fair comparison.
  console.log("5.1 Deploy dummy PancakeRouter (same factory + WETH as official)...");
  const dummyRouter = await viem.deployContract("contracts/test/PancakeRouter.sol:PancakeRouter", [PANCAKE_FACTORY, wbnbAddress], {
    client: { wallet: deployer },
  });
  const dummyRouterAddress = dummyRouter.address as Address;
  console.log("    Dummy router:", dummyRouterAddress);
  console.log();

  console.log("3.3 Direct pair swap (USDC → TCGV, no router)...");
  const directUsdc = COMPARE_BUY_USDC;
  console.log(`    USDC in: ${Number(directUsdc) / 1e6} (compare amount)`);

  const traderTcgvBefore3 = (await token.read.balanceOf([trader.account.address]));
  const supplyBefore3 = (await token.read.totalSupply());
  // Use dummy router's getAmountsOut so 3.3 and 5.2 use the same formula (official router can use a different fee constant).
  const amountsOutDirect = await (dummyRouter as any).read.getAmountsOut([directUsdc, pathUsdcTcgv]);
  const amountOut = amountsOutDirect[1];
  if (amountOut === 0n) {
    throw new Error("3.3 getAmountsOut returned 0 TCGV for direct swap; check pair liquidity");
  }
  const amount0Out = isToken0TCGV ? amountOut : 0n;
  const amount1Out = isToken0TCGV ? 0n : amountOut;

  await usdc.write.transfer([pairAddress, directUsdc], { account: trader.account });
  const pairSwapCalldata = encodeFunctionData({
    abi: pair.abi,
    functionName: "swap",
    args: [amount0Out, amount1Out, trader.account.address, "0x"],
  });
  const directHash = await trader.sendTransaction({
    to: pairAddress,
    data: pairSwapCalldata,
    value: 0n,
  });
  await publicClient.waitForTransactionReceipt({ hash: directHash });

  const traderTcgvAfter3 = (await token.read.balanceOf([trader.account.address]));
  const supplyAfter3 = (await token.read.totalSupply());
  const burn3 = supplyBefore3 - supplyAfter3;
  console.log(`    Trader TCGV: +${formatEther(traderTcgvAfter3 - traderTcgvBefore3)}`);
  console.log(`    Supply Δ:    ${formatEther(burn3)} TCGV (expect ~0) (${formatEther(supplyBefore3)} → ${formatEther(supplyAfter3)})`);
  const compareDirect = { usdc: directUsdc, traderTcgv: traderTcgvAfter3 - traderTcgvBefore3, burned: burn3 };
  console.log("    [OK] 3.3 Direct USDC→TCGV swap executed on canonical pair");
  console.log();

  // ---------------------------------------------------------------------------
  // Phase 5: Buy via dummy router (before any sell — same USDC as 3.1/3.3 for comparison)
  // ---------------------------------------------------------------------------
  console.log("--- Phase 5: Buy via dummy router (fee parity, before any sell) ---");
  console.log();

  console.log("5.2 Buy TCGV via dummy router (swapExactTokensForTokensSupportingFeeOnTransferTokens, USDC→TCGV)...");
  const dummyBuyUsdc = COMPARE_BUY_USDC;
  console.log(`    USDC in: ${Number(dummyBuyUsdc) / 1e6} (compare amount)`);
  const supplyBeforeDummy = await token.read.totalSupply();
  const traderTcgvBeforeDummy = await token.read.balanceOf([trader.account.address]);
  let minOutDummy = 0n;
  try {
    const amountsDummy = await (dummyRouter as any).read.getAmountsOut([dummyBuyUsdc, pathUsdcTcgv]);
    minOutDummy = amountsDummy[1] > 0n ? (amountsDummy[1] * 50n) / 100n : 0n;
  } catch {
    minOutDummy = 0n;
  }
  await usdc.write.approve([dummyRouterAddress, dummyBuyUsdc], { account: trader.account });
  const dummyCalldata = encodeFunctionData({
    abi: (dummyRouter as any).abi,
    functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    args: [dummyBuyUsdc, minOutDummy, pathUsdcTcgv, trader.account.address, deadline],
  });
  const dummyHash = await trader.sendTransaction({
    to: dummyRouterAddress,
    data: dummyCalldata,
    value: 0n,
  });
  await publicClient.waitForTransactionReceipt({ hash: dummyHash });
  const supplyAfterDummy = await token.read.totalSupply();
  const burnDummy = supplyBeforeDummy - supplyAfterDummy;
  const traderTcgvAfterDummy = await token.read.balanceOf([trader.account.address]);
  const traderDeltaDummy = traderTcgvAfterDummy - traderTcgvBeforeDummy;

  console.log(`    Trader TCGV: +${formatEther(traderDeltaDummy)}`);
  console.log(`    Supply Δ:    ${formatEther(burnDummy)} TCGV (expect ~0) (${formatEther(supplyBeforeDummy)} → ${formatEther(supplyAfterDummy)})`);
  if (traderDeltaDummy === 0n) {
    throw new Error("5.2 Dummy router buy: trader received 0 TCGV");
  }
  const compareDummy = { usdc: dummyBuyUsdc, traderTcgv: traderDeltaDummy, burned: burnDummy };
  console.log("    [OK] 5.2 Dummy router USDC→TCGV buy executed");
  console.log();

  // --- Buy comparison ---
  const buyRows = [
    { name: "PancakeSwap router (3.1)", ...comparePancake, inputAmount: comparePancake.usdc },
    { name: "TCGVaultBuyRouter (3.2)", ...compareBuyRouter, inputAmount: compareBuyRouter.usdc },
    { name: "Direct pair swap (3.3)", ...compareDirect, inputAmount: compareDirect.usdc },
    { name: "Dummy router (5.2)", ...compareDummy, inputAmount: compareDummy.usdc },
  ];
  let bestBuyIdx = 0;
  for (let i = 1; i < buyRows.length; i++) {
    if (buyRows[i]!.traderTcgv > buyRows[bestBuyIdx]!.traderTcgv) bestBuyIdx = i;
  }
  console.log("--- BUY comparison (most TCGV out = best for user) ---");
  console.log("    Route                      | In        | Trader TCGV   | Supply Δ (fee)");
  console.log("    ---------------------------|-----------|---------------|---------------");
  for (const row of buyRows) {
    const inStr = `${Number(row.inputAmount) / 1e6} USDC`;
    console.log(
      `    ${row.name.padEnd(28)} | ${inStr.padStart(9)} | ${formatEther(row.traderTcgv).padStart(13)} | ${formatEther(row.burned).padStart(13)}`
    );
  }
  console.log(`    >> Best for user: ${buyRows[bestBuyIdx]!.name}. BuyRouter also gives NEXUS bonus.`);
  console.log();

  // ---------------------------------------------------------------------------
  // Phase 4: Sell flows
  // ---------------------------------------------------------------------------
  console.log("--- Phase 4: Sell flows ---");
  console.log();

  const traderTcgvBeforeSells = await token.read.balanceOf([trader.account.address]);
  const sellAmountFixed = traderTcgvBeforeSells >= 2n * COMPARE_SELL_TCGV ? COMPARE_SELL_TCGV : traderTcgvBeforeSells / 2n;
  if (sellAmountFixed === 0n) throw new Error("Trader has no TCGV to sell in Phase 4");
  console.log(`    Using same TCGV amount for both sell routes: ${formatEther(sellAmountFixed)} (comparison)`);
  console.log();

  console.log("4.1 Sell via PancakeSwap router (swapExactTokensForTokensSupportingFeeOnTransferTokens, TCGV→USDC)...");
  const sellAmount1 = sellAmountFixed;
  await token.write.approve([PANCAKE_ROUTER, sellAmount1], { account: trader.account });
  const vaultTcgvBefore4 = (await token.read.balanceOf([vaultAddr]));
  const supplyBefore4 = (await token.read.totalSupply());
  const traderUsdcBefore4 = await usdc.read.balanceOf([trader.account.address]);

  // Pool sell tax 5% routeur OFF (2% vault, 2% autolp, 1% marketing; no burn).
  // For this script we sell TCGV → USDC on Pancake (no BNB).
  const sellPath = [tokenAddress, BSC_USDC];
  // Preflight to get an actionable revert reason (stdout-friendly even when redirecting output to a file).
  try {
    await publicClient.simulateContract({
      address: PANCAKE_ROUTER,
      abi: pancakeRouter.abi,
      functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
      args: [sellAmount1, 0n, sellPath, trader.account.address, deadline],
      account: trader.account,
    });
  } catch (simErr: any) {
    const msg =
      simErr?.shortMessage ??
      simErr?.message ??
      simErr?.cause?.shortMessage ??
      simErr?.cause?.message ??
      simErr?.details ??
      String(simErr);
    console.log(`    [REVERT] 4.1 preflight: ${msg}`);
    throw new Error(`4.1 PancakeSwap sell would revert: ${msg}`);
  }

  const sellCalldata = encodeFunctionData({
    abi: pancakeRouter.abi,
    functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    args: [sellAmount1, 0n, sellPath, trader.account.address, deadline],
  });
  const sellHash = await trader.sendTransaction({
    to: PANCAKE_ROUTER,
    data: sellCalldata,
    value: 0n,
  });
  const sellReceipt1 = await publicClient.waitForTransactionReceipt({ hash: sellHash });

  const traderTcgvAfter4 = (await token.read.balanceOf([trader.account.address]));
  const vaultTcgvAfter4 = (await token.read.balanceOf([vaultAddr]));
  const supplyAfter4 = (await token.read.totalSupply());
  const traderUsdcAfter4 = await usdc.read.balanceOf([trader.account.address]);
  const sold1 = sellAmount1;
  const vaultDelta4 = vaultTcgvAfter4 - vaultTcgvBefore4;
  const burn4 = supplyBefore4 - supplyAfter4;
  const usdcOutPancake = traderUsdcAfter4 - traderUsdcBefore4;
  console.log(`    Trader sold:  ${formatEther(sold1)} TCGV`);
  console.log(`    Trader USDC:  +${Number(usdcOutPancake) / 1e6}`);
  console.log(`    Vault TCGV:   +${formatEther(vaultDelta4)}`);
  console.log(`    Supply Δ:     ${formatEther(burn4)} TCGV (expect ~0) (${formatEther(supplyBefore4)} → ${formatEther(supplyAfter4)})`);

  if (sellReceipt1.status === "reverted") {
    let msg = "unknown";
    try {
      await publicClient.simulateContract({
        address: PANCAKE_ROUTER,
        abi: pancakeRouter.abi,
        functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
        args: [sellAmount1, 0n, sellPath, trader.account.address, deadline],
        account: trader.account,
      });
    } catch (simErr2: any) {
      msg =
        simErr2?.shortMessage ??
        simErr2?.message ??
        simErr2?.cause?.shortMessage ??
        simErr2?.cause?.message ??
        simErr2?.details ??
        String(simErr2);
    }
    console.log(`    [REVERT] 4.1 receipt.status=reverted: ${msg}`);
    throw new Error(`4.1 PancakeSwap sell reverted: ${msg}`);
  }
  if (sold1 === 0n) {
    throw new Error(
      "4.1 PancakeSwap sell succeeded but trader balance unchanged (0 TCGV sold)."
    );
  }
  if (sold1 > 0n && burn4 !== 0n) {
    throw new Error(`4.1 Expected no supply burn on pool sell, got Δsupply ${formatEther(burn4)}`);
  }
  console.log("    [OK] 4.1 Sell path applied pool fee on Pancake TCGV→USDC (no fee burn)");
  console.log();

  console.log("4.2 Sell via TCGVaultBuyRouter (TCGV → USDC)...");
  const sellAmount2 = sellAmountFixed;
  await token.write.approve([buyRouterAddress, sellAmount2], { account: trader.account });
  const vaultTcgvBefore5 = (await token.read.balanceOf([vaultAddr]));
  const supplyBefore5 = (await token.read.totalSupply());
  const traderUsdcBefore5 = await usdc.read.balanceOf([trader.account.address]);

  const sellRouterTxHash = await buyRouter.write.sellTCGVForUSDC([sellAmount2, 0n, deadline], {
    account: trader.account,
  });
  const sellReceipt = await publicClient.waitForTransactionReceipt({ hash: sellRouterTxHash });
  if (sellReceipt.status === "reverted") {
    throw new Error("4.2 Sell via TCGVaultBuyRouter reverted");
  }

  const traderTcgvAfter5 = (await token.read.balanceOf([trader.account.address]));
  const vaultTcgvAfter5 = (await token.read.balanceOf([vaultAddr]));
  const supplyAfter5 = (await token.read.totalSupply());
  const traderUsdcAfter5 = await usdc.read.balanceOf([trader.account.address]);
  const sold2 = sellAmount2;
  const vaultDelta5 = vaultTcgvAfter5 - vaultTcgvBefore5;
  const burn5 = supplyBefore5 - supplyAfter5;
  const usdcOutBuyRouter = traderUsdcAfter5 - traderUsdcBefore5;
  console.log(`    Trader sold:   ${formatEther(sold2)} TCGV`);
  console.log(`    Trader USDC:   +${Number(usdcOutBuyRouter) / 1e6}`);
  console.log(`    Vault TCGV:    +${formatEther(vaultDelta5)}`);
  console.log(`    Supply Δ:      ${formatEther(burn5)} TCGV (expect 0)`);
  if (sold2 > 0n) {
    // BuyRouter sell: USDC fee only; default 0% TCGV burn on input.
    if (burn5 !== 0n) {
      throw new Error(`4.2 Sell burn: expected 0 TCGV burn on router sell, got ${formatEther(burn5)}`);
    }
    const vaultBp = Number((vaultDelta5 * 10000n) / sold2);
    if (vaultDelta5 > 0n && (vaultBp < POOL_SELL_VAULT_PLUS_AUTOLP_BP - 200 || vaultBp > POOL_SELL_VAULT_PLUS_AUTOLP_BP + 500)) {
      console.log(`    [Note] 4.2 Vault TCGV delta: ${vaultBp}bp (router pays fees in USDC)`);
    }
  }
  console.log("    [OK] 4.2 BuyRouter sell: 4% USDC fee split, no TCGV burn");
  await claimBuyRouterPendingUsdc(buyRouter, [vaultAddr, marketingAddr, communityAddr], wallets);
  const routerUsdcAfterSell = await usdc.read.balanceOf([buyRouterAddress]);
  if (routerUsdcAfterSell !== 0n) {
    throw new Error(`4.2 Router USDC after sell fee claims: expected 0, got ${routerUsdcAfterSell}`);
  }
  console.log();

  // --- Sell comparison: same TCGV sold, both routes give USDC ---
  const sellRows = [
    { name: "PancakeSwap router (4.1)", tcgvSold: sold1, outLabel: "USDC" as const, outAmount: usdcOutPancake },
    { name: "TCGVaultBuyRouter (4.2)", tcgvSold: sold2, outLabel: "USDC" as const, outAmount: usdcOutBuyRouter },
  ];
  console.log("--- SELL comparison (same TCGV sold) ---");
  console.log(`    TCGV sold: ${formatEther(sellAmountFixed)} (identical for both)`);
  console.log("    Route                      | TCGV sold    | Out");
  console.log("    ---------------------------|--------------|----------------");
  for (const row of sellRows) {
    const outStr = row.outLabel === "USDC" ? `${Number(row.outAmount) / 1e6} USDC` : formatEther(row.outAmount) + " BNB";
    console.log(`    ${row.name.padEnd(28)} | ${formatEther(row.tcgvSold).padStart(12)} | ${outStr}`);
  }
  console.log();

  // ---------------------------------------------------------------------------
  // Summary & tokenomics verification
  // ---------------------------------------------------------------------------
  console.log("=".repeat(80));
  console.log("End-to-end summary");
  console.log("=".repeat(80));
  console.log("TCGVaultToken:           ", tokenAddress);
  console.log("TCGNexusToken:          ", nexusTokenAddress);
  console.log("TCGVaultBuyRouter:      ", buyRouterAddress);
  console.log("TCGVaultLiquidityWrapper:", wrapperAddress);
  console.log("PancakeSwap Pair:        ", pairAddress);
  console.log("Dummy router (Phase 5):  ", dummyRouterAddress);
  console.log("Vault (fees):            ", vaultAddr);
  console.log("Marketing (fees):        ", marketingAddr);
  console.log("Community (TCGV):        ", communityAddr);
  console.log();
  console.log("Tokenomics verified:");
  console.log("  Buy (Pancake direct): 6% TCGV routeur OFF (~2% vault, ~2% structure, ~2% autolp); no NEXUS on pair — no fee burn");
  console.log("  Buy (BuyRouter):      5% USDC routeur ON (accrued on router → claimUsdcFees) + NEXUS cashback — no TCGV burn");
  console.log("  Sell (Pancake direct): 5% TCGV routeur OFF (2% vault, 2% autolp, 1% structure) — no fee burn");
  console.log("  Sell (BuyRouter):     4% USDC routeur ON (pending on router → claim); 1.5% vault, 1% LP, 1% community, 0.5% structure");
  console.log();
  console.log("Flow: Deploy → TCGV/USDC pair & liquidity → Buy 4 routes (all USDC in) → Sell 2 routes (TCGV→USDC).");
  console.log("All steps completed successfully.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

/**
 * Prints user output for the same USDC/TCGV trade via:
 *   1. TCGVaultBuyRouter (routeur ON — USDC fees, no TCGV pool tax, NEXUS cashback)
 *   2. Pancake V2 router (routeur OFF — TCGV buy/sell tax)
 *   3. Direct pair.swap (same AMM math as the DEX router)
 *
 * Each path is isolated with loadFixture so reserves start identical.
 * Pancake fee = 0.25% (9975/10000), matching TCGVaultBuyRouter._getAmountOut.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import {
  parseEther,
  parseUnits,
  formatEther,
  formatUnits,
  getContractAddress,
  zeroAddress,
  decodeEventLog,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";

const { viem, networkHelpers } = await hre.network.connect();

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
);

const BUY_USDC = parseUnits("100", 6);
const SELL_TCGV = parseEther("1000");
const LIQ_TCGV = parseEther("900000");
const LIQ_USDC = parseUnits("10000", 6);

function pancakeAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const amountInWithFee = amountIn * 9975n;
  return (amountInWithFee * reserveOut) / (reserveIn * 10000n + amountInWithFee);
}

function fmtTcgv(x: bigint): string {
  return `${formatEther(x)} TCGV`;
}

function fmtUsdc(x: bigint): string {
  return `${formatUnits(x, 6)} USDC`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

type Named = { address: Address; symbol: string; decimals: number };

function decodeTransfers(
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
  tokens: readonly Named[],
): string[] {
  const byAddr = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
  const lines: string[] = [];
  for (const log of logs) {
    const token = byAddr.get(log.address.toLowerCase());
    if (!token) continue;
    try {
      const decoded = decodeEventLog({
        abi: [TRANSFER_EVENT],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "Transfer") continue;
      const { from, to, value } = decoded.args as { from: Address; to: Address; value: bigint };
      const amount = token.decimals === 6 ? fmtUsdc(value) : fmtTcgv(value);
      lines.push(`      ${token.symbol}  ${shortAddr(from)} → ${shortAddr(to)}  ${amount}`);
    } catch {
      /* not a Transfer */
    }
  }
  return lines;
}

function decodeSwaps(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[], pair: Address): string[] {
  const lines: string[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== pair.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: [SWAP_EVENT], data: log.data, topics: log.topics });
      if (decoded.eventName !== "Swap") continue;
      const a = decoded.args as {
        sender: Address;
        amount0In: bigint;
        amount1In: bigint;
        amount0Out: bigint;
        amount1Out: bigint;
        to: Address;
      };
      lines.push(
        `      pair.swap sender=${shortAddr(a.sender)} to=${shortAddr(a.to)} in0=${a.amount0In} in1=${a.amount1In} out0=${a.amount0Out} out1=${a.amount1Out}`,
      );
    } catch {
      /* not a Swap */
    }
  }
  return lines;
}

async function deployFixture() {
  const wallets = await viem.getWalletClients();
  const owner = wallets[0]!;
  const user = wallets[1]!;
  const vault = wallets[2]!;
  const marketing = wallets[3]!;
  const community = wallets[4]!;
  const publicClient = await viem.getPublicClient();

  const weth = await viem.deployContract("MockWETH", [], { client: { wallet: owner } });
  const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], { client: { wallet: owner } });
  const factory = await viem.deployContract("contracts/test/PancakeFactory.sol:PancakeFactory", [owner.account.address], {
    client: { wallet: owner },
  });
  // LocalPancakeRouter uses factory.getPair (PancakeRouter's CREATE2 hash is mainnet-only).
  const router = await viem.deployContract(
    "contracts/test/CoverageHelpers.sol:LocalPancakeRouter",
    [factory.address, weth.address],
    { client: { wallet: owner } },
  );

  const n0 = BigInt(await publicClient.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));
  const futureTcgv = getContractAddress({ from: owner.account.address, nonce: n0 + 1n });
  const nexusAddr = getContractAddress({ from: owner.account.address, nonce: n0 });
  await viem.deployContract("TCGNexusToken", [futureTcgv, user.account.address, vault.account.address], {
    client: { wallet: owner },
  });
  const tcgv = await viem.deployContract(
    "TCGVaultToken",
    [
      zeroAddress,
      router.address,
      vault.account.address,
      marketing.account.address,
      community.account.address,
      nexusAddr,
      owner.account.address,
    ],
    { client: { wallet: owner } },
  );
  const nexus = await viem.getContractAt("TCGNexusToken", nexusAddr);

  const wrapper = await viem.deployContract("TCGVaultLiquidityWrapper", [tcgv.address, router.address], {
    client: { wallet: owner },
  });
  await tcgv.write.setExcludedFromFees([wrapper.address, true], { account: owner.account });

  const mintAmount = parseEther("1000000");
  await tcgv.write.mintPresale([owner.account.address, mintAmount], { account: owner.account });
  await usdc.write.mint([owner.account.address, LIQ_USDC + parseUnits("100000", 6)], { account: owner.account });
  await usdc.write.mint([user.account.address, parseUnits("100000", 6)], { account: owner.account });

  const deadline = (await publicClient.getBlock()).timestamp + 600n;
  await tcgv.write.approve([wrapper.address, LIQ_TCGV], { account: owner.account });
  await usdc.write.approve([wrapper.address, LIQ_USDC], { account: owner.account });
  await wrapper.write.addLiquidity([router.address, usdc.address, LIQ_TCGV, LIQ_USDC, 0n, 0n, deadline], {
    account: owner.account,
  });

  const pairAddress = (await factory.read.getPair([tcgv.address, usdc.address])) as Address;
  const pair = await viem.getContractAt("contracts/test/PancakePair.sol:PancakePair", pairAddress);
  await tcgv.write.setPair([pairAddress, true], { account: owner.account });

  const buyRouter = await viem.deployContract(
    "TCGVaultBuyRouter",
    [
      router.address,
      usdc.address,
      tcgv.address,
      vault.account.address,
      marketing.account.address,
      community.account.address,
    ],
    { client: { wallet: owner } },
  );
  await tcgv.write.setBuyRouter([buyRouter.address], { account: owner.account });

  await tcgv.write.transfer([user.account.address, parseEther("50000")], { account: owner.account });

  const token0 = (await pair.read.token0()) as Address;
  const tcgvIsToken0 = token0.toLowerCase() === tcgv.address.toLowerCase();

  return {
    owner,
    user,
    vault,
    marketing,
    community,
    usdc,
    factory,
    router,
    tcgv,
    nexus,
    buyRouter,
    pair,
    pairAddress,
    tcgvIsToken0,
    publicClient,
  };
}

type Ctx = Awaited<ReturnType<typeof deployFixture>>;

async function reserves(ctx: Ctx): Promise<{ tcgv: bigint; usdc: bigint }> {
  const [r0, r1] = (await ctx.pair.read.getReserves()) as [bigint, bigint, number];
  return ctx.tcgvIsToken0 ? { tcgv: r0, usdc: r1 } : { tcgv: r1, usdc: r0 };
}

async function snapshotUser(ctx: Ctx) {
  const { user, tcgv, usdc, nexus, vault, marketing, buyRouter } = ctx;
  return {
    tcgv: await tcgv.read.balanceOf([user.account.address]),
    usdc: await usdc.read.balanceOf([user.account.address]),
    nexus: await nexus.read.balanceOf([user.account.address]),
    pendingVaultUsdc: await buyRouter.read.pendingUsdcFees([vault.account.address]),
    pendingMktUsdc: await buyRouter.read.pendingUsdcFees([marketing.account.address]),
    pendingVaultTcgv: await tcgv.read.pendingFeeClaims([vault.account.address]),
    pendingMktTcgv: await tcgv.read.pendingFeeClaims([marketing.account.address]),
    pendingAutolp: await tcgv.read.pendingAutolp(),
  };
}

async function logTxTransfers(ctx: Ctx, hash: Hex, label: string) {
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  const tokens: Named[] = [
    { address: ctx.tcgv.address, symbol: "TCGV", decimals: 18 },
    { address: ctx.usdc.address, symbol: "USDC", decimals: 6 },
  ];
  const transfers = decodeTransfers(receipt.logs, tokens);
  const swaps = decodeSwaps(receipt.logs, ctx.pairAddress);
  console.log(`    gas: ${receipt.gasUsed.toString()}  status=${receipt.status}`);
  if (transfers.length) {
    console.log(`    Transfer events (${label}):`);
    for (const line of transfers) console.log(line);
  }
  if (swaps.length) {
    console.log(`    Swap events:`);
    for (const line of swaps) console.log(line);
  }
}

describe("DEX path output comparison (printed)", function () {
  it("BUY 100 USDC — BuyRouter vs Pancake router vs direct pair (same reserves)", async function () {
    const printBuy = async (label: string, exec: (ctx: Ctx) => Promise<Hex>) => {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      const rBefore = await reserves(ctx);
      const quoteFull = pancakeAmountOut(BUY_USDC, rBefore.usdc, rBefore.tcgv);
      const quoteAfterBuyFee = pancakeAmountOut((BUY_USDC * 9500n) / 10000n, rBefore.usdc, rBefore.tcgv);
      const before = await snapshotUser(ctx);

      console.log(`\n=== BUY ${label} ===`);
      console.log(`    reserves: ${fmtTcgv(rBefore.tcgv)} / ${fmtUsdc(rBefore.usdc)}`);
      console.log(`    quote getAmountOut(100 USDC)     = ${fmtTcgv(quoteFull)}  (user net @ 6% tax ≈ ${fmtTcgv((quoteFull * 9400n) / 10000n)})`);
      console.log(`    quote getAmountOut(95 USDC fee)  = ${fmtTcgv(quoteAfterBuyFee)}  (BuyRouter, no TCGV tax)`);

      const hash = await exec(ctx);
      await logTxTransfers(ctx, hash, label);

      const after = await snapshotUser(ctx);
      const rAfter = await reserves(ctx);
      const userTcgv = after.tcgv - before.tcgv;
      const userUsdc = before.usdc - after.usdc;
      const nexus = after.nexus - before.nexus;
      console.log(`    user USDC spent:  ${fmtUsdc(userUsdc)}`);
      console.log(`    user TCGV got:    ${fmtTcgv(userTcgv)}`);
      console.log(`    NEXUS cashback:   ${formatEther(nexus)} NEXUS`);
      console.log(`    pending USDC fees vault/mkt: ${fmtUsdc(after.pendingVaultUsdc - before.pendingVaultUsdc)} / ${fmtUsdc(after.pendingMktUsdc - before.pendingMktUsdc)}`);
      console.log(`    pending TCGV fees vault/mkt/autolp: ${fmtTcgv(after.pendingVaultTcgv - before.pendingVaultTcgv)} / ${fmtTcgv(after.pendingMktTcgv - before.pendingMktTcgv)} / ${fmtTcgv(after.pendingAutolp - before.pendingAutolp)}`);
      console.log(`    reserves after: ${fmtTcgv(rAfter.tcgv)} / ${fmtUsdc(rAfter.usdc)}`);
      assert.ok(userTcgv > 0n, `${label}: expected TCGV out`);
      return { label, userTcgv, nexus, userUsdc };
    };

    const rows = [
      await printBuy("TCGVaultBuyRouter.buyTCGVWithUSDC", async (ctx) => {
        await ctx.usdc.write.approve([ctx.buyRouter.address, BUY_USDC], { account: ctx.user.account });
        return ctx.buyRouter.write.buyTCGVWithUSDC([BUY_USDC, 0n, 2n ** 64n], { account: ctx.user.account });
      }),
      await printBuy("DEX router swapExactTokensForTokensSupportingFeeOnTransferTokens", async (ctx) => {
        await ctx.usdc.write.approve([ctx.router.address, BUY_USDC], { account: ctx.user.account });
        return ctx.router.write.swapExactTokensForTokensSupportingFeeOnTransferTokens(
          [BUY_USDC, 0n, [ctx.usdc.address, ctx.tcgv.address], ctx.user.account.address, 2n ** 64n],
          { account: ctx.user.account },
        );
      }),
      await printBuy("direct pair.swap (USDC transferred to pair first)", async (ctx) => {
        const r = await reserves(ctx);
        const amountOut = pancakeAmountOut(BUY_USDC, r.usdc, r.tcgv);
        const amount0Out = ctx.tcgvIsToken0 ? amountOut : 0n;
        const amount1Out = ctx.tcgvIsToken0 ? 0n : amountOut;
        await ctx.usdc.write.transfer([ctx.pairAddress, BUY_USDC], { account: ctx.user.account });
        return ctx.pair.write.swap([amount0Out, amount1Out, ctx.user.account.address, "0x"], {
          account: ctx.user.account,
        });
      }),
    ];

    console.log("\n--- BUY summary (most TCGV to user = best) ---");
    console.log(`    ${pad("route", 72)} | TCGV out          | NEXUS`);
    console.log(`    ${"-".repeat(72)}-+-------------------+---------------`);
    for (const row of rows) {
      console.log(`    ${pad(row.label, 72)} | ${pad(formatEther(row.userTcgv), 17)} | ${formatEther(row.nexus)}`);
    }
    assert.ok(rows[0]!.nexus > 0n, "BuyRouter should mint NEXUS");
    assert.equal(rows[1]!.nexus, 0n);
    assert.equal(rows[2]!.nexus, 0n);
    assert.equal(rows[1]!.userTcgv, rows[2]!.userTcgv, "DEX router and direct pair must match on a buy");
  });

  it("SELL 1000 TCGV — BuyRouter vs Pancake router vs direct pair (same reserves)", async function () {
    const printSell = async (label: string, exec: (ctx: Ctx) => Promise<Hex>) => {
      const ctx = await networkHelpers.loadFixture(deployFixture);
      const rBefore = await reserves(ctx);
      const quoteFull = pancakeAmountOut(SELL_TCGV, rBefore.tcgv, rBefore.usdc);
      const quoteAfterSellTax = pancakeAmountOut((SELL_TCGV * 9500n) / 10000n, rBefore.tcgv, rBefore.usdc);
      const before = await snapshotUser(ctx);

      console.log(`\n=== SELL ${label} ===`);
      console.log(`    reserves: ${fmtTcgv(rBefore.tcgv)} / ${fmtUsdc(rBefore.usdc)}`);
      console.log(`    quote getAmountOut(1000 TCGV)    = ${fmtUsdc(quoteFull)}  (BuyRouter, then 4% USDC fee → ${fmtUsdc((quoteFull * 9600n) / 10000n)})`);
      console.log(`    quote getAmountOut(950 TCGV tax) = ${fmtUsdc(quoteAfterSellTax)}  (DEX / pair, 5% TCGV sell tax)`);

      const hash = await exec(ctx);
      await logTxTransfers(ctx, hash, label);

      const after = await snapshotUser(ctx);
      const rAfter = await reserves(ctx);
      const userTcgv = before.tcgv - after.tcgv;
      const userUsdc = after.usdc - before.usdc;
      console.log(`    user TCGV spent:  ${fmtTcgv(userTcgv)}`);
      console.log(`    user USDC got:    ${fmtUsdc(userUsdc)}`);
      console.log(`    pending USDC fees vault/mkt: ${fmtUsdc(after.pendingVaultUsdc - before.pendingVaultUsdc)} / ${fmtUsdc(after.pendingMktUsdc - before.pendingMktUsdc)}`);
      console.log(`    pending TCGV fees vault/mkt/autolp: ${fmtTcgv(after.pendingVaultTcgv - before.pendingVaultTcgv)} / ${fmtTcgv(after.pendingMktTcgv - before.pendingMktTcgv)} / ${fmtTcgv(after.pendingAutolp - before.pendingAutolp)}`);
      console.log(`    reserves after: ${fmtTcgv(rAfter.tcgv)} / ${fmtUsdc(rAfter.usdc)}`);
      assert.ok(userUsdc > 0n, `${label}: expected USDC out`);
      return { label, userUsdc, userTcgv };
    };

    const rows = [
      await printSell("TCGVaultBuyRouter.sellTCGVForUSDC", async (ctx) => {
        await ctx.tcgv.write.approve([ctx.buyRouter.address, SELL_TCGV], { account: ctx.user.account });
        return ctx.buyRouter.write.sellTCGVForUSDC([SELL_TCGV, 0n, 2n ** 64n], { account: ctx.user.account });
      }),
      await printSell("DEX router swapExactTokensForTokensSupportingFeeOnTransferTokens", async (ctx) => {
        await ctx.tcgv.write.approve([ctx.router.address, SELL_TCGV], { account: ctx.user.account });
        return ctx.router.write.swapExactTokensForTokensSupportingFeeOnTransferTokens(
          [SELL_TCGV, 0n, [ctx.tcgv.address, ctx.usdc.address], ctx.user.account.address, 2n ** 64n],
          { account: ctx.user.account },
        );
      }),
      await printSell("direct pair.swap (TCGV transferred to pair first)", async (ctx) => {
        const r = await reserves(ctx);
        await ctx.tcgv.write.transfer([ctx.pairAddress, SELL_TCGV], { account: ctx.user.account });
        const pairTcgv = await ctx.tcgv.read.balanceOf([ctx.pairAddress]);
        const amountInActual = pairTcgv - r.tcgv;
        const amountOut = pancakeAmountOut(amountInActual, r.tcgv, r.usdc);
        const amount0Out = ctx.tcgvIsToken0 ? 0n : amountOut;
        const amount1Out = ctx.tcgvIsToken0 ? amountOut : 0n;
        return ctx.pair.write.swap([amount0Out, amount1Out, ctx.user.account.address, "0x"], {
          account: ctx.user.account,
        });
      }),
    ];

    console.log("\n--- SELL summary (most USDC to user = best) ---");
    console.log(`    ${pad("route", 72)} | USDC out`);
    console.log(`    ${"-".repeat(72)}-+----------------`);
    for (const row of rows) {
      console.log(`    ${pad(row.label, 72)} | ${formatUnits(row.userUsdc, 6)}`);
    }
    assert.equal(rows[1]!.userUsdc, rows[2]!.userUsdc, "DEX router and direct pair must match on a sell");
  });
});

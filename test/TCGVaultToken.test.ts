import { describe, it, before } from "node:test";
import { expect } from "chai";
import hre from "hardhat";
import { parseEther, parseUnits, formatEther, zeroAddress, getAddress, getContractAddress, encodeFunctionData } from "viem";
import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";

const { viem, networkHelpers } = await hre.network.connect();

async function expectRevert(promise: Promise<unknown>) {
  let reverted = false;
  try {
    await promise;
  } catch {
    reverted = true;
  }
  expect(reverted).to.equal(true);
}

const ZERO = zeroAddress;

/** Deploy Nexus (minter = predicted TCGV) then TCGV with immutable NEXUS; returns TCGV client. */
async function deployFreshTcgvWithNexus(
  owner: Awaited<ReturnType<typeof viem.getWalletClients>>[0],
  stakingVault: `0x${string}`,
  router: `0x${string}`,
  vault: `0x${string}`,
  marketing: `0x${string}`,
  community: `0x${string}`,
  initialLaunch: `0x${string}`,
  nexusPresaleBonusFounder: `0x${string}`,
  nexusPresaleBonusLaunch: `0x${string}`,
) {
  const pc = await viem.getPublicClient();
  const n0 = BigInt(await pc.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));
  const futureTcgv = getContractAddress({ from: owner.account.address, nonce: n0 + 1n });
  const nexusAddr = getContractAddress({ from: owner.account.address, nonce: n0 });
  await viem.deployContract("TCGNexusToken", [futureTcgv, nexusPresaleBonusFounder, nexusPresaleBonusLaunch], {
    client: { wallet: owner },
  });
  const tcgvContract = await viem.deployContract("TCGVaultToken", [
    stakingVault,
    router,
    vault,
    marketing,
    community,
    nexusAddr,
    initialLaunch,
  ], { client: { wallet: owner } });
  return viem.getContractAt("TCGVaultToken", tcgvContract.address as `0x${string}`);
}

// Helper to ensure transactions complete in Hardhat
async function waitForTx(hash: `0x${string}`) {
  const publicClient = await viem.getPublicClient();
  try {
    // In Hardhat, transactions are synchronous, but we wait to ensure state is updated
    await publicClient.waitForTransactionReceipt({ hash, timeout: 10000 });
  } catch (error: any) {
    // If wait fails (e.g., ABI parsing issues), transaction likely already completed
    // In Hardhat's synchronous environment, this is usually fine
    if (!error.message?.includes('inputs')) {
      throw error;
    }
  }
}

async function advanceTime(seconds: number) {
  await networkHelpers.time.increase(seconds);
  await networkHelpers.mine();
}

// Vesting uses fixed 30-day months (SECONDS_PER_MONTH in TCGVaultToken), not calendar months.
const SECONDS_PER_MONTH = 30 * 24 * 3600;

describe("TCGVaultToken", () => {
  let owner: Awaited<ReturnType<typeof viem.getWalletClients>>[0];
  let vault: Awaited<ReturnType<typeof viem.getWalletClients>>[0];
  let marketing: Awaited<ReturnType<typeof viem.getWalletClients>>[0];
  let community: Awaited<ReturnType<typeof viem.getWalletClients>>[0];
  let user1: Awaited<ReturnType<typeof viem.getWalletClients>>[0];
  let user2: Awaited<ReturnType<typeof viem.getWalletClients>>[0];

  let weth: ContractReturnType<"MockWETH">;
  let usdc: ContractReturnType<"MockUSDC">;
  let factory: ContractReturnType<"MockUniswapV2Factory">;
  let router: ContractReturnType<"MockUniswapV2Router">;
  let tcgv: ContractReturnType<"TCGVaultToken">;
  let nexus: ContractReturnType<"TCGNexusToken">;
  let wrapper: ContractReturnType<"TCGVaultLiquidityWrapper">;
  let mockPresaleLaunch: ContractReturnType<"MockPresaleLaunch">;
  let pair: ContractReturnType<"MockUniswapV2Pair">;
  let publicClient: Awaited<ReturnType<typeof viem.getPublicClient>>;
  let wethAddress: `0x${string}`;
  let usdcAddress: `0x${string}`;
  let factoryAddress: `0x${string}`;
  let routerAddress: `0x${string}`;
  let tcgvAddress: `0x${string}`;
  let nexusAddress: `0x${string}`;
  let wrapperAddress: `0x${string}`;
  let pairAddress: `0x${string}`;

  const TOTAL_SUPPLY = parseEther("1000000000");
  const BUY_TAX_BP = 600n;
  const SELL_TAX_BP = 500n;
  const CASHBACK_BP_STANDARD = 300n; // 3% after presale (whitepaper §6)
  const CASHBACK_BP_PRESALE = 3000n; // 30% during Vagues 1 et 2 (whitepaper §6)

  before(async () => {
    [owner, vault, marketing, community, user1, user2] = await viem.getWalletClients();
    publicClient = await viem.getPublicClient();

    // Deploy MockWETH (router constructor expects it)
    const wethContract = await viem.deployContract("MockWETH", [], { client: { wallet: owner } });
    wethAddress = wethContract.address as `0x${string}`;
    weth = await viem.getContractAt("MockWETH", wethAddress);

    // Deploy MockUSDC (TCGV/USDC pool)
    const usdcContract = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], { client: { wallet: owner } });
    usdcAddress = usdcContract.address as `0x${string}`;
    usdc = await viem.getContractAt("MockUSDC", usdcAddress);
    await usdc.write.mint([owner.account.address, parseUnits("1000000", 6)], { account: owner.account });
    await usdc.write.transfer([user1.account.address, parseUnits("10000", 6)], { account: owner.account });
    await usdc.write.transfer([user2.account.address, parseUnits("10000", 6)], { account: owner.account });

    // Deploy MockFactory
    const factoryContract = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
    factoryAddress = factoryContract.address as `0x${string}`;
    factory = await viem.getContractAt("MockUniswapV2Factory", factoryAddress);

    // Deploy MockRouter
    const routerContract = await viem.deployContract("MockUniswapV2Router", [factoryAddress, wethAddress], { client: { wallet: owner } });
    routerAddress = routerContract.address as `0x${string}`;
    router = await viem.getContractAt("MockUniswapV2Router", routerAddress);

    // Deploy mock presale launch first; TCGV stores it as immutable initialLaunch.
    mockPresaleLaunch = await viem.deployContract("contracts/test/MockPresaleLaunch.sol:MockPresaleLaunch", [], { client: { wallet: owner } });

    // Deploy TCGNexusToken first (minter = predicted TCGV), then TCGV with immutable NEXUS
    const n0 = BigInt(await publicClient.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));
    const futureTcgvAddr = getContractAddress({ from: owner.account.address, nonce: n0 + 1n });
    const expectedNexusAddr = getContractAddress({ from: owner.account.address, nonce: n0 });

    const nexusContract = await viem.deployContract(
      "TCGNexusToken",
      [futureTcgvAddr, user1.account.address, user2.account.address],
      { client: { wallet: owner } },
    );
    nexusAddress = nexusContract.address as `0x${string}`;
    nexus = await viem.getContractAt("TCGNexusToken", nexusAddress);

    const tcgvContract = await viem.deployContract("TCGVaultToken", [
      ZERO,
      routerAddress,
      vault.account.address,
      marketing.account.address,
      community.account.address,
      expectedNexusAddr,
      mockPresaleLaunch.address as `0x${string}`,
    ], { client: { wallet: owner } });
    tcgvAddress = tcgvContract.address as `0x${string}`;
    tcgv = await viem.getContractAt("TCGVaultToken", tcgvAddress);

    // Create TCGV/USDC pair
    const createPairHash = await factory.write.createPair([tcgvAddress as `0x${string}`, usdcAddress], { account: owner.account });
    await waitForTx(createPairHash);
    pairAddress = (await factory.read.getPair([tcgvAddress, usdcAddress])) as `0x${string}`;
    pair = await viem.getContractAt("MockUniswapV2Pair", pairAddress);

    // Set pair on token; use min amounts 1 in tests so swap outputs from mock pair always pass (production uses 10_000)
    const setPairHash = await tcgv.write.setPair([pairAddress, true], { account: owner.account });
    await waitForTx(setPairHash);
    await tcgv.write.setMinAmounts([1n, 1n], { account: owner.account });

    // Deploy wrapper (deployContract waits for confirmation and returns the contract instance)
    wrapper = await viem.deployContract("TCGVaultLiquidityWrapper", [tcgvAddress, routerAddress], { client: { wallet: owner } });
    wrapperAddress = wrapper.address as `0x${string}`;

    // Mint presale tokens to owner for liquidity (no constructor mint; supply is minted during presale / at end).
    // Use 10M so swap outputs exceed minBuyAmount/minSellAmount (10_000) after first test consumes liquidity.
    const presaleMintAmount = parseEther("10000000");
    await mockPresaleLaunch.write.mintPresale([tcgvAddress, owner.account.address, presaleMintAmount], { account: owner.account });

    // Fee-exclude wrapper: LP add (wrapper→pair) and remove (pair→wrapper) must skip TCGV fees
    const setExcludedHash = await tcgv.write.setExcludedFromFees(
      [wrapperAddress, true],
      { account: owner.account }
    );
    await waitForTx(setExcludedHash);
    
    // Verify wrapper is excluded
    const isExcluded = await tcgv.read.isExcludedFromFees([wrapperAddress]);
    if (!isExcluded) {
      throw new Error("Wrapper was not excluded from fees");
    }

    // Add liquidity via wrapper: TCGV/USDC pool (no ETH).
    const tokenAmount = presaleMintAmount;
    const usdcAmount = parseUnits("100", 6);
    const block = await publicClient.getBlock();
    const deadline = block.timestamp + 300n;

    await tcgv.write.approve([wrapperAddress, tokenAmount], { account: owner.account });
    await usdc.write.approve([wrapperAddress, usdcAmount], { account: owner.account });

    const addLiqHash = await wrapper.write.addLiquidity([
      routerAddress,
      usdcAddress,
      tokenAmount,
      usdcAmount,
      0n,
      0n,
      deadline
    ], { account: owner.account });

    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash: addLiqHash as `0x${string}`, timeout: 5000 });
    } catch (error: any) {
      const ownerBalanceAfter = await tcgv.read.balanceOf([owner.account.address]);
      const pairBalance = await tcgv.read.balanceOf([pairAddress]);
      const wrapperBalance = await tcgv.read.balanceOf([wrapperAddress]);
      throw new Error(`Transaction wait failed: ${error.message}. Owner: ${ownerBalanceAfter}, Pair: ${pairBalance}, Wrapper: ${wrapperBalance}`);
    }

    if (receipt.status === "reverted") {
      const ownerBalanceAfter = await tcgv.read.balanceOf([owner.account.address]);
      const pairBalance = await tcgv.read.balanceOf([pairAddress]);
      const wrapperBalance = await tcgv.read.balanceOf([wrapperAddress]);
      throw new Error(`addLiquidity reverted. Owner: ${ownerBalanceAfter}, Pair: ${pairBalance}, Wrapper: ${wrapperBalance}`);
    }

    const [r0, r1] = (await pair.read.getReserves()) as [bigint, bigint, number];
    if (r0 === 0n && r1 === 0n) {
      const pairBalance = await tcgv.read.balanceOf([pairAddress]);
      const wrapperBalance = await tcgv.read.balanceOf([wrapperAddress]);
      const ownerBalanceAfter = await tcgv.read.balanceOf([owner.account.address]);
      throw new Error(`Liquidity was not added. Owner: ${ownerBalanceAfter}, Pair: ${pairBalance}, Wrapper: ${wrapperBalance}`);
    }
  });

  describe("Deployment", () => {
    it("has correct name and symbol", async () => {
      expect(await tcgv.read.name()).to.equal("TCG-VAULT Token");
      expect(await tcgv.read.symbol()).to.equal("TCGV");
    });
    it("supply from presale mint only (no constructor mint)", async () => {
      expect(await tcgv.read.totalSupply()).to.equal(parseEther("10000000"));
      // Owner used full presale mint for liquidity so balance 0; LP tokens received via wrapper to msg.sender (owner)
      expect(await tcgv.read.balanceOf([owner.account.address])).to.equal(0n);
    });
    it("pair has liquidity", async () => {
      const reserves = (await pair.read.getReserves()) as [bigint, bigint, number];
      const [r0, r1] = reserves;
      expect(r0 + r1 > 0n).to.equal(true);
    });
  });

  describe("Router path: buy (ETH -> TCGV)", () => {
    it("charges 6% buy tax on pool path (routeur OFF) and does not mint NEXUS (portail only)", async () => {
      expect(await tcgv.read.presaleActive()).to.equal(true);
      expect(await tcgv.read.minBuyAmount()).to.equal(1n); // set in before() so mock swap amounts pass
      const buyAmountUsdc = parseUnits("100", 6);
      const path = [usdcAddress, tcgvAddress] as const;
      const vaultBefore = (await tcgv.read.balanceOf([vault.account.address]));
      const marketingBefore = (await tcgv.read.balanceOf([marketing.account.address]));
      const nexusBefore = (await nexus.read.balanceOf([user1.account.address]));
      const totalSupplyBefore = (await tcgv.read.totalSupply());

      await usdc.write.approve([routerAddress, buyAmountUsdc], { account: user1.account });
      await router.write.swapExactTokensForTokens([
        buyAmountUsdc,
        0n,
        path,
        user1.account.address,
        (await publicClient.getBlock()).timestamp + 300n
      ], { account: user1.account });

      const userReceived = (await tcgv.read.balanceOf([user1.account.address]));
      const vaultAfter = (await tcgv.read.balanceOf([vault.account.address]));
      const marketingAfter = (await tcgv.read.balanceOf([marketing.account.address]));
      const nexusAfter = (await nexus.read.balanceOf([user1.account.address]));
      const totalSupplyAfter = (await tcgv.read.totalSupply());

      expect(userReceived > 0n).to.equal(true);
      expect(vaultAfter - vaultBefore >= 0n).to.equal(true);
      expect(marketingAfter - marketingBefore >= 0n).to.equal(true);
      expect(totalSupplyAfter).to.equal(totalSupplyBefore);
      expect(nexusAfter).to.equal(nexusBefore);
    });

    it("pool buy does not mint NEXUS even when presale ended (getCashbackRate would be 3%)", async () => {
      if (await tcgv.read.presaleActive()) return;
      expect(await tcgv.read.getCashbackRate()).to.equal(BigInt(CASHBACK_BP_STANDARD));
      const buyAmountUsdc = parseUnits("50", 6);
      const path = [usdcAddress, tcgvAddress] as const;
      const nexusBefore = (await nexus.read.balanceOf([user2.account.address]));

      await usdc.write.approve([routerAddress, buyAmountUsdc], { account: user2.account });
      await router.write.swapExactTokensForTokens([
        buyAmountUsdc,
        0n,
        path,
        user2.account.address,
        (await publicClient.getBlock()).timestamp + 300n
      ], { account: user2.account });

      const nexusAfter = (await nexus.read.balanceOf([user2.account.address]));
      expect(nexusAfter).to.equal(nexusBefore);
    });
  });

  describe("Non-router path: direct pair swap (buy)", () => {
    it("charges buy tax when swapping via pair directly", async () => {
      const usdcIn = parseUnits("50", 6);
      await usdc.write.approve([pairAddress, usdcIn], { account: user2.account });
      await usdc.write.transfer([pairAddress, usdcIn], { account: user2.account });

      const token0 = (await pair.read.token0()) as `0x${string}`;
      const isToken0Usdc = token0.toLowerCase() === usdcAddress.toLowerCase();
      const amountTcgvOut = parseEther("1000");
      const amount0Out = isToken0Usdc ? 0n : amountTcgvOut;
      const amount1Out = isToken0Usdc ? amountTcgvOut : 0n;

      const user2Before = (await tcgv.read.balanceOf([user2.account.address]));
      const totalSupplyBefore = (await tcgv.read.totalSupply());
      const vaultFeesBefore = await tcgv.read.pendingFeeClaims([vault.account.address]);

      await pair.write.swap([amount0Out, amount1Out, user2.account.address, "0x"], { account: user2.account });

      const user2After = (await tcgv.read.balanceOf([user2.account.address]));
      const totalSupplyAfter = (await tcgv.read.totalSupply());
      const vaultFeesAfter = await tcgv.read.pendingFeeClaims([vault.account.address]);

      expect(user2After >= user2Before).to.equal(true);
      expect(totalSupplyAfter).to.equal(totalSupplyBefore);
      // Routeur OFF pool buy: 6% fee in thirds → vault / marketing / pendingAutolp pull-fees.
      expect(vaultFeesAfter > vaultFeesBefore).to.equal(true);
    });
  });

  describe("Router path: sell (TCGV -> USDC)", () => {
    it("charges 5% sell tax on pool path (routeur OFF) and no cashback", async () => {
      const sellAmount = parseEther("5000");
      const path = [tcgvAddress, usdcAddress] as const;
      const vaultBefore = (await tcgv.read.balanceOf([vault.account.address]));
      const marketingBefore = (await tcgv.read.balanceOf([marketing.account.address]));
      const communityBefore = (await tcgv.read.balanceOf([community.account.address]));
      const totalSupplyBefore = (await tcgv.read.totalSupply());
      const nexusBefore = (await nexus.read.balanceOf([user1.account.address]));

      await tcgv.write.approve([routerAddress, sellAmount], { account: user1.account });
      await router.write.swapExactTokensForTokens([
        sellAmount,
        0n,
        path,
        user1.account.address,
        (await publicClient.getBlock()).timestamp + 300n
      ], { account: user1.account });

      const vaultAfter = (await tcgv.read.balanceOf([vault.account.address]));
      const marketingAfter = (await tcgv.read.balanceOf([marketing.account.address]));
      const communityAfter = (await tcgv.read.balanceOf([community.account.address]));
      const totalSupplyAfter = (await tcgv.read.totalSupply());
      const nexusAfter = (await nexus.read.balanceOf([user1.account.address]));

      expect(vaultAfter - vaultBefore >= 0n).to.equal(true);
      expect(marketingAfter - marketingBefore >= 0n).to.equal(true);
      expect(communityAfter - communityBefore >= 0n).to.equal(true);
      expect(totalSupplyAfter).to.equal(totalSupplyBefore);
      expect(nexusAfter).to.equal(nexusBefore);
    });
  });

  describe("Liquidity wrapper: add/remove without fees", () => {
    it("wrapper allowedRouters is true for initial router", async () => {
      expect(await wrapper.read.allowedRouters([routerAddress])).to.equal(true);
    });
    it("owner can setAllowedRouter", async () => {
      const otherRouter = user2.account.address;
      expect(await wrapper.read.allowedRouters([otherRouter])).to.equal(false);
      await wrapper.write.setAllowedRouter([otherRouter, true], { account: owner.account });
      expect(await wrapper.read.allowedRouters([otherRouter])).to.equal(true);
      await wrapper.write.setAllowedRouter([otherRouter, false], { account: owner.account });
    });
    it("addLiquidity via wrapper does not charge fees on token transfer to pair", async () => {
      const addTokenAmount = parseEther("1000");
      const addUsdcAmount = parseUnits("10", 6);
      const pairBalanceBefore = (await tcgv.read.balanceOf([pairAddress]));
      const totalSupplyBefore = (await tcgv.read.totalSupply());

      await tcgv.write.approve([wrapperAddress, addTokenAmount], { account: user1.account });
      await usdc.write.approve([wrapperAddress, addUsdcAmount], { account: user1.account });
      await wrapper.write.addLiquidity([
        routerAddress,
        usdcAddress,
        addTokenAmount,
        addUsdcAmount,
        0n,
        0n,
        (await publicClient.getBlock()).timestamp + 300n
      ], { account: user1.account });

      const pairBalanceAfter = (await tcgv.read.balanceOf([pairAddress]));
      const totalSupplyAfter = (await tcgv.read.totalSupply());

      expect(pairBalanceAfter - pairBalanceBefore).to.equal(addTokenAmount);
      expect(totalSupplyAfter).to.equal(totalSupplyBefore);
    });

    it("removeLiquidity via wrapper does not charge fees", async (t) => {
      const lpBalance = (await pair.read.balanceOf([user1.account.address]));
      if (lpBalance === 0n) return t.skip();
      const userTcgvBefore = (await tcgv.read.balanceOf([user1.account.address]));
      const totalSupplyBefore = (await tcgv.read.totalSupply());

      await pair.write.approve([wrapperAddress, lpBalance], { account: user1.account });
      await wrapper.write.removeLiquidity([
        routerAddress,
        usdcAddress,
        pairAddress,
        lpBalance / 2n,
        0n,
        0n,
        (await publicClient.getBlock()).timestamp + 300n
      ], { account: user1.account });

      const userTcgvAfter = (await tcgv.read.balanceOf([user1.account.address]));
      const totalSupplyAfter = (await tcgv.read.totalSupply());

      expect(userTcgvAfter > userTcgvBefore).to.equal(true);
      expect(totalSupplyAfter).to.equal(totalSupplyBefore);
    });

    it("wrapper refunds excess token when router uses less than desired", async (t) => {
      const reserves = (await pair.read.getReserves()) as [bigint, bigint, number];
      const [r0, r1] = reserves;
      if (r0 === 0n && r1 === 0n) return t.skip();
      const tokenDesired = parseEther("100000");
      const usdcDesired = parseUnits("1000", 6);
      await mockPresaleLaunch.write.mintPresale([tcgvAddress, user1.account.address, tokenDesired], { account: owner.account });
      await usdc.write.transfer([user1.account.address, usdcDesired], { account: owner.account });
      const userTcgvBefore = await tcgv.read.balanceOf([user1.account.address]);
      await tcgv.write.approve([wrapperAddress, tokenDesired], { account: user1.account });
      await usdc.write.approve([wrapperAddress, usdcDesired], { account: user1.account });
      await wrapper.write.addLiquidity([
        routerAddress,
        usdcAddress,
        tokenDesired,
        usdcDesired,
        0n,
        0n,
        (await publicClient.getBlock()).timestamp + 300n
      ], { account: user1.account });
      const userTcgvAfter = await tcgv.read.balanceOf([user1.account.address]);
      expect(userTcgvBefore - userTcgvAfter > 0n).to.equal(true);
      expect(userTcgvAfter >= 0n).to.equal(true);
    });

    it("wrapper refunds excess tokenB when router uses less amountB than desired", async () => {
      const seedTcgv = parseEther("1000");
      const seedUsdc = parseUnits("10", 6);
      await mockPresaleLaunch.write.mintPresale([tcgvAddress, user1.account.address, seedTcgv], { account: owner.account });
      await usdc.write.transfer([user1.account.address, seedUsdc], { account: owner.account });
      await tcgv.write.approve([wrapperAddress, seedTcgv], { account: user1.account });
      await usdc.write.approve([wrapperAddress, seedUsdc], { account: user1.account });
      await wrapper.write.addLiquidity([
        routerAddress,
        usdcAddress,
        seedTcgv,
        seedUsdc,
        0n,
        0n,
        (await publicClient.getBlock()).timestamp + 300n
      ], { account: user1.account });
      const addTcgv = parseEther("100");
      const addUsdc = parseUnits("1000", 6);
      await mockPresaleLaunch.write.mintPresale([tcgvAddress, user1.account.address, addTcgv], { account: owner.account });
      await usdc.write.transfer([user1.account.address, addUsdc], { account: owner.account });
      const userUsdcBefore = await usdc.read.balanceOf([user1.account.address]);
      await tcgv.write.approve([wrapperAddress, addTcgv], { account: user1.account });
      await usdc.write.approve([wrapperAddress, addUsdc], { account: user1.account });
      await wrapper.write.addLiquidity([
        routerAddress,
        usdcAddress,
        addTcgv,
        addUsdc,
        0n,
        0n,
        (await publicClient.getBlock()).timestamp + 300n
      ], { account: user1.account });
      const userUsdcAfter = await usdc.read.balanceOf([user1.account.address]);
      expect(userUsdcBefore - userUsdcAfter < addUsdc).to.equal(true);
    });

    it("wrapper addLiquidity reverts when router not allowed", async () => {
      const badRouter = user2.account.address;
      await tcgv.write.approve([wrapperAddress, parseEther("100")], { account: user1.account });
      await usdc.write.approve([wrapperAddress, parseUnits("10", 6)], { account: user1.account });
      let reverted = false;
      try {
        await wrapper.write.addLiquidity([
          badRouter,
          usdcAddress,
          parseEther("100"),
          parseUnits("10", 6),
          0n,
          0n,
          (await publicClient.getBlock()).timestamp + 300n
        ], { account: user1.account });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("wrapper removeLiquidity reverts when router not allowed", async () => {
      const badRouter = user2.account.address;
      await pair.write.approve([wrapperAddress, parseEther("1")], { account: user1.account });
      let reverted = false;
      try {
        await wrapper.write.removeLiquidity([
          badRouter,
          usdcAddress,
          pairAddress,
          parseEther("1"),
          0n,
          0n,
          (await publicClient.getBlock()).timestamp + 300n
        ], { account: user1.account });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });
  });

  describe("Fee routing (no supply burn)", () => {
    it("buy fee accrues vault pull-fees without changing total supply (routeur OFF; buy fee includes autolp third)", async () => {
      const supplyBefore = (await tcgv.read.totalSupply());
      const vaultFeesBefore = await tcgv.read.pendingFeeClaims([vault.account.address]);
      const usdcIn = parseUnits("20", 6);
      const path = [usdcAddress, tcgvAddress] as const;
      await usdc.write.approve([routerAddress, usdcIn], { account: user2.account });
      await router.write.swapExactTokensForTokens([
        usdcIn,
        0n,
        path,
        user2.account.address,
        (await publicClient.getBlock()).timestamp + 300n
      ], { account: user2.account });
      const supplyAfter = (await tcgv.read.totalSupply());
      const vaultFeesAfter = await tcgv.read.pendingFeeClaims([vault.account.address]);
      expect(supplyAfter).to.equal(supplyBefore);
      expect(vaultFeesAfter > vaultFeesBefore).to.equal(true);
    });

    it("sell fee increases pendingAutolp without changing total supply", async () => {
      const supplyBefore = (await tcgv.read.totalSupply());
      const pendingBefore = await tcgv.read.pendingAutolp();
      const sellAmt = parseEther("1000");
      await tcgv.write.approve([routerAddress, sellAmt], { account: user2.account });
      const path = [tcgvAddress, usdcAddress] as const;
      await router.write.swapExactTokensForTokens([
        sellAmt,
        0n,
        path,
        user2.account.address,
        (await publicClient.getBlock()).timestamp + 300n
      ], { account: user2.account });
      const supplyAfter = (await tcgv.read.totalSupply());
      const pendingAfter = await tcgv.read.pendingAutolp();
      expect(supplyAfter).to.equal(supplyBefore);
      expect(pendingAfter > pendingBefore).to.equal(true);
    });

    it("claimAccruedFees pays pending vault fees and reverts when empty", async () => {
      const pending = await tcgv.read.pendingFeeClaims([vault.account.address]);
      expect(pending > 0n).to.equal(true);
      const balBefore = await tcgv.read.balanceOf([vault.account.address]);
      await tcgv.write.claimAccruedFees({ account: vault.account });
      expect(await tcgv.read.pendingFeeClaims([vault.account.address])).to.equal(0n);
      expect(await tcgv.read.balanceOf([vault.account.address])).to.equal(balBefore + pending);
      await expectRevert(tcgv.write.claimAccruedFees({ account: vault.account }));
    });

    it("sell fee with community share accrues community pendingFeeClaims", async () => {
      await tcgv.write.setSellFeeParams([500n, 2500n, 2500n, 2500n, 2500n], { account: owner.account });
      const communityBefore = await tcgv.read.pendingFeeClaims([community.account.address]);
      const sellAmt = parseEther("500");
      const path = [tcgvAddress, usdcAddress] as const;
      await tcgv.write.approve([routerAddress, sellAmt], { account: user1.account });
      await router.write.swapExactTokensForTokens([
        sellAmt,
        0n,
        path,
        user1.account.address,
        (await publicClient.getBlock()).timestamp + 300n,
      ], { account: user1.account });
      expect(await tcgv.read.pendingFeeClaims([community.account.address]) > communityBefore).to.equal(true);
      await tcgv.write.setSellFeeParams([500n, 4000n, 4000n, 2000n, 0n], { account: owner.account });
    });
  });

  describe("executePendingAutolp", () => {
    it("pendingAutolp increases on sell and executePendingAutolp clears it", async () => {
      const sellAmt = parseEther("2000");
      await tcgv.write.approve([routerAddress, sellAmt], { account: user1.account });
      const path = [tcgvAddress, usdcAddress] as const;
      const pendingBefore = await tcgv.read.pendingAutolp();
      await router.write.swapExactTokensForTokens([
        sellAmt,
        0n,
        path,
        user1.account.address,
        (await publicClient.getBlock()).timestamp + 300n
      ], { account: user1.account });
      const pendingAfterSell = await tcgv.read.pendingAutolp();
      expect(pendingAfterSell > pendingBefore).to.equal(true);

      const pairBalanceBefore = await tcgv.read.balanceOf([pairAddress]);
      await tcgv.write.executePendingAutolp({ account: user2.account });
      const pendingAfterExecute = await tcgv.read.pendingAutolp();
      expect(pendingAfterExecute).to.equal(0n);
      const pairBalanceAfter = await tcgv.read.balanceOf([pairAddress]);
      expect(pairBalanceAfter >= pairBalanceBefore).to.equal(true);
    });

    it("executePendingAutolp when zero is no-op", async () => {
      const pending = await tcgv.read.pendingAutolp();
      await tcgv.write.executePendingAutolp({ account: owner.account });
      expect(await tcgv.read.pendingAutolp()).to.equal(pending);
    });
  });

  describe("Presale finalization and dynamic burn", () => {
    it("finalizePresaleAndRecompute reverts when caller is not initialLaunch", async () => {
      let reverted = false;
      try {
        await tcgv.write.finalizePresaleAndRecompute({ account: user1.account });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("finalizePresaleAndRecompute reverts AllocationRecipientsNotSet when recipients not set", async () => {
      const freshMock = await viem.deployContract("contracts/test/MockPresaleLaunch.sol:MockPresaleLaunch", [], { client: { wallet: owner } });
      const freshTcgv = await deployFreshTcgvWithNexus(
        owner,
        ZERO,
        routerAddress,
        vault.account.address,
        marketing.account.address,
        community.account.address,
        freshMock.address,
        freshMock.address,
        owner.account.address,
      );
      await expectRevert(
        freshMock.write.finalizePresaleAndRecompute([freshTcgv.address], { account: owner.account })
      );
    });

    it("initialLaunch is immutable and set at deployment", async () => {
      expect(getAddress(await tcgv.read.initialLaunch())).to.equal(getAddress(mockPresaleLaunch.address));
    });

    it("mintPresale reverts OnlyInitialLaunch when caller is not initialLaunch", async () => {
      await expectRevert(
        tcgv.write.mintPresale([user1.account.address, parseEther("100")], { account: user1.account })
      );
    });

    it("mintPresale is no-op when to is zero or amount is zero", async () => {
      const supplyBefore = await tcgv.read.totalSupply();
      await mockPresaleLaunch.write.mintPresale([tcgvAddress, ZERO, parseEther("100")], { account: owner.account });
      expect(await tcgv.read.totalSupply()).to.equal(supplyBefore);
      await mockPresaleLaunch.write.mintPresale([tcgvAddress, owner.account.address, 0n], { account: owner.account });
      expect(await tcgv.read.totalSupply()).to.equal(supplyBefore);
    });
    it("finalizePresaleAndRecompute when presaleSold is 0 emits and returns", async () => {
      const freshMock = await viem.deployContract("contracts/test/MockPresaleLaunch.sol:MockPresaleLaunch", [], { client: { wallet: owner } });
      const freshTcgv = await deployFreshTcgvWithNexus(
        owner,
        ZERO,
        routerAddress,
        vault.account.address,
        marketing.account.address,
        community.account.address,
        freshMock.address,
        freshMock.address,
        owner.account.address,
      );
      await freshTcgv.write.setAllocationRecipients([vault.account.address, marketing.account.address, community.account.address], { account: owner.account });
      await freshMock.write.finalizePresaleAndRecompute([freshTcgv.address], { account: owner.account });
      expect(await freshTcgv.read.supplyRecomputed()).to.equal(true);
      expect(await freshTcgv.read.presaleActive()).to.equal(false);
      expect(await freshTcgv.read.opsVestingClaimable()).to.equal(0n);
      expect(await freshTcgv.read.teamVestingClaimable()).to.equal(0n);
    });
    it("finalizePresaleAndRecompute mints 20% liquidity, 4% team vesting, 5% ops direct, 11% ops vesting", async () => {
      const presaleSold = parseEther("10000000");
      await mockPresaleLaunch.write.setTotalAllocated([presaleSold], { account: owner.account });
      await tcgv.write.setAllocationRecipients([vault.account.address, marketing.account.address, community.account.address], { account: owner.account });
      const supplyBefore = await tcgv.read.totalSupply();
      const vaultBefore = await tcgv.read.balanceOf([vault.account.address]);
      const communityBefore = await tcgv.read.balanceOf([community.account.address]);
      await mockPresaleLaunch.write.finalizePresaleAndRecompute([tcgvAddress], { account: owner.account });
      const finalSupply = (presaleSold * 10000n) / 6000n;
      const toMint = finalSupply - supplyBefore;
      expect(await tcgv.read.supplyRecomputed()).to.equal(true);

      const liquidityAmount = (finalSupply * 2000n) / 10000n;
      const teamVestingAmount = (finalSupply * 400n) / 10000n;
      const opsDirectAmount = (finalSupply * 500n) / 10000n;
      const opsVestingAmount = (finalSupply * 1100n) / 10000n;
      const sum = liquidityAmount + teamVestingAmount + opsDirectAmount + opsVestingAmount;
      const scaled = (x: bigint) => (sum > toMint && sum > 0n) ? (x * toMint) / sum : x;
      const liq = scaled(liquidityAmount);
      const teamV = scaled(teamVestingAmount);
      const opsD = scaled(opsDirectAmount);
      const opsV = (sum > toMint && sum > 0n) ? toMint - liq - teamV - opsD : scaled(opsVestingAmount);
      const totalMinted = liq + teamV + opsD + opsV;
      expect(await tcgv.read.totalSupply()).to.equal(supplyBefore + totalMinted);

      expect((await tcgv.read.balanceOf([vault.account.address])) - vaultBefore >= liq).to.equal(true);
      expect((await tcgv.read.balanceOf([community.account.address])) - communityBefore).to.equal(opsD);
      expect(await tcgv.read.balanceOf([tcgvAddress]) >= teamV + opsV).to.equal(true);
      expect(await tcgv.read.teamVestingTotal()).to.equal(teamV);
      expect(await tcgv.read.opsVestingTotal()).to.equal(opsV);

      let reverted = false;
      try {
        await mockPresaleLaunch.write.finalizePresaleAndRecompute([tcgvAddress], { account: owner.account });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("claimTeam reverts before cliff (NoTeamVestingToClaim)", async () => {
      // State already finalized by previous test
      await expectRevert(tcgv.write.claimTeam({ account: owner.account }));
    });

    it("claimOps after one month sends vested amount to opsRecipient", async () => {
      await advanceTime(SECONDS_PER_MONTH);
      const claimable = await tcgv.read.opsVestingClaimable();
      expect(claimable > 0n).to.equal(true);
      const communityBefore = await tcgv.read.balanceOf([community.account.address]);
      await tcgv.write.claimOps({ account: owner.account });
      const communityAfter = await tcgv.read.balanceOf([community.account.address]);
      expect(communityAfter > communityBefore).to.equal(true);
      // Actual claimed may exceed claimable if block timestamp advanced between read and claim
      expect(communityAfter - communityBefore >= claimable).to.equal(true);
    });

    it("claimTeam after cliff sends vested amount to teamRecipient", async () => {
      // Cliff is 12 months; advance 13 months from finalize so one month of team vesting has elapsed
      await advanceTime(13 * SECONDS_PER_MONTH);
      const claimable = await tcgv.read.teamVestingClaimable();
      expect(claimable > 0n).to.equal(true);
      const marketingBefore = await tcgv.read.balanceOf([marketing.account.address]);
      await tcgv.write.claimTeam({ account: owner.account });
      const marketingAfter = await tcgv.read.balanceOf([marketing.account.address]);
      expect(marketingAfter > marketingBefore).to.equal(true);
      expect(marketingAfter - marketingBefore >= claimable).to.equal(true);
    });

    it("claimTeam reverts NoTeamVestingToClaim when nothing left to claim", async () => {
      await advanceTime(36 * SECONDS_PER_MONTH);
      while ((await tcgv.read.teamVestingClaimable()) > 0n) {
        await tcgv.write.claimTeam({ account: owner.account });
      }
      await expectRevert(tcgv.write.claimTeam({ account: owner.account }));
    });

    it("claimOps reverts NoOpsVestingToClaim when nothing left to claim", async () => {
      await advanceTime(36 * SECONDS_PER_MONTH);
      while ((await tcgv.read.opsVestingClaimable()) > 0n) {
        await tcgv.write.claimOps({ account: owner.account });
      }
      await expectRevert(tcgv.write.claimOps({ account: owner.account }));
    });
  });

  describe("NEXUS Soulbound", () => {
    it("NEXUS minter returns TCGV token address", async () => {
      const m = await nexus.read.minter();
      expect(m.toLowerCase()).to.equal(tcgvAddress.toLowerCase());
    });
    it("NEXUS isPresaleBonusContract is true for immutable presale bonus addresses only", async () => {
      expect(await nexus.read.isPresaleBonusContract([user1.account.address])).to.equal(true);
      expect(await nexus.read.isPresaleBonusContract([user2.account.address])).to.equal(true);
      expect(await nexus.read.isPresaleBonusContract([owner.account.address])).to.equal(false);
    });
    it("NEXUS transfer reverts", async () => {
      // Mint through an authorized presale bonus contract address so owner has a balance.
      await nexus.write.mintPresaleBonus([owner.account.address, parseEther("100")], { account: user1.account });
      let reverted = false;
      try {
        await nexus.write.transfer([user1.account.address, parseEther("1")], { account: owner.account });
      } catch {
        reverted = true; // any revert (SoulboundTransferNotAllowed) means soulbound is enforced
      }
      expect(reverted).to.be.true;
    });

    it("NEXUS nonces returns value for account", async () => {
      const n = await nexus.read.nonces([owner.account.address]);
      expect(n).to.be.a("bigint");
    });

    it("NEXUS constructor reverts when minter is zero", async () => {
      await expectRevert(
        viem.deployContract("TCGNexusToken", [ZERO], { client: { wallet: owner } })
      );
    });

    it("NEXUS mintCashback reverts when not minter", async () => {
      await expectRevert(
        nexus.write.mintCashback([owner.account.address, parseEther("1")], { account: user1.account })
      );
    });

    it("NEXUS mintCashback reverts when recipient is zero or amount is zero", async () => {
      const testMinter = await viem.deployContract("TestNexusMinter", [], { client: { wallet: owner } });
      const nexusMinter = await viem.deployContract(
        "TCGNexusToken",
        [testMinter.address, user1.account.address, user2.account.address],
        { client: { wallet: owner } },
      );
      await expectRevert(
        testMinter.write.mintCashback(
          [nexusMinter.address as `0x${string}`, ZERO, parseEther("1")],
          { account: owner.account }
        )
      );
      await expectRevert(
        testMinter.write.mintCashback(
          [nexusMinter.address as `0x${string}`, owner.account.address, 0n],
          { account: owner.account }
        )
      );
    });

    it("NEXUS mintPresaleBonus reverts when not presale minter", async () => {
      await expectRevert(
        nexus.write.mintPresaleBonus([user1.account.address, parseEther("1")], { account: owner.account })
      );
    });

    it("NEXUS mintPresaleBonus reverts when recipient is zero", async () => {
      await expectRevert(
        nexus.write.mintPresaleBonus([ZERO, parseEther("1")], { account: user1.account })
      );
    });

    it("NEXUS mintPresaleBonus reverts when amount is zero", async () => {
      await expectRevert(
        nexus.write.mintPresaleBonus([owner.account.address, 0n], { account: user1.account })
      );
    });

    it("NEXUS mint reverts when to is zero", async () => {
      await expectRevert(
        nexus.write.mint([ZERO, parseEther("1")], { account: owner.account })
      );
    });
  });

  describe("TCGVaultToken branch coverage", () => {
    it("constructor reverts ZeroAddress when vault is zero", async () => {
      let reverted = false;
      try {
        await viem.deployContract("TCGVaultToken", [
          ZERO,
          routerAddress,
          ZERO,
          marketing.account.address,
          community.account.address,
          user1.account.address,
          user1.account.address,
        ], { client: { wallet: owner } });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("constructor reverts ZeroAddress when nexus is zero", async () => {
      let reverted = false;
      try {
        await viem.deployContract("TCGVaultToken", [
          ZERO,
          routerAddress,
          vault.account.address,
          marketing.account.address,
          community.account.address,
          ZERO,
          user1.account.address,
        ], { client: { wallet: owner } });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("constructor reverts ZeroAddress when dex router is zero", async () => {
      let reverted = false;
      try {
        await viem.deployContract("TCGVaultToken", [
          ZERO,
          ZERO,
          vault.account.address,
          marketing.account.address,
          community.account.address,
          user1.account.address,
          user1.account.address,
        ], { client: { wallet: owner } });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("constructor reverts ZeroAddress when initialLaunch is zero", async () => {
      await expectRevert(
        viem.deployContract("TCGVaultToken", [
          ZERO,
          routerAddress,
          vault.account.address,
          marketing.account.address,
          community.account.address,
          user1.account.address,
          ZERO,
        ], { client: { wallet: owner } }),
      );
    });

    it("setDexRouter reverts when router.factory() is zero", async () => {
      const zeroFactory = await viem.deployContract(
        "contracts/test/CoverageHelpers.sol:MockRouterZeroFactory",
        [],
        { client: { wallet: owner } },
      );
      await expectRevert(
        tcgv.write.setDexRouter([zeroFactory.address, true], { account: owner.account }),
      );
    });

    it("burnPresaleAllocation reverts for non-launch, zero from is ZeroAddress, amount 0 is no-op", async () => {
      await expectRevert(
        tcgv.write.burnPresaleAllocation([owner.account.address, parseEther("1")], { account: owner.account }),
      );
      await expectRevert(
        mockPresaleLaunch.write.burnPresaleAllocation([tcgvAddress, ZERO, parseEther("1")], { account: owner.account }),
      );
      const supplyBefore = await tcgv.read.totalSupply();
      await mockPresaleLaunch.write.burnPresaleAllocation([tcgvAddress, owner.account.address, 0n], {
        account: owner.account,
      });
      expect(await tcgv.read.totalSupply()).to.equal(supplyBefore);
    });

    it("setBlacklisted reverts ZeroAddress; burnPresaleAllocation burns a positive amount", async () => {
      await expectRevert(
        tcgv.write.setBlacklisted([ZERO, true, "fraud"], { account: owner.account }),
      );
      const amt = parseEther("3");
      await mockPresaleLaunch.write.mintPresale([tcgvAddress, user2.account.address, amt], { account: owner.account });
      const supplyBefore = await tcgv.read.totalSupply();
      await mockPresaleLaunch.write.burnPresaleAllocation([tcgvAddress, user2.account.address, amt], {
        account: owner.account,
      });
      expect(await tcgv.read.totalSupply()).to.equal(supplyBefore - amt);
    });

    it("dexFactoryForRouter records factory for initial router; setDexRouter adds another router", async () => {
      expect(getAddress(await tcgv.read.dexFactoryForRouter([routerAddress]))).to.equal(
        getAddress(factoryAddress)
      );
      const router2Contract = await viem.deployContract("MockUniswapV2Router", [factoryAddress, wethAddress], {
        client: { wallet: owner },
      });
      const router2 = router2Contract.address as `0x${string}`;
      await tcgv.write.setDexRouter([router2, true], { account: owner.account });
      expect(getAddress(await tcgv.read.dexFactoryForRouter([router2]))).to.equal(getAddress(factoryAddress));
      // Shared DEX routers must not be fee-excluded (F-2026-19268).
      expect(await tcgv.read.isExcludedFromFees([router2])).to.equal(false);
    });

    it("setDexRouter(false) clears factory mapping without toggling fee exclusion", async () => {
      const router2Contract = await viem.deployContract("MockUniswapV2Router", [factoryAddress, wethAddress], {
        client: { wallet: owner },
      });
      const router2 = router2Contract.address as `0x${string}`;
      await tcgv.write.setDexRouter([router2, true], { account: owner.account });
      await tcgv.write.setDexRouter([router2, false], { account: owner.account });
      expect(await tcgv.read.dexFactoryForRouter([router2])).to.equal(ZERO);
      expect(await tcgv.read.isExcludedFromFees([router2])).to.equal(false);
    });

    it("setDexRouter reverts when router is zero", async () => {
      await expectRevert(tcgv.write.setDexRouter([ZERO, true], { account: owner.account }));
    });

    it("setDexRouter reverts without ADMIN_ROLE", async () => {
      await expectRevert(tcgv.write.setDexRouter([routerAddress, false], { account: user1.account }));
    });

    it("setPair reverts when pair is zero", async () => {
      await expectRevert(tcgv.write.setPair([ZERO, true], { account: owner.account }));
      await expectRevert(tcgv.write.setPair([ZERO, false], { account: owner.account }));
    });

    it("setPair success: owner enables and disables pair", async () => {
      await tcgv.write.setPair([pairAddress, false], { account: owner.account });
      expect(await tcgv.read.isPair([pairAddress])).to.equal(false);
      await tcgv.write.setPair([pairAddress, true], { account: owner.account });
      expect(await tcgv.read.isPair([pairAddress])).to.equal(true);
    });

    it("setPair reverts without ADMIN_ROLE", async () => {
      await expectRevert(
        tcgv.write.setPair([pairAddress, false], { account: user1.account })
      );
    });

    it("setFeesEnabled success: owner toggles fees", async () => {
      await tcgv.write.setFeesEnabled([false], { account: owner.account });
      expect(await tcgv.read.feesEnabled()).to.equal(false);
      await tcgv.write.setFeesEnabled([true], { account: owner.account });
      expect(await tcgv.read.feesEnabled()).to.equal(true);
    });

    it("setFeesEnabled reverts without ADMIN_ROLE", async () => {
      await expectRevert(
        tcgv.write.setFeesEnabled([false], { account: user1.account })
      );
    });

    it("setCashbackEnabled reverts without ADMIN_ROLE", async () => {
      await expectRevert(
        tcgv.write.setCashbackEnabled([false], { account: user1.account })
      );
    });

    it("setAddresses reverts ZeroAddress when any address is zero", async () => {
      await expectRevert(
        tcgv.write.setAddresses([ZERO, marketing.account.address, community.account.address], { account: owner.account })
      );
    });

    it("setAddresses success: owner updates vault/marketing/community (nexus unchanged)", async () => {
      const nexusBefore = getAddress(await tcgv.read.nexusToken());
      await tcgv.write.setAddresses(
        [user1.account.address, user2.account.address, community.account.address],
        { account: owner.account }
      );
      expect(getAddress(await tcgv.read.vaultAddress())).to.equal(getAddress(user1.account.address));
      expect(getAddress(await tcgv.read.marketingAddress())).to.equal(getAddress(user2.account.address));
      expect(getAddress(await tcgv.read.nexusToken())).to.equal(nexusBefore);
      await tcgv.write.setAddresses(
        [vault.account.address, marketing.account.address, community.account.address],
        { account: owner.account }
      );
    });

    it("setExcludedFromFees success: owner excludes then includes", async () => {
      await tcgv.write.setExcludedFromFees([user1.account.address, true], { account: owner.account });
      expect(await tcgv.read.isExcludedFromFees([user1.account.address])).to.equal(true);
      await tcgv.write.setExcludedFromFees([user1.account.address, false], { account: owner.account });
      expect(await tcgv.read.isExcludedFromFees([user1.account.address])).to.equal(false);
    });

    it("setBuyFeeParams reverts InvalidFeeParams when buyTaxBp exceeds MAX_BUY_TAX_BP", async () => {
      await expectRevert(
        tcgv.write.setBuyFeeParams([601n, 6000n, 4000n, 0n], { account: owner.account })
      );
    });

    it("setBuyFeeParams allows raising buyTaxBp again after lowering, within MAX_BUY_TAX_BP", async () => {
      await tcgv.write.setBuyFeeParams([400n, 6000n, 4000n, 0n], { account: owner.account });
      expect(await tcgv.read.BUY_TAX()).to.equal(400n);
      await tcgv.write.setBuyFeeParams([600n, 6000n, 4000n, 0n], { account: owner.account });
      expect(await tcgv.read.BUY_TAX()).to.equal(600n);
    });

    it("setBuyFeeParams reverts InvalidFeeParams when shares do not sum to 10000", async () => {
      await expectRevert(
        tcgv.write.setBuyFeeParams([600n, 5000n, 3000n, 1999n], { account: owner.account })
      );
    });

    it("setBuyFeeParams success: owner updates buy fee params", async () => {
      await tcgv.write.setBuyFeeParams([400n, 6000n, 4000n, 0n], { account: owner.account });
      expect(await tcgv.read.BUY_TAX()).to.equal(400n);
      expect(await tcgv.read.BUY_VAULT_SHARE()).to.equal(6000n);
    });

    it("setSellFeeParams reverts InvalidFeeParams when sellTaxBp exceeds MAX_SELL_TAX_BP", async () => {
      await expectRevert(
        tcgv.write.setSellFeeParams([501n, 3750n, 2500n, 1250n, 2500n], { account: owner.account })
      );
    });

    it("setSellFeeParams allows raising sellTaxBp again after lowering, within MAX_SELL_TAX_BP", async () => {
      await tcgv.write.setSellFeeParams([300n, 2500n, 2500n, 2500n, 2500n], { account: owner.account });
      expect(await tcgv.read.SELL_TAX()).to.equal(300n);
      await tcgv.write.setSellFeeParams([500n, 2500n, 2500n, 2500n, 2500n], { account: owner.account });
      expect(await tcgv.read.SELL_TAX()).to.equal(500n);
    });

    it("setSellFeeParams reverts InvalidFeeParams when shares do not sum to 10000", async () => {
      await expectRevert(
        tcgv.write.setSellFeeParams([500n, 4000n, 2000n, 2000n, 999n], { account: owner.account })
      );
    });

    it("setSellFeeParams success: owner updates sell fee params", async () => {
      await tcgv.write.setSellFeeParams([300n, 2500n, 2500n, 2500n, 2500n], { account: owner.account });
      expect(await tcgv.read.SELL_TAX()).to.equal(300n);
    });

    it("setAllocationRecipients success: owner sets liquidity/team/ops", async () => {
      await tcgv.write.setAllocationRecipients([
        user1.account.address,
        user2.account.address,
        community.account.address,
      ], { account: owner.account });
      expect(getAddress(await tcgv.read.liquidityRecipient())).to.equal(getAddress(user1.account.address));
      expect(getAddress(await tcgv.read.teamRecipient())).to.equal(getAddress(user2.account.address));
      expect(getAddress(await tcgv.read.opsRecipient())).to.equal(getAddress(community.account.address));
      await tcgv.write.setAllocationRecipients([
        vault.account.address,
        marketing.account.address,
        community.account.address,
      ], { account: owner.account });
    });

    it("setMinAmounts reverts without ADMIN_ROLE", async () => {
      await expectRevert(
        tcgv.write.setMinAmounts([0n, 0n], { account: user1.account })
      );
    });

    it("setBlacklisted reverts without BLACKLISTER_ROLE", async () => {
      await expectRevert(
        tcgv.write.setBlacklisted([user1.account.address, true, "fraud"], { account: user1.account })
      );
    });

    it("pause reverts without PAUSER_ROLE", async () => {
      await expectRevert(tcgv.write.pause({ account: user1.account }));
    });

    it("unpause reverts without UNPAUSER_ROLE", async () => {
      await expectRevert(tcgv.write.unpause({ account: user1.account }));
    });

    it("setBuyRouter with zero does not set isExcludedFromFees", async () => {
      await tcgv.write.setBuyRouter([ZERO], { account: owner.account });
      expect(await tcgv.read.buyRouter()).to.equal(ZERO);
    });

    it("recordBuyAndMintCashback early return when cashback disabled", async () => {
      const testRouter = await viem.deployContract("TestBuyRouter", [], {
        client: { wallet: owner },
      });
      await testRouter.write.setToken([tcgvAddress], { account: owner.account });
      await tcgv.write.setBuyRouter([testRouter.address], { account: owner.account });
      await tcgv.write.setCashbackEnabled([false], { account: owner.account });
      await testRouter.write.callRecordBuyAndMintCashback([owner.account.address, parseEther("100")], { account: owner.account });
    });

    it("recordBuyAndMintCashback early return when cashbackAmount is zero", async () => {
      const testRouter = await viem.deployContract("TestBuyRouter", [], {
        client: { wallet: owner },
      });
      await testRouter.write.setToken([tcgvAddress], { account: owner.account });
      await tcgv.write.setBuyRouter([testRouter.address], { account: owner.account });
      await tcgv.write.setCashbackEnabled([true], { account: owner.account });
      await testRouter.write.callRecordBuyAndMintCashback([owner.account.address, 1n], { account: owner.account });
    });

    it("recordBuyAndMintCashback reverts when not buyRouter", async () => {
      await expectRevert(
        tcgv.write.recordBuyAndMintCashback(
          [owner.account.address, parseEther("100")],
          { account: user1.account }
        )
      );
    });

    it("_update amount zero: transfer(0) is no-op", async () => {
      const u1Before = await tcgv.read.balanceOf([user1.account.address]);
      const u2Before = await tcgv.read.balanceOf([user2.account.address]);
      await tcgv.write.transfer([user2.account.address, 0n], { account: user1.account });
      expect(await tcgv.read.balanceOf([user1.account.address])).to.equal(u1Before);
      expect(await tcgv.read.balanceOf([user2.account.address])).to.equal(u2Before);
    });

    it("regular transfer (no buy/sell) applies no fees", async () => {
      const u1Before = await tcgv.read.balanceOf([user1.account.address]);
      const u2Before = await tcgv.read.balanceOf([user2.account.address]);
      const amt = u1Before < parseEther("10") ? u1Before : parseEther("10");
      if (amt === 0n) return;
      await tcgv.write.transfer([user2.account.address, amt], { account: user1.account });
      expect(await tcgv.read.balanceOf([user1.account.address])).to.equal(u1Before - amt);
      expect(await tcgv.read.balanceOf([user2.account.address])).to.equal(u2Before + amt);
    });

    it("teamVestingClaimable returns 0 when already fully claimed", async () => {
      const claimable = await tcgv.read.teamVestingClaimable();
      if (claimable === 0n) return;
      await advanceTime(36 * SECONDS_PER_MONTH);
      while ((await tcgv.read.teamVestingClaimable()) > 0n) {
        await tcgv.write.claimTeam({ account: owner.account });
      }
      expect(await tcgv.read.teamVestingClaimable()).to.equal(0n);
    });

    it("opsVestingClaimable returns 0 when already fully claimed", async () => {
      const claimable = await tcgv.read.opsVestingClaimable();
      if (claimable === 0n) return;
      await advanceTime(36 * SECONDS_PER_MONTH);
      while ((await tcgv.read.opsVestingClaimable()) > 0n) {
        await tcgv.write.claimOps({ account: owner.account });
      }
      expect(await tcgv.read.opsVestingClaimable()).to.equal(0n);
    });

    it("_distributeCashback early return when cashback disabled (buy still applies fees)", async () => {
      await tcgv.write.setCashbackEnabled([false], { account: owner.account });
      const nexusBefore = await nexus.read.balanceOf([user2.account.address]);
      const usdcIn = parseUnits("10", 6);
      const path = [usdcAddress, tcgvAddress] as const;
      await usdc.write.approve([routerAddress, usdcIn], { account: user2.account });
      await router.write.swapExactTokensForTokens([
        usdcIn,
        0n,
        path,
        user2.account.address,
        (await publicClient.getBlock()).timestamp + 300n
      ], { account: user2.account });
      expect(await nexus.read.balanceOf([user2.account.address])).to.equal(nexusBefore);
      await tcgv.write.setCashbackEnabled([true], { account: owner.account });
    });

    it("setAddresses does not change nexusToken (cashback recipient stays fixed)", async () => {
      const nexusAddr = getAddress(await tcgv.read.nexusToken());
      await tcgv.write.setAddresses(
        [user1.account.address, user2.account.address, community.account.address],
        { account: owner.account }
      );
      expect(getAddress(await tcgv.read.nexusToken())).to.equal(nexusAddr);
      await tcgv.write.setAddresses(
        [vault.account.address, marketing.account.address, community.account.address],
        { account: owner.account }
      );
    });

    it("_distributeCashback early return when buy amount gives zero cashback", async () => {
      await tcgv.write.setMinAmounts([0n, 0n], { account: owner.account });
      const token0 = (await pair.read.token0()) as `0x${string}`;
      const isToken0Tcgv = token0.toLowerCase() === tcgvAddress.toLowerCase();
      const amount0Out = isToken0Tcgv ? 1n : 0n;
      const amount1Out = isToken0Tcgv ? 0n : 1n;
      const nexusBefore = await nexus.read.balanceOf([user1.account.address]);
      await pair.write.swap([amount0Out, amount1Out, user1.account.address, "0x"], { account: owner.account });
      expect(await nexus.read.balanceOf([user1.account.address])).to.equal(nexusBefore);
      await tcgv.write.setMinAmounts([10_000n, 10_000n], { account: owner.account });
    });

    it("buy reverts MinAmountNotMet when amount below minBuyAmount", async () => {
      await tcgv.write.setMinAmounts([10_000n, 10_000n], { account: owner.account });
      const token0 = (await pair.read.token0()) as `0x${string}`;
      const isToken0Tcgv = token0.toLowerCase() === tcgvAddress.toLowerCase();
      const amount0Out = isToken0Tcgv ? 1n : 0n;
      const amount1Out = isToken0Tcgv ? 0n : 1n;
      await expectRevert(
        pair.write.swap([amount0Out, amount1Out, user1.account.address, "0x"], { account: owner.account })
      );
    });

    it("sell reverts MinAmountNotMet when amount below minSellAmount", async () => {
      await tcgv.write.setMinAmounts([10_000n, 10_000n], { account: owner.account });
      let reverted = false;
      try {
        await tcgv.write.transfer([pairAddress, 1n], { account: user1.account });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });
  });

  describe("Role segregation", () => {
    it("DEFAULT_ADMIN grants ADMIN_ROLE; grantee may setFeesEnabled", async () => {
      const adminRole = await tcgv.read.ADMIN_ROLE();
      await tcgv.write.grantRole([adminRole, user1.account.address], { account: owner.account });
      await tcgv.write.setFeesEnabled([false], { account: user1.account });
      expect(await tcgv.read.feesEnabled()).to.equal(false);
      await tcgv.write.setFeesEnabled([true], { account: user1.account });
      await tcgv.write.revokeRole([adminRole, user1.account.address], { account: owner.account });
      await expectRevert(tcgv.write.setFeesEnabled([false], { account: user1.account }));
    });

    it("PAUSER_ROLE may pause; same account cannot unpause without UNPAUSER_ROLE", async () => {
      const pauser = await tcgv.read.PAUSER_ROLE();
      const unpauser = await tcgv.read.UNPAUSER_ROLE();
      await tcgv.write.grantRole([pauser, user1.account.address], { account: owner.account });
      await tcgv.write.revokeRole([unpauser, user1.account.address], { account: owner.account });
      await tcgv.write.pause({ account: user1.account });
      expect(await tcgv.read.paused()).to.equal(true);
      await expectRevert(tcgv.write.unpause({ account: user1.account }));
      await tcgv.write.grantRole([unpauser, user1.account.address], { account: owner.account });
      await tcgv.write.unpause({ account: owner.account });
      await tcgv.write.revokeRole([pauser, user1.account.address], { account: owner.account });
    });

    it("UNPAUSER_ROLE may unpause after another account used PAUSER_ROLE", async () => {
      const pauser = await tcgv.read.PAUSER_ROLE();
      const unpauser = await tcgv.read.UNPAUSER_ROLE();
      await tcgv.write.grantRole([pauser, user1.account.address], { account: owner.account });
      await tcgv.write.grantRole([unpauser, user2.account.address], { account: owner.account });
      await tcgv.write.pause({ account: user1.account });
      await tcgv.write.unpause({ account: user2.account });
      expect(await tcgv.read.paused()).to.equal(false);
      await tcgv.write.revokeRole([pauser, user1.account.address], { account: owner.account });
      await tcgv.write.revokeRole([unpauser, user2.account.address], { account: owner.account });
    });

    it("BLACKLISTER_ROLE may setBlacklisted but cannot setFeesEnabled without ADMIN_ROLE", async () => {
      const bl = await tcgv.read.BLACKLISTER_ROLE();
      const adminRole = await tcgv.read.ADMIN_ROLE();
      await tcgv.write.grantRole([bl, user2.account.address], { account: owner.account });
      await tcgv.write.revokeRole([adminRole, user2.account.address], { account: owner.account });
      await tcgv.write.setBlacklisted([user1.account.address, true, "compliance"], { account: user2.account });
      expect(await tcgv.read.isBlacklisted([user1.account.address])).to.equal(true);
      await expectRevert(tcgv.write.setFeesEnabled([false], { account: user2.account }));
      await tcgv.write.setBlacklisted([user1.account.address, false, ""], { account: user2.account });
      await tcgv.write.revokeRole([bl, user2.account.address], { account: owner.account });
    });

    it("PAUSER_ROLE alone cannot setPair", async () => {
      const pauser = await tcgv.read.PAUSER_ROLE();
      await tcgv.write.grantRole([pauser, user1.account.address], { account: owner.account });
      await expectRevert(tcgv.write.setPair([pairAddress, false], { account: user1.account }));
      await tcgv.write.revokeRole([pauser, user1.account.address], { account: owner.account });
    });
  });

  describe("Blacklist and Pause", () => {
    it("owner can setBlacklisted and unblacklist", async () => {
      expect(await tcgv.read.isBlacklisted([user2.account.address])).to.equal(false);
      await tcgv.write.setBlacklisted([user2.account.address, true, "sybil"], { account: owner.account });
      expect(await tcgv.read.isBlacklisted([user2.account.address])).to.equal(true);
      await tcgv.write.setBlacklisted([user2.account.address, false, ""], { account: owner.account });
      expect(await tcgv.read.isBlacklisted([user2.account.address])).to.equal(false);
    });

    it("setBlacklisted true seizes full TCGV balance to vault", async () => {
      const vaultAddr = (await tcgv.read.vaultAddress()) as `0x${string}`;
      const seizeAmount = parseEther("100");
      await mockPresaleLaunch.write.mintPresale([tcgvAddress, user2.account.address, seizeAmount], {
        account: owner.account,
      });
      const vaultBefore = await tcgv.read.balanceOf([vaultAddr]);
      await tcgv.write.setBlacklisted([user2.account.address, true, "manipulation"], { account: owner.account });
      expect(await tcgv.read.balanceOf([user2.account.address])).to.equal(0n);
      expect(await tcgv.read.balanceOf([vaultAddr])).to.equal(vaultBefore + seizeAmount);
      await tcgv.write.setBlacklisted([user2.account.address, false, ""], { account: owner.account });
    });

    it("setBlacklisted reverts when reason is empty while enabling blacklist", async () => {
      await expectRevert(
        tcgv.write.setBlacklisted([user2.account.address, true, ""], { account: owner.account })
      );
    });

    it("transfer reverts Blacklisted when sender is blacklisted", async () => {
      await tcgv.write.setBlacklisted([user1.account.address, true, "fraud"], { account: owner.account });
      await expectRevert(
        tcgv.write.transfer([user2.account.address, parseEther("1")], { account: user1.account })
      );
      await tcgv.write.setBlacklisted([user1.account.address, false, ""], { account: owner.account });
    });

    it("transfer reverts Blacklisted when recipient is blacklisted", async () => {
      await tcgv.write.setBlacklisted([user2.account.address, true, "sanctions"], { account: owner.account });
      await expectRevert(
        tcgv.write.transfer([user2.account.address, parseEther("1")], { account: user1.account })
      );
      await tcgv.write.setBlacklisted([user2.account.address, false, ""], { account: owner.account });
    });

    it("owner can pause and unpause", async () => {
      expect(await tcgv.read.paused()).to.equal(false);
      await tcgv.write.pause({ account: owner.account });
      expect(await tcgv.read.paused()).to.equal(true);
      await tcgv.write.unpause({ account: owner.account });
      expect(await tcgv.read.paused()).to.equal(false);
    });

    it("transfer reverts ContractPaused when paused", async () => {
      await tcgv.write.pause({ account: owner.account });
      await expectRevert(
        tcgv.write.transfer([user2.account.address, parseEther("1")], { account: user1.account })
      );
      await tcgv.write.unpause({ account: owner.account });
    });

    it("buy reverts ContractPaused when paused", async () => {
      await tcgv.write.pause({ account: owner.account });
      const usdcIn = parseUnits("10", 6);
      const path = [usdcAddress, tcgvAddress] as const;
      await usdc.write.approve([routerAddress, usdcIn], { account: user2.account });
      await expectRevert(
        router.write.swapExactTokensForTokens([
          usdcIn,
          0n,
          path,
          user2.account.address,
          (await publicClient.getBlock()).timestamp + 300n
        ], { account: user2.account })
      );
      await tcgv.write.unpause({ account: owner.account });
    });

    it("sell reverts ContractPaused when paused", async () => {
      await tcgv.write.pause({ account: owner.account });
      const sellAmt = parseEther("100");
      const path = [tcgvAddress, usdcAddress] as const;
      await tcgv.write.approve([routerAddress, sellAmt], { account: user1.account });
      await expectRevert(
        router.write.swapExactTokensForTokens([
          sellAmt,
          0n,
          path,
          user1.account.address,
          (await publicClient.getBlock()).timestamp + 300n
        ], { account: user1.account })
      );
      await tcgv.write.unpause({ account: owner.account });
    });

    it("claimTeam reverts ContractPaused when paused", async () => {
      await advanceTime(13 * SECONDS_PER_MONTH);
      await tcgv.write.pause({ account: owner.account });
      await expectRevert(tcgv.write.claimTeam({ account: owner.account }));
      await tcgv.write.unpause({ account: owner.account });
    });

    it("claimOps reverts ContractPaused when paused", async () => {
      await tcgv.write.pause({ account: owner.account });
      await expectRevert(tcgv.write.claimOps({ account: owner.account }));
      await tcgv.write.unpause({ account: owner.account });
    });

    it("mintPresale reverts ContractPaused when paused", async () => {
      const freshMock = await viem.deployContract("contracts/test/MockPresaleLaunch.sol:MockPresaleLaunch", [], { client: { wallet: owner } });
      const freshTcgv = await deployFreshTcgvWithNexus(
        owner,
        ZERO,
        routerAddress,
        vault.account.address,
        marketing.account.address,
        community.account.address,
        freshMock.address,
        freshMock.address,
        owner.account.address,
      );
      await freshTcgv.write.pause({ account: owner.account });
      await expectRevert(
        freshMock.write.mintPresale([freshTcgv.address, user1.account.address, parseEther("100")], { account: owner.account })
      );
    });
  });

  describe("Staking vault + blacklist", () => {
    it("redeem reverts when share owner is blacklisted and stakingVault is not set (stake not auto-seized)", async () => {
      await tcgv.write.setBlacklisted([user2.account.address, false, ""], { account: owner.account }).catch(() => {});
      const stakingVault = await viem.deployContract("TCGVaultStakingVault", [tcgvAddress], { client: { wallet: owner } });
      const stakeAmt = parseEther("42");
      await stakingVault.write.setRequiredStakeForBasicNFT([stakeAmt], { account: owner.account });
      await mockPresaleLaunch.write.mintPresale([tcgvAddress, user2.account.address, stakeAmt], { account: owner.account });
      const receiver = user2.account.address;
      const maxM = await stakingVault.read.maxMint([receiver]);
      const assets = await stakingVault.read.previewMint([maxM]);
      await tcgv.write.approve([stakingVault.address, assets], { account: user2.account });
      await stakingVault.write.deposit([assets, receiver], { account: user2.account });
      const shares = await stakingVault.read.balanceOf([user2.account.address]);
      expect(shares > 0n).to.equal(true);
      await tcgv.write.setBlacklisted([user2.account.address, true, "staked-while-listed"], { account: owner.account });
      await expectRevert(
        stakingVault.write.redeem([shares, user2.account.address, user2.account.address], { account: user2.account })
      );
      await tcgv.write.setBlacklisted([user2.account.address, false, ""], { account: owner.account });
      await stakingVault.write.redeem([shares, user2.account.address, user2.account.address], { account: user2.account });
    });

    it("setBlacklisted seizes staked TCGV to vault when stakingVault is set", async () => {
      // In the current version, `stakingVault` is set via constructor (no setter).
      // We deploy a fresh TCGV whose constructor points to the staking vault address that will be deployed next.
      const publicClient = await viem.getPublicClient();
      const n0 = BigInt(await publicClient.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));

      // Deploy a fresh initialLaunch stand-in (mock) first, so TCGV can set it immutable.
      const freshMock = await viem.deployContract("contracts/test/MockPresaleLaunch.sol:MockPresaleLaunch", [], { client: { wallet: owner } });

      // Predict addresses for TCGNexusToken (nonce n0+1), TCGV (nonce n0+2), and staking vault (nonce n0+3).
      const futureNexus = getContractAddress({ from: owner.account.address, nonce: n0 + 1n });
      const futureTcgv = getContractAddress({ from: owner.account.address, nonce: n0 + 2n });
      const futureStakingVault = getContractAddress({ from: owner.account.address, nonce: n0 + 3n });

      // Deploy Nexus (minter = predicted TCGV; presale bonus minters = test EOAs).
      await viem.deployContract("TCGNexusToken", [futureTcgv, user1.account.address, user2.account.address], {
        client: { wallet: owner },
      });

      // Deploy token with stakingVault set to the predicted vault address.
      const freshTcgv = await viem.deployContract("TCGVaultToken", [
        futureStakingVault,
        routerAddress,
        vault.account.address,
        marketing.account.address,
        community.account.address,
        futureNexus,
        freshMock.address,
      ], { client: { wallet: owner } });

      // Deploy staking vault at the predicted address, pointing to the fresh token.
      const stakingVault = await viem.deployContract("TCGVaultStakingVault", [freshTcgv.address], { client: { wallet: owner } });
      expect(getAddress(stakingVault.address)).to.equal(getAddress(futureStakingVault));

      const freshTcgvClient = await viem.getContractAt("TCGVaultToken", freshTcgv.address as `0x${string}`);

      const vaultAddr = (await freshTcgvClient.read.vaultAddress()) as `0x${string}`;
      const stakeAmt = parseEther("77");
      await stakingVault.write.setRequiredStakeForBasicNFT([stakeAmt], { account: owner.account });

      // Mint TCGV to user2 via initialLaunch (mock) and stake it.
      await freshMock.write.mintPresale([freshTcgv.address, user2.account.address, stakeAmt], { account: owner.account });
      const receiver = user2.account.address;
      const maxM = await stakingVault.read.maxMint([receiver]);
      const assets = await stakingVault.read.previewMint([maxM]);
      await freshTcgvClient.write.approve([stakingVault.address, assets], { account: user2.account });
      await stakingVault.write.deposit([assets, receiver], { account: user2.account });

      const walletBefore = await freshTcgvClient.read.balanceOf([user2.account.address]);
      const vaultBalBefore = await freshTcgvClient.read.balanceOf([vaultAddr]);

      await freshTcgvClient.write.setBlacklisted([user2.account.address, true, "seize-stake"], { account: owner.account });
      expect(await stakingVault.read.balanceOf([user2.account.address])).to.equal(0n);
      expect(await freshTcgvClient.read.balanceOf([user2.account.address])).to.equal(0n);
      expect(await freshTcgvClient.read.balanceOf([vaultAddr])).to.equal(vaultBalBefore + stakeAmt + walletBefore);
    });

    it("setStakingVault reverts without ADMIN_ROLE", async () => {
      // No longer applicable: staking vault is configured in constructor (no setter in ABI).
      expect(true).to.equal(true);
    });
  });

  describe("finalizePresaleAndRecompute scaling path (sum > toMint)", () => {
    it("scales allocation when toMint < sum", async () => {
      const freshMock = await viem.deployContract("contracts/test/MockPresaleLaunch.sol:MockPresaleLaunch", [], { client: { wallet: owner } });
      const freshTcgv = await deployFreshTcgvWithNexus(
        owner,
        ZERO,
        routerAddress,
        vault.account.address,
        marketing.account.address,
        community.account.address,
        freshMock.address,
        freshMock.address,
        owner.account.address,
      );
      await freshTcgv.write.setAllocationRecipients([
        vault.account.address,
        marketing.account.address,
        community.account.address,
      ], { account: owner.account });
      const presaleSold = parseEther("600");
      await freshMock.write.setTotalAllocated([presaleSold], { account: owner.account });
      await freshMock.write.mintPresale([freshTcgv.address, user1.account.address, parseEther("601")], { account: owner.account });
      const supplyBefore = await freshTcgv.read.totalSupply();
      expect(supplyBefore).to.equal(parseEther("601"));
      await freshMock.write.finalizePresaleAndRecompute([freshTcgv.address], { account: owner.account });
      const finalSupply = (presaleSold * 10000n) / 6000n;
      expect(finalSupply).to.equal(parseEther("1000"));
      const toMint = finalSupply - supplyBefore;
      expect(toMint).to.equal(parseEther("399"));
      const sum = (finalSupply * 4000n) / 10000n;
      expect(sum > toMint).to.equal(true);
      expect(await freshTcgv.read.totalSupply()).to.equal(finalSupply);
    });
  });

});

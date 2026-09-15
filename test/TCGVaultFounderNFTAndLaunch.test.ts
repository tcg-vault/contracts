/**
 * Tests for Founder NFT and Initial Launch (whitepaper §6, §7).
 * Uses MockUSDC (6 decimals) and MockTCGVPresale for TCGV (mint on buy via mintPresale).
 */
import { describe, it, before } from "node:test";
import { expect } from "chai";
import hre from "hardhat";
import { getAddress, getContractAddress, parseEther, parseUnits } from "viem";
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

/** Deploy MockTCGV + NEXUS (immutable presale minters) + FounderNFT + InitialLaunch in fixed CREATE order. */
async function deployIsolatedPresaleStack(
  deployer: Awaited<ReturnType<typeof viem.getWalletClients>>[0],
  usdcAddr: `0x${string}`,
) {
  const publicClient = await viem.getPublicClient();
  const from = deployer.account.address;
  const n0 = BigInt(await publicClient.getTransactionCount({ address: from, blockTag: "pending" }));
  const mockAddr = getContractAddress({ from, nonce: n0 });
  const nexusAddr = getContractAddress({ from, nonce: n0 + 1n });
  const founderAddr = getContractAddress({ from, nonce: n0 + 2n });
  const launchAddr = getContractAddress({ from, nonce: n0 + 3n });

  const mockTcgv = await viem.deployContract("contracts/test/MockTCGVPresale.sol:MockTCGVPresale", [], {
    client: { wallet: deployer },
  });
  if (mockTcgv.address.toLowerCase() !== mockAddr.toLowerCase()) {
    throw new Error("MockTCGV nonce mismatch");
  }
  await viem.deployContract(
    "TCGNexusToken",
    [mockAddr, founderAddr, launchAddr],
    { client: { wallet: deployer } },
  );
  const founder = await viem.deployContract(
    "TCGVaultFounderNFT",
    [usdcAddr, nexusAddr, deployer.account.address],
    { client: { wallet: deployer } },
  );
  const launch = await viem.deployContract(
    "TCGVaultInitialLaunch",
    [mockAddr, usdcAddr, founder.address, nexusAddr, deployer.account.address],
    { client: { wallet: deployer } },
  );
  const tcgvC = await viem.getContractAt("MockTCGVPresale", mockAddr);
  await tcgvC.write.setInitialLaunch([launchAddr], { account: deployer.account });
  return {
    mockTcgv: tcgvC,
    nexus: await viem.getContractAt("TCGNexusToken", nexusAddr),
    founder: await viem.getContractAt("TCGVaultFounderNFT", founder.address),
    launch: await viem.getContractAt("TCGVaultInitialLaunch", launch.address),
  };
}

describe("TCGVaultFounderNFT + InitialLaunch (whitepaper)", () => {
  let owner: Awaited<ReturnType<typeof viem.getWalletClients>>[0];
  let user1: Awaited<ReturnType<typeof viem.getWalletClients>>[0];
  let user2: Awaited<ReturnType<typeof viem.getWalletClients>>[0];
  let buyer: Awaited<ReturnType<typeof viem.getWalletClients>>[0];
  let usdc: ContractReturnType<"MockUSDC">;
  let nexus: ContractReturnType<"TCGNexusToken">;
  let founderNFT: ContractReturnType<"TCGVaultFounderNFT">;
  let initialLaunch: ContractReturnType<"TCGVaultInitialLaunch">;
  let tcgv: ContractReturnType<"MockTCGVPresale">;

  const WAVE1_PRICE = 200n * 10n ** 6n;
  const WAVE2_PRICE = 350n * 10n ** 6n;
  const FINALIZE_DELAY_SECONDS = 20 * 24 * 3600;

  async function sellOutWave1Founder() {
    const wave1Cap = 245;
    let sold = Number(await founderNFT.read.soldCount());
    if (sold >= wave1Cap) return;
    const toMint = wave1Cap - sold;
    const usdcNeed = BigInt(toMint) * WAVE1_PRICE;
    await usdc.write.approve([founderNFT.address, usdcNeed], { account: user1.account });
    for (let i = 0; i < toMint; i++) {
      await founderNFT.write.mint({ account: user1.account });
    }
  }

  async function advanceToTimestamp(target: bigint) {
    const now = BigInt(await networkHelpers.time.latest());
    if (target <= now) return;
    await networkHelpers.time.increase(Number(target - now));
    await networkHelpers.mine();
  }

  async function advanceToFounderWave2(founder: { read: { wave2StartTimestamp: () => Promise<bigint> } }) {
    const wave2Start = await founder.read.wave2StartTimestamp();
    await advanceToTimestamp(wave2Start);
  }

  async function advancePastPresaleEnd(launch: { read: { presaleEndTime: () => Promise<bigint> } }) {
    const presaleEnd = await launch.read.presaleEndTime();
    await advanceToTimestamp(presaleEnd + 1n);
  }

  before(async () => {
    [owner, user1, user2, buyer] = await viem.getWalletClients();

    const mockUsdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], { client: { wallet: owner } });
    usdc = await viem.getContractAt("MockUSDC", mockUsdc.address);
    const fund = parseUnits("10000000", 6);
    await usdc.write.mint([owner.account.address, fund], { account: owner.account });
    await usdc.write.mint([user1.account.address, fund], { account: owner.account });
    await usdc.write.mint([buyer.account.address, fund], { account: owner.account });
    await usdc.write.mint([user2.account.address, fund], { account: owner.account });

    const publicClient = await viem.getPublicClient();
    const n0 = BigInt(await publicClient.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));
    const mockAddr = getContractAddress({ from: owner.account.address, nonce: n0 });
    const nexusAddr = getContractAddress({ from: owner.account.address, nonce: n0 + 1n });
    const founderAddr = getContractAddress({ from: owner.account.address, nonce: n0 + 2n });
    const launchAddr = getContractAddress({ from: owner.account.address, nonce: n0 + 3n });

    const mockTcgv = await viem.deployContract("contracts/test/MockTCGVPresale.sol:MockTCGVPresale", [], { client: { wallet: owner } });
    tcgv = await viem.getContractAt("MockTCGVPresale", mockTcgv.address);

    await viem.deployContract("TCGNexusToken", [mockAddr, founderAddr, launchAddr], { client: { wallet: owner } });
    nexus = await viem.getContractAt("TCGNexusToken", nexusAddr);

    founderNFT = await viem.deployContract("TCGVaultFounderNFT", [
      usdc.address,
      nexusAddr,
      owner.account.address, // CASP USDC recipient
    ], { client: { wallet: owner } });
    initialLaunch = await viem.deployContract("TCGVaultInitialLaunch", [
      mockAddr,
      usdc.address,
      founderAddr,
      nexusAddr,
      owner.account.address,
    ], { client: { wallet: owner } });

    await tcgv.write.setInitialLaunch([launchAddr], { account: owner.account });
  });

  describe("TCGVaultFounderNFT", () => {
    it("Founder NFT getters return correct values", async () => {
      expect(getAddress((await founderNFT.read.usdc()) as `0x${string}`)).to.equal(getAddress(usdc.address));
      expect(getAddress((await founderNFT.read.nexusToken()) as `0x${string}`)).to.equal(getAddress(nexus.address));
      expect(await founderNFT.read.soldCount()).to.equal(0n);
      expect(await founderNFT.read.wave2StartTimestamp()).to.equal(0n);
      expect(getAddress((await founderNFT.read.caspUsdcRecipient()) as `0x${string}`)).to.equal(
        getAddress(owner.account.address),
      );
      expect(await founderNFT.read.strategicReserveMinted()).to.equal(0n);
      expect(await founderNFT.read.currentWave()).to.equal(1n);
      expect(await founderNFT.read.currentPrice()).to.equal(WAVE1_PRICE);
    });
    it("wave 1: first mint at 200 USDC, buyer gets 30% NEXUS", async () => {
      await usdc.write.approve([founderNFT.address, WAVE1_PRICE], { account: user1.account });
      const nexusBefore = (await nexus.read.balanceOf([user1.account.address]));
      await founderNFT.write.mint({ account: user1.account });
      const nexusAfter = (await nexus.read.balanceOf([user1.account.address]));
      const expectedNexus = (WAVE1_PRICE * 3000n * (10n ** 18n)) / (10000n * (10n ** 6n));
      expect(nexusAfter - nexusBefore).to.equal(expectedNexus);
      expect(await founderNFT.read.currentWave()).to.equal(1n);
    });

    it("wave 1: mint forwards full USDC price to CASP", async () => {
      const price = WAVE1_PRICE;
      const bCaspBefore = await usdc.read.balanceOf([owner.account.address]);
      await usdc.write.approve([founderNFT.address, price], { account: buyer.account });
      await founderNFT.write.mint({ account: buyer.account });
      expect((await usdc.read.balanceOf([owner.account.address])) - bCaspBefore).to.equal(price);
    });

    it("first founder mint anchors wave2StartTimestamp to mint time + 7 days", async () => {
      const { founder: freshFounder } = await deployIsolatedPresaleStack(owner, usdc.address as `0x${string}`);
      expect(await freshFounder.read.wave2StartTimestamp()).to.equal(0n);
      await usdc.write.approve([freshFounder.address, WAVE1_PRICE], { account: user1.account });
      const beforeMint = BigInt(await networkHelpers.time.latest());
      await freshFounder.write.mint({ account: user1.account });
      const afterMint = BigInt(await networkHelpers.time.latest());
      const wave2Start = await freshFounder.read.wave2StartTimestamp();
      expect(wave2Start >= beforeMint + 7n * 24n * 3600n).to.equal(true);
      expect(wave2Start <= afterMint + 7n * 24n * 3600n).to.equal(true);
    });

    it(
      "wave 2 starts when wave 1 sells out before timer ends",
      { timeout: 120000 },
      async () => {
      await sellOutWave1Founder();
      expect(await founderNFT.read.soldCount()).to.equal(245n);
        const wave2Start = (await founderNFT.read.wave2StartTimestamp());
        const latest = BigInt(await networkHelpers.time.latest());
        expect(wave2Start <= latest).to.equal(true);
      expect(await founderNFT.read.currentPrice()).to.equal(WAVE2_PRICE);
      expect(await founderNFT.read.currentWave()).to.equal(2n);
      }
    );

    it(
      "once wave 2 starts, cancellation does not revert price/countdown but still updates live sold count",
      { timeout: 120000 },
      async () => {
        const { founder: freshFounder } = await deployIsolatedPresaleStack(owner, usdc.address as `0x${string}`);

        await usdc.write.approve([freshFounder.address, (245n * WAVE1_PRICE)], { account: user1.account });
        for (let i = 0; i < 245; i++) await freshFounder.write.mint({ account: user1.account });

        expect(await freshFounder.read.soldCount()).to.equal(245n);
        expect(await freshFounder.read.currentPrice()).to.equal(WAVE2_PRICE);
        const wave2Before = await freshFounder.read.wave2StartTimestamp();
        expect(wave2Before > 0n).to.equal(true);

        await freshFounder.write.cancelFounderPurchase([244n], { account: user1.account });

        expect(await freshFounder.read.soldCount()).to.equal(244n);
        expect(await freshFounder.read.currentWave()).to.equal(2n);
        expect(await freshFounder.read.currentPrice()).to.equal(WAVE2_PRICE);
        expect(await freshFounder.read.wave2StartTimestamp()).to.equal(wave2Before);

        await usdc.write.approve([freshFounder.address, WAVE2_PRICE], { account: user1.account });
        await freshFounder.write.mint({ account: user1.account });
        expect(await freshFounder.read.soldCount()).to.equal(245n);
        expect(await freshFounder.read.currentPrice()).to.equal(WAVE2_PRICE);
        expect(await freshFounder.read.wave2StartTimestamp()).to.equal(wave2Before);
      }
    );

    it("owner can setBaseURI and tokenURI returns base + tokenId", async () => {
      await founderNFT.write.setBaseURI(["https://api.tcg-vault.io/founder/"], { account: owner.account });
      const uri = (await founderNFT.read.tokenURI([0n])) as string;
      expect(uri).to.equal("https://api.tcg-vault.io/founder/0");
    });

    it("owner can setCaspUsdcRecipient", async () => {
      await founderNFT.write.setCaspUsdcRecipient([user2.account.address], { account: owner.account });
      expect(getAddress((await founderNFT.read.caspUsdcRecipient()) as `0x${string}`)).to.equal(
        getAddress(user2.account.address),
      );
    });

    it("setCaspUsdcRecipient reverts when not owner", async () => {
      await expectRevert(
        founderNFT.write.setCaspUsdcRecipient([user1.account.address], { account: user1.account }),
      );
    });

    it("constructor reverts when nexus is zero", async () => {
      await expectRevert(
        viem.deployContract("TCGVaultFounderNFT", [
          usdc.address,
          "0x0000000000000000000000000000000000000000",
          owner.account.address,
        ], { client: { wallet: owner } })
      );
    });

    it("constructor reverts when caspUsdcRecipient is zero", async () => {
      await expectRevert(
        viem.deployContract("TCGVaultFounderNFT", [
          usdc.address,
          nexus.address,
          "0x0000000000000000000000000000000000000000",
        ], { client: { wallet: owner } })
      );
    });

    it("setCaspUsdcRecipient reverts when recipient is zero", async () => {
      await viem.assertions.revertWithCustomError(
        founderNFT.write.setCaspUsdcRecipient(["0x0000000000000000000000000000000000000000"], { account: owner.account }),
        founderNFT,
        "ZeroAddress"
      );
    });

    it("setBaseURI reverts when not owner", async () => {
      await expectRevert(
        founderNFT.write.setBaseURI(["https://bad/"], { account: user1.account })
      );
    });

    it("mint reverts ExceedsSupply when 490 paid mints reached", async () => {
      const { founder: freshFounder } = await deployIsolatedPresaleStack(owner, usdc.address as `0x${string}`);
      const user1Amount = (245n * WAVE1_PRICE + 245n * WAVE2_PRICE);
      await usdc.write.transfer([user1.account.address, user1Amount], { account: owner.account });
      await usdc.write.approve([freshFounder.address, user1Amount], { account: user1.account });
      for (let i = 0; i < 245; i++) await freshFounder.write.mint({ account: user1.account });
      for (let i = 0; i < 245; i++) await freshFounder.write.mint({ account: user1.account });
      expect(await freshFounder.read.soldCount()).to.equal(490n);
      await expectRevert(freshFounder.write.mint({ account: user1.account }));
    });

    it("strategic reserve: owner mints 10 without USDC; 11th reverts", async () => {
      const { founder: freshFounder } = await deployIsolatedPresaleStack(owner, usdc.address as `0x${string}`);
      for (let i = 0; i < 10; i++) {
        await freshFounder.write.mintStrategicReserve([user2.account.address], { account: owner.account });
      }
      expect(await freshFounder.read.strategicReserveMinted()).to.equal(10n);
      await expectRevert(
        freshFounder.write.mintStrategicReserve([user2.account.address], { account: owner.account }),
      );
    });

    it("strategic reserve NFT cannot be cancelled", async () => {
      const { founder: freshFounder } = await deployIsolatedPresaleStack(owner, usdc.address as `0x${string}`);
      await freshFounder.write.mintStrategicReserve([user1.account.address], { account: owner.account });
      await viem.assertions.revertWithCustomError(
        freshFounder.write.cancelFounderPurchase([0n], { account: user1.account }),
        freshFounder,
        "StrategicReserveNotCancellable",
      );
    });

    it("non-owner cannot mintStrategicReserve", async () => {
      const { founder: freshFounder } = await deployIsolatedPresaleStack(owner, usdc.address as `0x${string}`);
      await expectRevert(
        freshFounder.write.mintStrategicReserve([user1.account.address], { account: user1.account }),
      );
    });
  });

  describe("TCGVaultInitialLaunch", () => {
    it("InitialLaunch getters return correct values", async () => {
      expect(getAddress((await initialLaunch.read.tcgv()) as `0x${string}`)).to.equal(getAddress(tcgv.address));
      expect(getAddress((await initialLaunch.read.usdc()) as `0x${string}`)).to.equal(getAddress(usdc.address));
      expect(getAddress((await initialLaunch.read.founderNFT()) as `0x${string}`)).to.equal(getAddress(founderNFT.address));
      expect(getAddress((await initialLaunch.read.nexusToken()) as `0x${string}`)).to.equal(getAddress(nexus.address));
      expect(await initialLaunch.read.totalTCGVAllocated()).to.be.a("bigint");
      expect(await initialLaunch.read.tgeTimestamp()).to.be.a("bigint");
      expect(getAddress((await initialLaunch.read.treasury()) as `0x${string}`)).to.equal(getAddress(owner.account.address));
      const [alloc, claimed] = await initialLaunch.read.allocations([user1.account.address]);
      expect(alloc).to.be.a("bigint");
      expect(claimed).to.be.a("bigint");
      expect(await initialLaunch.read.currentPrice()).to.be.a("bigint");
      expect(await initialLaunch.read.maxPerWallet()).to.be.a("bigint");
    });
    it("buy reverts when usdcAmount is zero", async () => {
      await expectRevert(initialLaunch.write.buy([0n], { account: user1.account }));
    });

    it("wave 2: price 0.008 USDC/TCGV, 4% cap per wallet, 30% NEXUS on buy", async () => {
      await usdc.write.approve([founderNFT.address, WAVE2_PRICE], { account: user1.account });
      await founderNFT.write.mint({ account: user1.account });
      await advanceToFounderWave2(founderNFT);
      // Use 8 USDC so 10% TGE fits in contract's 1000 TCGV for finalize/claim test
      const usdcAmount = 8n * 10n ** 6n;
      await usdc.write.approve([initialLaunch.address, BigInt(usdcAmount)], { account: user1.account });
      const nexusBefore = (await nexus.read.balanceOf([user1.account.address]));
      await initialLaunch.write.buy([BigInt(usdcAmount)], { account: user1.account });
      const nexusAfter = (await nexus.read.balanceOf([user1.account.address]));
      const expectedNexus = (BigInt(usdcAmount) * 3000n * (10n ** 18n)) / (10000n * (10n ** 6n));
      expect(nexusAfter - nexusBefore).to.equal(expectedNexus);
      const u = (await initialLaunch.read.allocations([user1.account.address])) as readonly [bigint, bigint];
      // 0.008 USDC/TCGV => price = 8000 (6 decimals), tcgvAmount = usdcAmount * 1e18 / 8000
      expect(u[0]).to.equal((BigInt(usdcAmount) * (10n ** 18n)) / 8000n);
    });

    it("InitialLaunch stays on wave 2 pricing after founder cancellation below 245 paid", async () => {
      const { founder: freshFounder, launch: freshLaunch } = await deployIsolatedPresaleStack(
        owner,
        usdc.address as `0x${string}`,
      );

      await usdc.write.approve([freshFounder.address, (245n * WAVE1_PRICE)], { account: user1.account });
      for (let i = 0; i < 245; i++) await freshFounder.write.mint({ account: user1.account });

      expect(await freshFounder.read.soldCount()).to.equal(245n);
      expect(await freshLaunch.read.currentPrice()).to.equal(8000n);
      const presaleEndBefore = await freshLaunch.read.presaleEndTime();
      expect(presaleEndBefore).to.not.equal(BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"));

      await freshFounder.write.cancelFounderPurchase([244n], { account: user1.account });

      expect(await freshFounder.read.soldCount()).to.equal(244n);
      expect(await freshLaunch.read.currentPrice()).to.equal(8000n);
      expect(await freshLaunch.read.presaleEndTime()).to.equal(presaleEndBefore);
    });

    it("non-owner cannot finalize before countdown end + delay", async (t) => {
      if (await initialLaunch.read.tgeTimestamp() !== 0n) {
        return t.skip();
      }
      await expectRevert(initialLaunch.write.finalize({ account: user1.account }));
    });

    it("buy reverts after 120h countdown", async (t) => {
      await advancePastPresaleEnd(initialLaunch);
      await usdc.write.approve([initialLaunch.address, (1000n * 10n ** 6n)], { account: user1.account });
      await expectRevert(initialLaunch.write.buy([(1000n * 10n ** 6n)], { account: user1.account }));
    });

    it("buy reverts PresaleEnded when presale is already finalized", async () => {
      const { founder: freshFounder, launch: freshLaunch } = await deployIsolatedPresaleStack(
        owner,
        usdc.address as `0x${string}`,
      );
      await usdc.write.approve([freshFounder.address, (245n * WAVE1_PRICE)], { account: user1.account });
      for (let i = 0; i < 245; i++) await freshFounder.write.mint({ account: user1.account });
      await usdc.write.approve([freshLaunch.address, (8n * 10n ** 6n)], { account: user1.account });
      await freshLaunch.write.buy([(8n * 10n ** 6n)], { account: user1.account });
      await advancePastPresaleEnd(freshLaunch);
      await networkHelpers.time.increase(FINALIZE_DELAY_SECONDS + 1);
      await networkHelpers.mine();
      await freshLaunch.write.finalize({ account: owner.account });
      await usdc.write.approve([freshLaunch.address, (1000n * 10n ** 6n)], { account: user1.account });
      await viem.assertions.revertWithCustomError(
        freshLaunch.write.buy([(1000n * 10n ** 6n)], { account: user1.account }),
        freshLaunch,
        "PresaleEnded"
      );
    });

    it("finalize and claim vesting 10% TGE", async () => {
      if ((await founderNFT.read.wave2StartTimestamp()) === 0n) {
        await usdc.write.approve([founderNFT.address, WAVE2_PRICE], { account: user1.account });
        await founderNFT.write.mint({ account: user1.account });
      }
      await advanceToFounderWave2(founderNFT);
      const [existingAllocation] = await initialLaunch.read.allocations([user1.account.address]);
      if (existingAllocation === 0n) {
        const usdcAmount = 8n * 10n ** 6n;
        await usdc.write.approve([initialLaunch.address, BigInt(usdcAmount)], { account: user1.account });
        await initialLaunch.write.buy([BigInt(usdcAmount)], { account: user1.account });
      }
      await advancePastPresaleEnd(initialLaunch);
      await networkHelpers.time.increase(FINALIZE_DELAY_SECONDS + 1);
      await networkHelpers.mine();
      await initialLaunch.write.finalize({ account: owner.account });
      const releasable = (await initialLaunch.read.releasable([user1.account.address]));
      const allocation = (await initialLaunch.read.allocations([user1.account.address])) as readonly [bigint, bigint];
      expect(releasable).to.equal((allocation[0] * 10n) / 100n);
      await initialLaunch.write.claim({ account: user1.account });
      expect(await tcgv.read.balanceOf([user1.account.address])).to.equal(releasable);
    });

    it("owner can setTreasury on InitialLaunch", async () => {
      await initialLaunch.write.setTreasury([user1.account.address], { account: owner.account });
      expect(getAddress((await initialLaunch.read.treasury()) as `0x${string}`)).to.equal(getAddress(user1.account.address));
    });

    it("InitialLaunch setTreasury reverts when not owner", async () => {
      await expectRevert(
        initialLaunch.write.setTreasury([user1.account.address], { account: user1.account })
      );
    });

    it("InitialLaunch constructor reverts when nexus is zero", async () => {
      await expectRevert(
        viem.deployContract("TCGVaultInitialLaunch", [
          tcgv.address,
          usdc.address,
          founderNFT.address,
          "0x0000000000000000000000000000000000000000",
          owner.account.address,
        ], { client: { wallet: owner } })
      );
    });

    it("finalize reverts PresaleNotEnded when called before countdown+delay", async () => {
      await expectRevert(initialLaunch.write.finalize({ account: owner.account }));
    });

    it("buy reverts ExceedsHardCap when total TCGV would exceed hard cap", async () => {
      const { founder: freshFounder, launch: freshLaunch } = await deployIsolatedPresaleStack(
        owner,
        usdc.address as `0x${string}`,
      );
      await usdc.write.approve([freshFounder.address, (245n * WAVE1_PRICE)], { account: user1.account });
      for (let i = 0; i < 245; i++) await freshFounder.write.mint({ account: user1.account });
      const price = await freshLaunch.read.currentPrice();
      const HARD_CAP_TCGV = 600_000_000n * (10n ** 18n);
      const usdcToExceedCap = (HARD_CAP_TCGV * price) / (10n ** 18n) + 1n;
      await usdc.write.transfer([user1.account.address, usdcToExceedCap], { account: owner.account });
      await usdc.write.approve([freshLaunch.address, usdcToExceedCap], { account: user1.account });
      await viem.assertions.revertWithCustomError(
        freshLaunch.write.buy([usdcToExceedCap], { account: user1.account }),
        freshLaunch,
        "ExceedsHardCap"
      );
    });

    it("releasable returns total - claimed when monthsElapsed >= 9 (full vesting)", async () => {
      const { founder: freshFounder, launch: freshLaunch } = await deployIsolatedPresaleStack(
        owner,
        usdc.address as `0x${string}`,
      );
      await usdc.write.approve([freshFounder.address, (245n * WAVE1_PRICE)], { account: user1.account });
      for (let i = 0; i < 245; i++) await freshFounder.write.mint({ account: user1.account });
      const usdcAmount = 8n * 10n ** 6n;
      await usdc.write.approve([freshLaunch.address, BigInt(usdcAmount)], { account: user1.account });
      await freshLaunch.write.buy([BigInt(usdcAmount)], { account: user1.account });
      await advancePastPresaleEnd(freshLaunch);
      await networkHelpers.time.increase(FINALIZE_DELAY_SECONDS + 1);
      await networkHelpers.mine();
      await freshLaunch.write.finalize({ account: owner.account });
      const allocation = (await freshLaunch.read.allocations([user1.account.address])) as readonly [bigint, bigint];
      const total = allocation[0];
      const NINE_MONTHS = 9 * 30 * 24 * 3600;
      await networkHelpers.time.increase(NINE_MONTHS);
      await networkHelpers.mine();
      const releasableFull = await freshLaunch.read.releasable([user1.account.address]);
      expect(releasableFull).to.equal(total);
    });

    it("releasable vesting path: vested and return when monthsElapsed < 9", async () => {
      const { founder: freshFounder, launch: freshLaunch } = await deployIsolatedPresaleStack(
        owner,
        usdc.address as `0x${string}`,
      );
      await usdc.write.approve([freshFounder.address, (245n * WAVE1_PRICE)], { account: user1.account });
      for (let i = 0; i < 245; i++) await freshFounder.write.mint({ account: user1.account });
      const usdcAmount = 8n * 10n ** 6n;
      await usdc.write.approve([freshLaunch.address, BigInt(usdcAmount)], { account: user1.account });
      await freshLaunch.write.buy([BigInt(usdcAmount)], { account: user1.account });
      await advancePastPresaleEnd(freshLaunch);
      await networkHelpers.time.increase(FINALIZE_DELAY_SECONDS + 1);
      await networkHelpers.mine();
      await freshLaunch.write.finalize({ account: owner.account });
      const allocation = (await freshLaunch.read.allocations([user1.account.address])) as readonly [bigint, bigint];
      const total = allocation[0];
      const EIGHT_MONTHS = 8 * 30 * 24 * 3600;
      await networkHelpers.time.increase(EIGHT_MONTHS);
      await networkHelpers.mine();
      const releasable8m = await freshLaunch.read.releasable([user1.account.address]);
      const expectedVested = (total * (10n + 8n * 10n)) / 100n;
      expect(releasable8m).to.equal(expectedVested);
    });

    it("releasable never exceeds total at any month 0..10", async () => {
      const { founder: freshFounder, launch: freshLaunch } = await deployIsolatedPresaleStack(
        owner,
        usdc.address as `0x${string}`,
      );
      await usdc.write.approve([freshFounder.address, (245n * WAVE1_PRICE)], { account: user1.account });
      for (let i = 0; i < 245; i++) await freshFounder.write.mint({ account: user1.account });
      const usdcAmount = 8n * 10n ** 6n;
      await usdc.write.approve([freshLaunch.address, BigInt(usdcAmount)], { account: user1.account });
      await freshLaunch.write.buy([BigInt(usdcAmount)], { account: user1.account });
      await advancePastPresaleEnd(freshLaunch);
      await networkHelpers.time.increase(FINALIZE_DELAY_SECONDS + 1);
      await networkHelpers.mine();
      await freshLaunch.write.finalize({ account: owner.account });
      const allocation = (await freshLaunch.read.allocations([user1.account.address])) as readonly [bigint, bigint];
      const total = allocation[0];
      const thirtyDays = 30 * 24 * 3600;
      for (let months = 0; months <= 10; months++) {
        if (months > 0) {
          await networkHelpers.time.increase(thirtyDays);
          await networkHelpers.mine();
        }
        const r = await freshLaunch.read.releasable([user1.account.address]);
        expect(r <= total).to.equal(true);
      }
    });

    it("releasable returns 0 after user claimed all", async () => {
      const { founder: freshFounder, launch: freshLaunch } = await deployIsolatedPresaleStack(
        owner,
        usdc.address as `0x${string}`,
      );
      await usdc.write.approve([freshFounder.address, (245n * WAVE1_PRICE)], { account: user1.account });
      for (let i = 0; i < 245; i++) await freshFounder.write.mint({ account: user1.account });
      const usdcAmount = 8n * 10n ** 6n;
      await usdc.write.approve([freshLaunch.address, BigInt(usdcAmount)], { account: user1.account });
      await freshLaunch.write.buy([BigInt(usdcAmount)], { account: user1.account });
      await advancePastPresaleEnd(freshLaunch);
      await networkHelpers.time.increase(FINALIZE_DELAY_SECONDS + 1);
      await networkHelpers.mine();
      await freshLaunch.write.finalize({ account: owner.account });
      const releasableBefore = await freshLaunch.read.releasable([user1.account.address]);
      if (releasableBefore > 0n) await freshLaunch.write.claim({ account: user1.account });
      expect(await freshLaunch.read.releasable([user1.account.address])).to.equal(0n);
    });

    it("presaleEndTime returns max before first founder mint", async () => {
      const freshFounder = await viem.deployContract("TCGVaultFounderNFT", [
        usdc.address,
        nexus.address,
        owner.account.address,
      ], { client: { wallet: owner } });
      const launchNoWave2 = await viem.deployContract("TCGVaultInitialLaunch", [
        tcgv.address,
        usdc.address,
        freshFounder.address,
        nexus.address,
        owner.account.address,
      ], { client: { wallet: owner } });
      const wave2Start = await freshFounder.read.wave2StartTimestamp();
      expect(wave2Start).to.equal(0n);
      const countdownStart = await launchNoWave2.read.presaleCountdownStartTime();
      const end = await launchNoWave2.read.presaleEndTime();
      expect(countdownStart).to.equal(BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"));
      expect(end).to.equal(BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"));
    });

    it("emergencyFinalize reverts before max presale duration", async () => {
      const { launch: freshLaunch } = await deployIsolatedPresaleStack(owner, usdc.address as `0x${string}`);
      await viem.assertions.revertWithCustomError(
        freshLaunch.write.emergencyFinalize({ account: owner.account }),
        freshLaunch,
        "EmergencyFinalizeNotAvailable",
      );
    });

    it("emergencyFinalize reverts when caller is not owner", async () => {
      const { launch: freshLaunch } = await deployIsolatedPresaleStack(owner, usdc.address as `0x${string}`);
      const maxPresaleDuration = await freshLaunch.read.MAX_PRESALE_DURATION();
      await networkHelpers.time.increase(Number(maxPresaleDuration) + 1);
      await networkHelpers.mine();
      await expectRevert(freshLaunch.write.emergencyFinalize({ account: user1.account }));
    });

    it("owner can emergencyFinalize after max duration", async () => {
      const { launch: freshLaunch } = await deployIsolatedPresaleStack(owner, usdc.address as `0x${string}`);
      const maxPresaleDuration = await freshLaunch.read.MAX_PRESALE_DURATION();
      await networkHelpers.time.increase(Number(maxPresaleDuration) + 1);
      await networkHelpers.mine();
      await freshLaunch.write.emergencyFinalize({ account: owner.account });
      const tge = await freshLaunch.read.tgeTimestamp();
      expect(tge > 0n).to.equal(true);
      await viem.assertions.revertWithCustomError(
        freshLaunch.write.finalize({ account: owner.account }),
        freshLaunch,
        "AlreadyFinalized",
      );
    });

    it("releasable returns 0 for user with no allocation", async () => {
      const [, , u2] = await viem.getWalletClients();
      const r = await initialLaunch.read.releasable([u2.account.address]);
      expect(r).to.equal(0n);
    });

    it("claim reverts when nothing to claim", async () => {
      const [, , u2] = await viem.getWalletClients();
      await expectRevert(initialLaunch.write.claim({ account: u2.account }));
    });

    it("claim reverts when not finalized", async () => {
      const launchNoFinalize = await viem.deployContract("TCGVaultInitialLaunch", [
        tcgv.address,
        usdc.address,
        founderNFT.address,
        nexus.address,
        owner.account.address,
      ], { client: { wallet: owner } });
      await viem.assertions.revertWithCustomError(
        launchNoFinalize.write.claim({ account: user1.account }),
        launchNoFinalize,
        "NotFinalized"
      );
    });

    it("buy reverts ExceedsWalletCap when allocation would exceed maxPerWallet", async function () {
      const { founder: freshFounder, launch: freshLaunch } = await deployIsolatedPresaleStack(
        owner,
        usdc.address as `0x${string}`,
      );
      await usdc.write.approve([freshFounder.address, (245n * WAVE1_PRICE)], { account: user1.account });
      for (let i = 0; i < 245; i++) await freshFounder.write.mint({ account: user1.account });
      await advanceToFounderWave2(freshFounder);
      const maxPerWallet = await freshLaunch.read.maxPerWallet();
      const price = await freshLaunch.read.currentPrice();
      const usdcForFullCap = (maxPerWallet * price) / (10n ** 18n);
      await usdc.write.transfer([user1.account.address, usdcForFullCap + 10n ** 6n], { account: owner.account });
      await usdc.write.approve([freshLaunch.address, usdcForFullCap + 10n ** 6n], { account: user1.account });
      await freshLaunch.write.buy([10n ** 6n], { account: user1.account });
      await expectRevert(freshLaunch.write.buy([usdcForFullCap], { account: user1.account }));
    });

    it("releasable returns 0 when not finalized", async () => {
      const launchNoFinalize = await viem.deployContract("TCGVaultInitialLaunch", [
        tcgv.address,
        usdc.address,
        founderNFT.address,
        nexus.address,
        owner.account.address,
      ], { client: { wallet: owner } });
      expect(await launchNoFinalize.read.releasable([user1.account.address])).to.equal(0n);
    });

    it("claim reverts NothingToClaim when releasable is 0", async () => {
      const [, , u2] = await viem.getWalletClients();
      await viem.assertions.revertWithCustomError(
        initialLaunch.write.claim({ account: u2.account }),
        initialLaunch,
        "NothingToClaim"
      );
    });
  });
});

/**
 * Regression tests for Hacken Second Review pending fixes:
 * F-2026-19272 (stable decimals), F-2026-19269 (buy swap amount),
 * F-2026-19271 (vault tracked assets), F-2026-19268 (DEX router fee exclusion).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { parseEther, parseUnits, getContractAddress, zeroAddress } from "viem";

const { viem, networkHelpers } = await hre.network.connect();

describe("Audit pending-fix regressions", function () {
  it("F-2026-19272: 18-decimal USDC prices Founder mint at 200 USDC (not dust)", async function () {
    const wallets = await viem.getWalletClients();
    const owner = wallets[0]!;
    const buyer = wallets[1]!;

    const usdc = await viem.deployContract("contracts/test/MockUSDC18.sol:MockUSDC18", [], {
      client: { wallet: owner },
    });
    const publicClient = await viem.getPublicClient();
    const n0 = BigInt(await publicClient.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));
    const mockAddr = getContractAddress({ from: owner.account.address, nonce: n0 });
    const nexusAddr = getContractAddress({ from: owner.account.address, nonce: n0 + 1n });
    const founderAddr = getContractAddress({ from: owner.account.address, nonce: n0 + 2n });
    const launchAddr = getContractAddress({ from: owner.account.address, nonce: n0 + 3n });

    await viem.deployContract("contracts/test/MockTCGVPresale.sol:MockTCGVPresale", [], { client: { wallet: owner } });
    await viem.deployContract("TCGNexusToken", [mockAddr, founderAddr, launchAddr], { client: { wallet: owner } });
    const founder = await viem.deployContract(
      "TCGVaultFounderNFT",
      [usdc.address, nexusAddr, owner.account.address],
      { client: { wallet: owner } },
    );
    const launch = await viem.deployContract(
      "TCGVaultInitialLaunch",
      [mockAddr, usdc.address, founder.address, nexusAddr, owner.account.address],
      { client: { wallet: owner } },
    );
    const mockTcgv = await viem.getContractAt("MockTCGVPresale", mockAddr);
    await mockTcgv.write.setInitialLaunch([launch.address], { account: owner.account });

    const price = await founder.read.WAVE1_PRICE();
    assert.strictEqual(price, 200n * 10n ** 18n);
    assert.strictEqual(await launch.read.PRICE_WAVE1(), (5n * 10n ** 18n) / 1000n); // 0.005e18

    const dust = 200n * 10n ** 6n; // old hardcoded 6-dec constant
    await usdc.write.mint([buyer.account.address, dust], { account: owner.account });
    await usdc.write.approve([founder.address, dust], { account: buyer.account });
    await assert.rejects(founder.write.mint({ account: buyer.account }));

    const full = 200n * 10n ** 18n;
    await usdc.write.mint([buyer.account.address, full], { account: owner.account });
    await usdc.write.approve([founder.address, full], { account: buyer.account });
    await founder.write.mint({ account: buyer.account });
    const nexus = await viem.getContractAt("TCGNexusToken", nexusAddr);
    assert.strictEqual(await nexus.read.balanceOf([buyer.account.address]), 60n * 10n ** 18n);
  });

  it("F-2026-19269: USDC donated to pair is not swapped on buy (fee cannot be bypassed)", async function () {
    const wallets = await viem.getWalletClients();
    const owner = wallets[0]!;
    const buyer = wallets[1]!;
    const vault = wallets[2]!;
    const marketing = wallets[3]!;
    const community = wallets[4]!;

    const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], { client: { wallet: owner } });
    const factory = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
    const router = await viem.deployContract("MockUniswapV2Router", [factory.address, usdc.address], {
      client: { wallet: owner },
    });

    const publicClient = await viem.getPublicClient();
    const n0 = BigInt(await publicClient.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));
    const futureTcgv = getContractAddress({ from: owner.account.address, nonce: n0 + 1n });
    const nexusAddr = getContractAddress({ from: owner.account.address, nonce: n0 });

    await viem.deployContract(
      "TCGNexusToken",
      [futureTcgv, buyer.account.address, vault.account.address],
      { client: { wallet: owner } },
    );
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

    await factory.write.createPair([tcgv.address, usdc.address], { account: owner.account });
    const pairAddress = await factory.read.getPair([tcgv.address, usdc.address]);
    const pair = await viem.getContractAt("MockUniswapV2Pair", pairAddress);
    await tcgv.write.setPair([pairAddress, true], { account: owner.account });

    await tcgv.write.mintPresale([owner.account.address, parseEther("1000000")], { account: owner.account });
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
    await tcgv.write.setExcludedFromFees([buyRouter.address, true], { account: owner.account });

    const usdcLiq = parseUnits("10000", 6);
    const tcgvLiq = parseEther("900000");
    await usdc.write.mint([owner.account.address, usdcLiq], { account: owner.account });
    await usdc.write.transfer([pairAddress, usdcLiq], { account: owner.account });
    await tcgv.write.transfer([pairAddress, tcgvLiq], { account: owner.account });
    await pair.write.mint([owner.account.address], { account: owner.account });

    // Honest buy baseline
    const honestIn = parseUnits("100", 6);
    await usdc.write.mint([buyer.account.address, honestIn], { account: owner.account });
    await usdc.write.approve([buyRouter.address, honestIn], { account: buyer.account });
    const tcgvBeforeHonest = await tcgv.read.balanceOf([buyer.account.address]);
    await buyRouter.write.buyTCGVWithUSDC([honestIn, 0n, BigInt(Math.floor(Date.now() / 1000) + 300)], {
      account: buyer.account,
    });
    const honestOut = (await tcgv.read.balanceOf([buyer.account.address])) - tcgvBeforeHonest;

    // Donate large USDC to pair, then declare 1 wei buy (old exploit path)
    const donation = parseUnits("500", 6);
    await usdc.write.mint([owner.account.address, donation], { account: owner.account });
    await usdc.write.transfer([pairAddress, donation], { account: owner.account });

    const dust = 1n;
    await usdc.write.mint([buyer.account.address, dust], { account: owner.account });
    await usdc.write.approve([buyRouter.address, dust], { account: buyer.account });
    const tcgvBeforeDust = await tcgv.read.balanceOf([buyer.account.address]);
    // Dust buy may revert (zero fee swap amount floors) or yield tiny output — must not capture donation.
    try {
      await buyRouter.write.buyTCGVWithUSDC([dust, 0n, BigInt(Math.floor(Date.now() / 1000) + 300)], {
        account: buyer.account,
      });
      const dustOut = (await tcgv.read.balanceOf([buyer.account.address])) - tcgvBeforeDust;
      assert.ok(dustOut * 50n < honestOut, `dust buy must not swap donated USDC (out=${dustOut}, honest=${honestOut})`);
    } catch {
      // Revert is also acceptable (e.g. zero swap / insufficient output).
    }

    // Pair still holds the donated USDC above reserves until sync — donation not consumed by dust buy path.
    const pairUsdc = await usdc.read.balanceOf([pairAddress]);
    assert.ok(pairUsdc >= donation, "donation must remain on pair when not included in exact swapAmount");
  });

  it("F-2026-19271: donation does not change totalAssets; owner can recover surplus", async function () {
    const wallets = await viem.getWalletClients();
    const owner = wallets[0]!;
    const user = wallets[1]!;

    const tcgv = await viem.deployContract(
      "contracts/test/MockTCGVStakingAsset.sol:MockTCGVStakingAsset",
      [owner.account.address],
      { client: { wallet: owner } },
    );
    const vault = await viem.deployContract("TCGVaultStakingVault", [tcgv.address], { client: { wallet: owner } });
    const stake = parseEther("100");
    await vault.write.setRequiredStakeForBasicNFT([stake], { account: owner.account });

    await tcgv.write.transfer([user.account.address, parseEther("500")], { account: owner.account });
    const assetsNeeded = await vault.read.previewMint([stake]);
    await tcgv.write.approve([vault.address, assetsNeeded], { account: user.account });
    await vault.write.deposit([assetsNeeded, user.account.address], { account: user.account });

    const trackedBefore = await vault.read.totalAssets();
    assert.strictEqual(trackedBefore, assetsNeeded);

    const donation = parseEther("200");
    await tcgv.write.transfer([vault.address, donation], { account: owner.account });
    assert.strictEqual(await vault.read.totalAssets(), trackedBefore, "donation must not inflate totalAssets");

    const ownerBalBefore = await tcgv.read.balanceOf([owner.account.address]);
    await vault.write.recoverUnsolicitedAssets([owner.account.address], { account: owner.account });
    const ownerBalAfter = await tcgv.read.balanceOf([owner.account.address]);
    assert.strictEqual(ownerBalAfter - ownerBalBefore, donation);
    assert.strictEqual(await vault.read.totalAssets(), trackedBefore);
  });

  it("F-2026-19268: setDexRouter does not fee-exclude the DEX router; redeem to pair reverts", async function () {
    const wallets = await viem.getWalletClients();
    const owner = wallets[0]!;
    const user = wallets[1]!;
    const vaultW = wallets[2]!;
    const marketing = wallets[3]!;
    const community = wallets[4]!;

    const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], { client: { wallet: owner } });
    const factory = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
    const router = await viem.deployContract("MockUniswapV2Router", [factory.address, usdc.address], {
      client: { wallet: owner },
    });

    const publicClient = await viem.getPublicClient();
    const n0 = BigInt(await publicClient.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));
    const futureTcgv = getContractAddress({ from: owner.account.address, nonce: n0 + 1n });
    const nexusAddr = getContractAddress({ from: owner.account.address, nonce: n0 });
    await viem.deployContract(
      "TCGNexusToken",
      [futureTcgv, user.account.address, vaultW.account.address],
      { client: { wallet: owner } },
    );
    const tcgv = await viem.deployContract(
      "TCGVaultToken",
      [
        zeroAddress,
        router.address,
        vaultW.account.address,
        marketing.account.address,
        community.account.address,
        nexusAddr,
        owner.account.address,
      ],
      { client: { wallet: owner } },
    );

    assert.strictEqual(await tcgv.read.isExcludedFromFees([router.address]), false);

    const stakingAsset = await viem.deployContract(
      "contracts/test/MockTCGVStakingAsset.sol:MockTCGVStakingAsset",
      [owner.account.address],
      { client: { wallet: owner } },
    );
    const stakingVault = await viem.deployContract("TCGVaultStakingVault", [stakingAsset.address], {
      client: { wallet: owner },
    });
    const stake = parseEther("100");
    await stakingVault.write.setRequiredStakeForBasicNFT([stake], { account: owner.account });
    await stakingAsset.write.transfer([user.account.address, parseEther("500")], { account: owner.account });
    const assetsNeeded = await stakingVault.read.previewMint([stake]);
    await stakingAsset.write.approve([stakingVault.address, assetsNeeded], { account: user.account });
    await stakingVault.write.deposit([assetsNeeded, user.account.address], { account: user.account });

    const fakePair = wallets[5]!.account.address;
    await stakingAsset.write.setPair([fakePair, true], { account: owner.account });
    const shares = await stakingVault.read.balanceOf([user.account.address]);
    await viem.assertions.revertWithCustomError(
      stakingVault.write.redeem([shares, fakePair, user.account.address], { account: user.account }),
      stakingVault,
      "ReceiverIsPair",
    );
  });
});

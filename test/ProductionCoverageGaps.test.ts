/**
 * Production-path coverage: revert/edge branches not exercised by the main product suites.
 */
import { describe, it } from "node:test";
import { expect } from "chai";
import hre from "hardhat";
import { getAddress, getContractAddress, parseEther, parseUnits, zeroAddress } from "viem";

const { viem, networkHelpers } = await hre.network.connect();

const ZERO = zeroAddress;

async function expectRevert(promise: Promise<unknown>) {
  let reverted = false;
  try {
    await promise;
  } catch {
    reverted = true;
  }
  expect(reverted).to.equal(true);
}

describe("Production coverage gaps", function () {
  describe("TCGNexusToken", () => {
    it("constructor reverts ZeroAddress for founder or launch bonus minters", async () => {
      const [owner] = await viem.getWalletClients();
      const nexus = await viem.deployContract(
        "TCGNexusToken",
        [owner!.account.address, owner!.account.address, owner!.account.address],
        { client: { wallet: owner } },
      );
      await viem.assertions.revertWithCustomError(
        viem.deployContract("TCGNexusToken", [owner!.account.address, ZERO, owner!.account.address], {
          client: { wallet: owner },
        }),
        nexus,
        "ZeroAddress",
      );
      await viem.assertions.revertWithCustomError(
        viem.deployContract("TCGNexusToken", [owner!.account.address, owner!.account.address, ZERO], {
          client: { wallet: owner },
        }),
        nexus,
        "ZeroAddress",
      );
    });

    it("presale bonus getters and clawBack branches", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const founder = wallets[1]!;
      const launch = wallets[2]!;
      const nexus = await viem.deployContract(
        "TCGNexusToken",
        [owner.account.address, founder.account.address, launch.account.address],
        { client: { wallet: owner } },
      );
      expect(getAddress(await nexus.read.founderNFTPresaleBonus())).to.equal(getAddress(founder.account.address));
      expect(getAddress(await nexus.read.initialLaunchPresaleBonus())).to.equal(getAddress(launch.account.address));
      await nexus.write.mintPresaleBonus([owner.account.address, parseEther("10")], { account: founder.account });
      await viem.assertions.revertWithCustomError(
        nexus.write.clawBackPresaleBonus([owner.account.address, parseEther("1")], { account: owner.account }),
        nexus,
        "OnlyPresaleBonusContract",
      );
      await viem.assertions.revertWithCustomError(
        nexus.write.clawBackPresaleBonus([ZERO, parseEther("1")], { account: founder.account }),
        nexus,
        "ZeroAddress",
      );
      await viem.assertions.revertWithCustomError(
        nexus.write.clawBackPresaleBonus([owner.account.address, 0n], { account: founder.account }),
        nexus,
        "ZeroAmount",
      );
      await nexus.write.clawBackPresaleBonus([owner.account.address, parseEther("10")], { account: launch.account });
      expect(await nexus.read.balanceOf([owner.account.address])).to.equal(0n);
    });
  });

  describe("TCGVaultFounderNFT + InitialLaunch cancel paths", () => {
    it("Founder cancel reverts unauthorized, already cancelled, and after window; strategic to-zero reverts", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const user1 = wallets[1]!;
      const user2 = wallets[2]!;
      const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
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
      await viem.deployContract(
        "TCGVaultInitialLaunch",
        [mockAddr, usdc.address, founder.address, nexusAddr, owner.account.address],
        { client: { wallet: owner } },
      );
      const price = await founder.read.WAVE1_PRICE();
      await usdc.write.mint([user1.account.address, price], { account: owner.account });
      await usdc.write.approve([founder.address, price], { account: user1.account });
      await founder.write.mint({ account: user1.account });

      await viem.assertions.revertWithCustomError(
        founder.write.cancelFounderPurchase([0n], { account: user2.account }),
        founder,
        "Unauthorized",
      );
      await founder.write.cancelFounderPurchase([0n], { account: user1.account });
      await viem.assertions.revertWithCustomError(
        founder.write.cancelFounderPurchase([0n], { account: user1.account }),
        founder,
        "AlreadyCancelled",
      );

      await usdc.write.mint([user1.account.address, price], { account: owner.account });
      await usdc.write.approve([founder.address, price], { account: user1.account });
      await founder.write.mint({ account: user1.account });
      await networkHelpers.time.increase(15 * 24 * 3600);
      await networkHelpers.mine();
      await viem.assertions.revertWithCustomError(
        founder.write.cancelFounderPurchase([1n], { account: user1.account }),
        founder,
        "CancellationWindowEnded",
      );

      await viem.assertions.revertWithCustomError(
        founder.write.mintStrategicReserve([ZERO], { account: owner.account }),
        founder,
        "ZeroAddress",
      );
    });

    it("Founder and Launch constructors revert UnsupportedStableDecimals and zero token addresses", async () => {
      const [owner] = await viem.getWalletClients();
      const usdc19 = await viem.deployContract("contracts/test/CoverageHelpers.sol:MockUSDC19", [], {
        client: { wallet: owner },
      });
      const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
        client: { wallet: owner },
      });
      const dummy = owner!.account.address;
      await expectRevert(
        viem.deployContract("TCGVaultFounderNFT", [usdc19.address, dummy, dummy], { client: { wallet: owner } }),
      );
      await expectRevert(
        viem.deployContract("TCGVaultFounderNFT", [ZERO, dummy, dummy], { client: { wallet: owner } }),
      );

      const founderOk = await viem.deployContract("TCGVaultFounderNFT", [usdc.address, dummy, dummy], {
        client: { wallet: owner },
      });
      await expectRevert(
        viem.deployContract(
          "TCGVaultInitialLaunch",
          [dummy, usdc19.address, founderOk.address, dummy, dummy],
          { client: { wallet: owner } },
        ),
      );
      await expectRevert(
        viem.deployContract(
          "TCGVaultInitialLaunch",
          [ZERO, usdc.address, founderOk.address, dummy, dummy],
          { client: { wallet: owner } },
        ),
      );
    });

    it("InitialLaunch cancelOrder burns TCGV and claws NEXUS; revert branches", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const user1 = wallets[1]!;
      const user2 = wallets[2]!;
      const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
        client: { wallet: owner },
      });

      const publicClient = await viem.getPublicClient();
      const n0 = BigInt(await publicClient.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));
      const mockAddr = getContractAddress({ from: owner.account.address, nonce: n0 });
      const nexusAddr = getContractAddress({ from: owner.account.address, nonce: n0 + 1n });
      const founderAddr = getContractAddress({ from: owner.account.address, nonce: n0 + 2n });
      const launchAddr = getContractAddress({ from: owner.account.address, nonce: n0 + 3n });
      const mockTcgv = await viem.deployContract("contracts/test/MockTCGVPresale.sol:MockTCGVPresale", [], {
        client: { wallet: owner },
      });
      const nexus = await viem.deployContract("TCGNexusToken", [mockAddr, founderAddr, launchAddr], {
        client: { wallet: owner },
      });
      const founder = await viem.deployContract(
        "TCGVaultFounderNFT",
        [usdc.address, nexusAddr, owner.account.address],
        { client: { wallet: owner } },
      );
      const launch = await viem.deployContract(
        "TCGVaultInitialLaunch",
        [mockAddr, usdc.address, founder.address, nexusAddr, ZERO],
        { client: { wallet: owner } },
      );
      expect(getAddress(mockTcgv.address)).to.equal(getAddress(mockAddr));
      expect(getAddress(await launch.read.treasury())).to.equal(getAddress(owner.account.address));
      await mockTcgv.write.setInitialLaunch([launch.address], { account: owner.account });
      await usdc.write.mint([user1.account.address, parseUnits("1000000", 6)], { account: owner.account });

      const usdcIn = parseUnits("8", 6);
      await usdc.write.approve([launch.address, usdcIn * 2n], { account: user1.account });
      await launch.write.buy([usdcIn], { account: user1.account });
      const nexusBefore = await nexus.read.balanceOf([user1.account.address]);
      expect(nexusBefore > 0n).to.equal(true);
      const [allocBefore] = await launch.read.allocations([user1.account.address]);
      expect(allocBefore > 0n).to.equal(true);
      await launch.write.cancelOrder([0n], { account: user1.account });
      expect(await nexus.read.balanceOf([user1.account.address])).to.equal(0n);
      const [allocAfter] = await launch.read.allocations([user1.account.address]);
      expect(allocAfter).to.equal(0n);

      await viem.assertions.revertWithCustomError(
        launch.write.cancelOrder([99n], { account: user1.account }),
        launch,
        "InvalidOrder",
      );
      await viem.assertions.revertWithCustomError(
        launch.write.cancelOrder([0n], { account: user1.account }),
        launch,
        "OrderAlreadyCancelled",
      );

      await launch.write.buy([usdcIn], { account: user1.account });
      await viem.assertions.revertWithCustomError(
        launch.write.cancelOrder([1n], { account: user2.account }),
        launch,
        "Unauthorized",
      );
      await networkHelpers.time.increase(15 * 24 * 3600);
      await networkHelpers.mine();
      await viem.assertions.revertWithCustomError(
        launch.write.cancelOrder([1n], { account: user1.account }),
        launch,
        "CancellationWindowEnded",
      );
    });

    it("cancelOrder reverts AlreadyFinalized after emergencyFinalize", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const user1 = wallets[1]!;
      const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
        client: { wallet: owner },
      });
      await usdc.write.mint([user1.account.address, parseUnits("1000", 6)], { account: owner.account });
      const publicClient = await viem.getPublicClient();
      const n0 = BigInt(await publicClient.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));
      const mockAddr = getContractAddress({ from: owner.account.address, nonce: n0 });
      const nexusAddr = getContractAddress({ from: owner.account.address, nonce: n0 + 1n });
      const founderAddr = getContractAddress({ from: owner.account.address, nonce: n0 + 2n });
      const launchAddr = getContractAddress({ from: owner.account.address, nonce: n0 + 3n });
      const mockTcgv = await viem.deployContract("contracts/test/MockTCGVPresale.sol:MockTCGVPresale", [], {
        client: { wallet: owner },
      });
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
      await mockTcgv.write.setInitialLaunch([launch.address], { account: owner.account });
      await usdc.write.approve([launch.address, parseUnits("8", 6)], { account: user1.account });
      await launch.write.buy([parseUnits("8", 6)], { account: user1.account });
      const maxDur = await launch.read.MAX_PRESALE_DURATION();
      await networkHelpers.time.increase(Number(maxDur) + 1);
      await networkHelpers.mine();
      await launch.write.emergencyFinalize({ account: owner.account });
      await viem.assertions.revertWithCustomError(
        launch.write.cancelOrder([0n], { account: user1.account }),
        launch,
        "AlreadyFinalized",
      );
    });
  });

  describe("TCGVaultStakingVault", () => {
    it("covers previewWithdraw, empty exit, soulbound shares, pricing router, recover, forceWithdraw", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const user = wallets[1]!;
      const tcgv = await viem.deployContract("contracts/test/MockTCGVStakingAsset.sol:MockTCGVStakingAsset", [
        owner.account.address,
      ], { client: { wallet: owner } });
      const vault = await viem.deployContract("TCGVaultStakingVault", [tcgv.address], { client: { wallet: owner } });
      const stake = parseEther("100");
      await vault.write.setRequiredStakeForBasicNFT([stake], { account: owner.account });
      await tcgv.write.transfer([user.account.address, parseEther("500")], { account: owner.account });

      await viem.assertions.revertWithCustomError(vault.read.previewWithdraw([1n]), vault, "FullUnstakeOnly");

      await vault.write.withdraw([0n, user.account.address, user.account.address], { account: user.account });
      await vault.write.redeem([0n, user.account.address, user.account.address], { account: user.account });
      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([1n, user.account.address, user.account.address], { account: user.account }),
        vault,
        "InvalidVaultAmount",
      );
      await viem.assertions.revertWithCustomError(
        vault.write.redeem([1n, user.account.address, user.account.address], { account: user.account }),
        vault,
        "InvalidVaultAmount",
      );

      const assets = await vault.read.previewMint([stake]);
      await tcgv.write.approve([vault.address, assets], { account: user.account });
      await vault.write.mint([stake, user.account.address], { account: user.account });
      await viem.assertions.revertWithCustomError(
        vault.write.transfer([owner.account.address, 1n], { account: user.account }),
        vault,
        "NonTransferableShares",
      );

      await viem.assertions.revertWithCustomError(
        vault.write.forceWithdrawFromBlacklist([user.account.address], { account: owner.account }),
        vault,
        "OnlyAssetToken",
      );
      await tcgv.write.callForceWithdrawFromBlacklist([vault.address, owner.account.address], {
        account: owner.account,
      });

      await viem.assertions.revertWithCustomError(
        vault.write.recoverUnsolicitedAssets([ZERO], { account: owner.account }),
        vault,
        "ZeroAddress",
      );
      await viem.assertions.revertWithCustomError(
        vault.write.recoverUnsolicitedAssets([owner.account.address], { account: owner.account }),
        vault,
        "NoUnsolicitedAssets",
      );

      await vault.write.setBasicNFTPricingRouter([ZERO], { account: owner.account });
      expect(await vault.read.basicNFTPricingRouter()).to.equal(ZERO);

      const badRouter = await viem.deployContract(
        "contracts/test/MockBuyRouterForStaking.sol:MockBuyRouterForStaking",
        [ZERO, ZERO, owner.account.address],
        { client: { wallet: owner } },
      );
      await viem.assertions.revertWithCustomError(
        vault.write.setBasicNFTPricingRouter([badRouter.address], { account: owner.account }),
        vault,
        "InvalidPricingSource",
      );

      const usdc19 = await viem.deployContract("contracts/test/CoverageHelpers.sol:MockUSDC19", [], {
        client: { wallet: owner },
      });
      const factory = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
      const decRouter = await viem.deployContract(
        "contracts/test/MockBuyRouterForStaking.sol:MockBuyRouterForStaking",
        [factory.address, usdc19.address, tcgv.address],
        { client: { wallet: owner } },
      );
      await viem.assertions.revertWithCustomError(
        vault.write.setBasicNFTPricingRouter([decRouter.address], { account: owner.account }),
        vault,
        "UnsupportedStableDecimals",
      );

      const tiny = await viem.deployContract("TCGVaultStakingVault", [tcgv.address], { client: { wallet: owner } });
      await tiny.write.setRequiredStakeForBasicNFT([1n], { account: owner.account });
      expect(await tiny.read.maxMint([user.account.address])).to.equal(0n);
      expect(await tiny.read.maxDeposit([user.account.address])).to.equal(0n);

      await tcgv.write.setBlacklisted([user.account.address, true], { account: owner.account });
      expect(await vault.read.maxRedeem([user.account.address])).to.equal(0n);
      expect(await vault.read.maxWithdraw([user.account.address])).to.equal(0n);
    });

    it("pricing router with empty pair falls back to required stake", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const tcgv = await viem.deployContract("contracts/test/MockTCGVStakingAsset.sol:MockTCGVStakingAsset", [
        owner.account.address,
      ], { client: { wallet: owner } });
      const vault = await viem.deployContract("TCGVaultStakingVault", [tcgv.address], { client: { wallet: owner } });
      const fallback = parseEther("42");
      await vault.write.setRequiredStakeForBasicNFT([fallback], { account: owner.account });
      const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
        client: { wallet: owner },
      });
      const factory = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
      const pricingRouter = await viem.deployContract(
        "contracts/test/MockBuyRouterForStaking.sol:MockBuyRouterForStaking",
        [factory.address, usdc.address, tcgv.address],
        { client: { wallet: owner } },
      );
      await vault.write.setBasicNFTPricingRouter([pricingRouter.address], { account: owner.account });
      expect(await vault.read.requiredStakeForBasicNFT()).to.equal(fallback);
      await factory.write.createPair([tcgv.address, usdc.address], { account: owner.account });
      await vault.write.setBasicNFTPricingRouter([pricingRouter.address], { account: owner.account });
      expect(await vault.read.requiredStakeForBasicNFT()).to.equal(fallback);

      const pairAddress = await factory.read.getPair([tcgv.address, usdc.address]);
      const pair = await viem.getContractAt("MockUniswapV2Pair", pairAddress);
      await tcgv.write.transfer([pairAddress, parseEther("100")], { account: owner.account });
      await usdc.write.mint([pairAddress, parseUnits("500", 6)], { account: owner.account });
      await pair.write.sync({ account: owner.account });
      // Liquidity added after capture-with-empty-reserves: anchorTs stays 0 → fallback.
      expect(await vault.read.requiredStakeForBasicNFT()).to.equal(fallback);
    });
  });

  describe("TCGVaultLiquidityWrapper + BuyRouter + TCGR", () => {
    it("wrapper constructor reverts on zero tcgv and FoT pull reverts", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const user = wallets[1]!;
      await expectRevert(
        viem.deployContract("TCGVaultLiquidityWrapper", [ZERO, ZERO], { client: { wallet: owner } }),
      );
      const tcgv = await viem.deployContract("contracts/test/MockTCGVStakingAsset.sol:MockTCGVStakingAsset", [
        owner.account.address,
      ], { client: { wallet: owner } });
      const wrapper = await viem.deployContract("TCGVaultLiquidityWrapper", [tcgv.address, ZERO], {
        client: { wallet: owner },
      });
      const fot = await viem.deployContract("contracts/test/CoverageHelpers.sol:MockFeeOnTransferToken", [], {
        client: { wallet: owner },
      });
      const factory = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
      const router = await viem.deployContract("MockUniswapV2Router", [factory.address, fot.address], {
        client: { wallet: owner },
      });
      await wrapper.write.setAllowedRouter([router.address, true], { account: owner.account });
      await tcgv.write.transfer([user.account.address, parseEther("100")], { account: owner.account });
      await fot.write.transfer([user.account.address, parseEther("100")], { account: owner.account });
      await tcgv.write.approve([wrapper.address, parseEther("10")], { account: user.account });
      await fot.write.approve([wrapper.address, parseEther("10")], { account: user.account });
      await viem.assertions.revertWithCustomError(
        wrapper.write.addLiquidity(
          [router.address, fot.address, parseEther("10"), parseEther("10"), 0n, 0n, 2n ** 64n],
          { account: user.account },
        ),
        wrapper,
        "FeeOnTransferTokenNotSupported",
      );
    });

    it("BuyRouter buy community fee accrues pending USDC", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const user1 = wallets[1]!;
      const vault = wallets[2]!;
      const marketing = wallets[3]!;
      const community = wallets[4]!;
      const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
        client: { wallet: owner },
      });
      const factory = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
      const router = await viem.deployContract("MockUniswapV2Router", [factory.address, usdc.address], {
        client: { wallet: owner },
      });
      const publicClient = await viem.getPublicClient();
      const n0 = BigInt(await publicClient.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));
      const futureTcgv = getContractAddress({ from: owner.account.address, nonce: n0 + 1n });
      const nexusAddr = getContractAddress({ from: owner.account.address, nonce: n0 });
      await viem.deployContract("TCGNexusToken", [futureTcgv, user1.account.address, vault.account.address], {
        client: { wallet: owner },
      });
      const tcgv = await viem.deployContract(
        "TCGVaultToken",
        [
          ZERO,
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
      const pair = await viem.getContractAt("MockUniswapV2Pair", pairAddress);
      const usdcLiq = parseUnits("10000", 6);
      await usdc.write.mint([owner.account.address, usdcLiq], { account: owner.account });
      await usdc.write.transfer([pairAddress, usdcLiq], { account: owner.account });
      await tcgv.write.transfer([pairAddress, parseEther("900000")], { account: owner.account });
      await pair.write.mint([owner.account.address], { account: owner.account });

      await buyRouter.write.setBuyFeeParams([200n, 100n, 200n], { account: owner.account });
      const usdcIn = parseUnits("1000", 6);
      await usdc.write.mint([owner.account.address, usdcIn], { account: owner.account });
      await usdc.write.approve([buyRouter.address, usdcIn], { account: owner.account });
      await buyRouter.write.buyTCGVWithUSDC([usdcIn, 0n, 2n ** 64n], { account: owner.account });
      expect(await buyRouter.read.pendingUsdcFees([community.account.address])).to.equal((usdcIn * 200n) / 10000n);
    });

    it("TCGR UnsupportedStableDecimals and qualifying NFT disable", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const minter = wallets[1]!;
      const referrer = wallets[2]!;
      const referee = wallets[3]!;
      const usdc19 = await viem.deployContract("contracts/test/CoverageHelpers.sol:MockUSDC19", [], {
        client: { wallet: owner },
      });
      const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
        client: { wallet: owner },
      });
      const tcgr = await viem.deployContract("TCGRToken", [minter.account.address, usdc.address], {
        client: { wallet: owner },
      });
      await viem.assertions.revertWithCustomError(
        viem.deployContract("TCGRToken", [minter.account.address, usdc19.address], { client: { wallet: owner } }),
        tcgr,
        "UnsupportedStableDecimals",
      );
      await tcgr.write.setQualifyingNft([ZERO], { account: owner.account });
      await tcgr.write.setReferrer([referrer.account.address], { account: referee.account });
      const usdc6 = (parseEther("10") + 50n * 10n ** 8n - 1n) / (50n * 10n ** 8n);
      await tcgr.write.processValidatedBuy([referee.account.address, usdc6], { account: minter.account });
      expect((await tcgr.read.lockedReferralBalance([referrer.account.address])) > 0n).to.equal(true);
      expect(await tcgr.read.unlockedReferralBalance([referrer.account.address])).to.equal(0n);
      await networkHelpers.time.increase(30n * 24n * 3600n + 1n);
      expect(await tcgr.read.lockedReferralBalance([referrer.account.address])).to.equal(0n);
      expect((await tcgr.read.unlockedReferralBalance([referrer.account.address])) > 0n).to.equal(true);
      expect(getAddress(await tcgr.read.qualifyingNft())).to.equal(ZERO);

      const usdc18 = await viem.deployContract("contracts/test/MockUSDC18.sol:MockUSDC18", [], {
        client: { wallet: owner },
      });
      const tcgr18 = await viem.deployContract("TCGRToken", [minter.account.address, usdc18.address], {
        client: { wallet: owner },
      });
      await tcgr18.write.setReferrer([referrer.account.address], { account: referee.account });
      await tcgr18.write.processValidatedBuy([referee.account.address, 1n], { account: minter.account });
      expect(await tcgr18.read.balanceOf([referrer.account.address])).to.equal(0n);
    });
  });

  describe("more production edges", () => {
    it("Nexus constructor reverts when minter is zero (3-arg)", async () => {
      const [owner] = await viem.getWalletClients();
      const a = owner!.account.address;
      const ok = await viem.deployContract("TCGNexusToken", [a, a, a], { client: { wallet: owner } });
      await viem.assertions.revertWithCustomError(
        viem.deployContract("TCGNexusToken", [ZERO, a, a], { client: { wallet: owner } }),
        ok,
        "ZeroAddress",
      );
    });

    it("Launch getters, finalize before wave2, and second emergencyFinalize", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
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
      const founder = await viem.deployContract("TCGVaultFounderNFT", [usdc.address, nexusAddr, owner.account.address], {
        client: { wallet: owner },
      });
      const launch = await viem.deployContract(
        "TCGVaultInitialLaunch",
        [mockAddr, usdc.address, founder.address, nexusAddr, owner.account.address],
        { client: { wallet: owner } },
      );
      expect((await launch.read.presaleStartTimestamp()) > 0n).to.equal(true);
      await viem.assertions.revertWithCustomError(
        launch.write.finalize({ account: owner.account }),
        launch,
        "PresaleNotEnded",
      );
      const maxDur = await launch.read.MAX_PRESALE_DURATION();
      await networkHelpers.time.increase(Number(maxDur) + 1);
      await networkHelpers.mine();
      await launch.write.emergencyFinalize({ account: owner.account });
      await viem.assertions.revertWithCustomError(
        launch.write.emergencyFinalize({ account: owner.account }),
        launch,
        "AlreadyFinalized",
      );
    });

    it("Basic NFT mintFor is no-op when account already holds one", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const user = wallets[1]!;
      const mockStaking = await viem.deployContract(
        "contracts/test/MockStakingForBasicNFT.sol:MockStakingForBasicNFT",
        [],
        { client: { wallet: owner } },
      );
      const nft = await viem.deployContract("TCGVaultBasicNFT", [mockStaking.address], { client: { wallet: owner } });
      await mockStaking.write.setBalance([user.account.address, parseEther("100")], { account: owner.account });
      await mockStaking.write.triggerMintFor([nft.address, user.account.address], { account: owner.account });
      const nextAfterFirst = await nft.read.nextTokenId();
      await mockStaking.write.triggerMintFor([nft.address, user.account.address], { account: owner.account });
      expect(await nft.read.nextTokenId()).to.equal(nextAfterFirst);
    });

    it("staking vault covers getters, previewDeposit, mint mismatch, withdraw, maxMint=0, NFT forceWithdraw, TWAP before window", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const user = wallets[1]!;
      const tcgv = await viem.deployContract("contracts/test/MockTCGVStakingAsset.sol:MockTCGVStakingAsset", [
        owner.account.address,
      ], { client: { wallet: owner } });
      const vault = await viem.deployContract("TCGVaultStakingVault", [tcgv.address], { client: { wallet: owner } });
      const nft = await viem.deployContract("TCGVaultBasicNFT", [vault.address], { client: { wallet: owner } });
      const stake = parseEther("100");
      await vault.write.setRequiredStakeForBasicNFT([stake], { account: owner.account });
      await vault.write.setBasicNFTContract([nft.address], { account: owner.account });
      await tcgv.write.transfer([user.account.address, parseEther("500")], { account: owner.account });

      expect(await vault.read.previewDeposit([parseEther("10")]) > 0n).to.equal(true);
      await viem.assertions.revertWithCustomError(
        vault.write.mint([1n, user.account.address], { account: user.account }),
        vault,
        "InvalidVaultAmount",
      );

      expect((await vault.read.maxDeposit([user.account.address])) > 0n).to.equal(true);
      const assets = await vault.read.previewMint([stake]);
      await tcgv.write.approve([vault.address, assets], { account: user.account });
      await vault.write.mint([stake, user.account.address], { account: user.account });
      expect(await vault.read.maxMint([user.account.address])).to.equal(0n);
      expect(await vault.read.maxDeposit([user.account.address])).to.equal(0n);
      expect((await vault.read.maxWithdraw([user.account.address])) > 0n).to.equal(true);
      expect((await nft.read.ownerToTokenId([user.account.address])) > 0n).to.equal(true);

      const shares = await vault.read.balanceOf([user.account.address]);
      const expectedAssets = await vault.read.previewRedeem([shares]);
      await viem.assertions.revertWithCustomError(
        vault.write.withdraw([expectedAssets + 1n, user.account.address, user.account.address], { account: user.account }),
        vault,
        "InvalidVaultAmount",
      );
      await vault.write.withdraw([expectedAssets, user.account.address, user.account.address], { account: user.account });
      expect(await nft.read.ownerToTokenId([user.account.address])).to.equal(0n);
      expect(await vault.read.maxWithdraw([user.account.address])).to.equal(0n);

      const assets2 = await vault.read.previewMint([stake]);
      await tcgv.write.approve([vault.address, assets2], { account: user.account });
      await vault.write.mint([stake, user.account.address], { account: user.account });
      await tcgv.write.callForceWithdrawFromBlacklist([vault.address, user.account.address], { account: owner.account });
      expect(await vault.read.balanceOf([user.account.address])).to.equal(0n);
      expect(await nft.read.ownerToTokenId([user.account.address])).to.equal(0n);

      const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
        client: { wallet: owner },
      });
      const factory = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
      await factory.write.createPair([tcgv.address, usdc.address], { account: owner.account });
      const pairAddress = await factory.read.getPair([tcgv.address, usdc.address]);
      const pair = await viem.getContractAt("MockUniswapV2Pair", pairAddress);
      await tcgv.write.transfer([pairAddress, parseEther("10000")], { account: owner.account });
      await usdc.write.mint([pairAddress, 50_000n * 1_000_000n], { account: owner.account });
      await pair.write.sync({ account: owner.account });
      const pricingRouter = await viem.deployContract(
        "contracts/test/MockBuyRouterForStaking.sol:MockBuyRouterForStaking",
        [factory.address, usdc.address, tcgv.address],
        { client: { wallet: owner } },
      );
      await vault.write.setBasicNFTPricingRouter([pricingRouter.address], { account: owner.account });
      expect(getAddress(await vault.read.basicNFTPricingUsdc())).to.equal(getAddress(usdc.address));
      await networkHelpers.time.increase(2);
      await networkHelpers.mine();
      expect(await vault.read.requiredStakeForBasicNFT()).to.equal(stake);
    });

    it("liquidity wrapper refunds unused TCGV when amountADesired is excess", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const user = wallets[1]!;
      const tcgv = await viem.deployContract("contracts/test/MockTCGVStakingAsset.sol:MockTCGVStakingAsset", [
        owner.account.address,
      ], { client: { wallet: owner } });
      const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
        client: { wallet: owner },
      });
      const factory = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
      const router = await viem.deployContract("MockUniswapV2Router", [factory.address, usdc.address], {
        client: { wallet: owner },
      });
      const wrapper = await viem.deployContract("TCGVaultLiquidityWrapper", [tcgv.address, router.address], {
        client: { wallet: owner },
      });
      await factory.write.createPair([tcgv.address, usdc.address], { account: owner.account });
      const pairAddress = await factory.read.getPair([tcgv.address, usdc.address]);
      const pair = await viem.getContractAt("MockUniswapV2Pair", pairAddress);
      await tcgv.write.transfer([pairAddress, parseEther("1000")], { account: owner.account });
      await usdc.write.mint([pairAddress, parseUnits("10", 6)], { account: owner.account });
      await pair.write.mint([owner.account.address], { account: owner.account });

      await tcgv.write.transfer([user.account.address, parseEther("200")], { account: owner.account });
      await usdc.write.mint([user.account.address, parseUnits("1", 6)], { account: owner.account });
      const desiredTcgv = parseEther("100");
      const desiredUsdc = parseUnits("0.01", 6);
      await tcgv.write.approve([wrapper.address, desiredTcgv], { account: user.account });
      await usdc.write.approve([wrapper.address, desiredUsdc], { account: user.account });
      const tcgvBefore = await tcgv.read.balanceOf([user.account.address]);
      await wrapper.write.addLiquidity(
        [router.address, usdc.address, desiredTcgv, desiredUsdc, 0n, 0n, 2n ** 64n],
        { account: user.account },
      );
      const spent = tcgvBefore - (await tcgv.read.balanceOf([user.account.address]));
      expect(spent < desiredTcgv).to.equal(true);
    });
  });

  describe("remaining hittable production lines", () => {
    it("TWAP lib zero-reserve fraction and staking TWAP fallbacks / internal guards", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const user = wallets[1]!;
      const twap = await viem.deployContract("contracts/test/CoverageHarnesses.sol:TwapLibHarness", [], {
        client: { wallet: owner },
      });
      expect(await twap.read.priceFractionPerSecond([0n, 1n])).to.equal(0n);
      expect(await twap.read.priceFractionPerSecond([1n, 0n])).to.equal(0n);
      expect((await twap.read.priceFractionPerSecond([1n, 1n])) > 0n).to.equal(true);

      const tcgv = await viem.deployContract("contracts/test/MockTCGVStakingAsset.sol:MockTCGVStakingAsset", [
        owner.account.address,
      ], { client: { wallet: owner } });
      const vault = await viem.deployContract(
        "contracts/test/CoverageHarnesses.sol:StakingVaultCoverageHarness",
        [tcgv.address],
        { client: { wallet: owner } },
      );
      const fallback = parseEther("100");
      await vault.write.setRequiredStakeForBasicNFT([fallback], { account: owner.account });

      await viem.assertions.revertWithCustomError(
        vault.write.exposedDeposit([user.account.address, user.account.address, 1n, 1n], { account: owner.account }),
        vault,
        "InitialDepositTooSmall",
      );
      await viem.assertions.revertWithCustomError(
        vault.write.exposedDeposit([user.account.address, user.account.address, parseEther("1"), 0n], {
          account: owner.account,
        }),
        vault,
        "ZeroSharesDeposit",
      );
      await viem.assertions.revertWithCustomError(
        vault.write.exposedDeposit([user.account.address, user.account.address, parseEther("1"), 1n], {
          account: owner.account,
        }),
        vault,
        "ExactStakeRequired",
      );

      await tcgv.write.transfer([user.account.address, parseEther("500")], { account: owner.account });
      const assets = await vault.read.previewMint([fallback]);
      await tcgv.write.approve([vault.address, assets], { account: user.account });
      await vault.write.mint([fallback, user.account.address], { account: user.account });

      await tcgv.write.setBlacklisted([user.account.address, true], { account: owner.account });
      const shares = await vault.read.balanceOf([user.account.address]);
      const out = await vault.read.previewRedeem([shares]);
      await viem.assertions.revertWithCustomError(
        vault.write.exposedWithdraw(
          [user.account.address, user.account.address, user.account.address, out, shares],
          { account: owner.account },
        ),
        vault,
        "BlacklistedOwner",
      );
      await tcgv.write.setBlacklisted([user.account.address, false], { account: owner.account });
      await viem.assertions.revertWithCustomError(
        vault.write.exposedWithdraw(
          [user.account.address, user.account.address, user.account.address, out, 1n],
          { account: owner.account },
        ),
        vault,
        "FullUnstakeOnly",
      );

      const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
        client: { wallet: owner },
      });
      const factory = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
      await factory.write.createPair([tcgv.address, usdc.address], { account: owner.account });
      const pairAddress = await factory.read.getPair([tcgv.address, usdc.address]);
      const pair = await viem.getContractAt("MockUniswapV2Pair", pairAddress);
      await tcgv.write.transfer([pairAddress, parseEther("10000")], { account: owner.account });
      await usdc.write.mint([pairAddress, 50_000n * 1_000_000n], { account: owner.account });
      await pair.write.sync({ account: owner.account });
      const pricingRouter = await viem.deployContract(
        "contracts/test/MockBuyRouterForStaking.sol:MockBuyRouterForStaking",
        [factory.address, usdc.address, tcgv.address],
        { client: { wallet: owner } },
      );
      await vault.write.setBasicNFTPricingRouter([pricingRouter.address], { account: owner.account });
      const [, anchorC] = await vault.read.basicNFTPricingTwapAnchor();

      await networkHelpers.time.increase(86400n + 2n);
      await networkHelpers.mine();
      await pair.write.setOracleStateNow([anchorC + 1n, 0n], { account: owner.account });
      expect(await vault.read.requiredStakeForBasicNFT()).to.equal(fallback);

      await networkHelpers.time.increase(8n * 86400n);
      await networkHelpers.mine();
      await pair.write.setOracleStateNow([anchorC + 1n, 0n], { account: owner.account });
      expect(await vault.read.requiredStakeForBasicNFT()).to.equal(fallback);
    });

    it("BuyRouter multi-hop swapExactInput and zero-output buy/sell", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const user1 = wallets[1]!;
      const vault = wallets[2]!;
      const marketing = wallets[3]!;
      const community = wallets[4]!;

      const tokenA = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
        client: { wallet: owner },
      });
      const tokenB = await viem.deployContract("contracts/test/MockUSDC18.sol:MockUSDC18", [], {
        client: { wallet: owner },
      });
      const tokenC = await viem.deployContract("contracts/test/MockTCGVStakingAsset.sol:MockTCGVStakingAsset", [
        owner.account.address,
      ], { client: { wallet: owner } });
      const factory = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
      const dex = await viem.deployContract("MockUniswapV2Router", [factory.address, tokenA.address], {
        client: { wallet: owner },
      });
      const harness = await viem.deployContract(
        "contracts/test/CoverageHarnesses.sol:BuyRouterSwapHarness",
        [
          dex.address,
          tokenA.address,
          tokenC.address,
          vault.account.address,
          marketing.account.address,
          community.account.address,
        ],
        { client: { wallet: owner } },
      );
      await factory.write.createPair([tokenA.address, tokenB.address], { account: owner.account });
      await factory.write.createPair([tokenB.address, tokenC.address], { account: owner.account });
      const pairAB = await factory.read.getPair([tokenA.address, tokenB.address]);
      const pairBC = await factory.read.getPair([tokenB.address, tokenC.address]);
      const pAB = await viem.getContractAt("MockUniswapV2Pair", pairAB);
      const pBC = await viem.getContractAt("MockUniswapV2Pair", pairBC);
      await tokenA.write.mint([pairAB, parseUnits("1000", 6)], { account: owner.account });
      await tokenB.write.mint([pairAB, parseEther("1000")], { account: owner.account });
      await pAB.write.mint([owner.account.address], { account: owner.account });
      await tokenB.write.mint([pairBC, parseEther("1000")], { account: owner.account });
      await tokenC.write.transfer([pairBC, parseEther("1000")], { account: owner.account });
      await pBC.write.mint([owner.account.address], { account: owner.account });

      const hopIn = parseUnits("10", 6);
      await tokenA.write.mint([pairAB, hopIn], { account: owner.account });
      const cBefore = await tokenC.read.balanceOf([owner.account.address]);
      await harness.write.swapExactInput(
        [[tokenA.address, tokenB.address, tokenC.address], hopIn, owner.account.address],
        { account: owner.account },
      );
      expect((await tokenC.read.balanceOf([owner.account.address])) > cBefore).to.equal(true);

      const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
        client: { wallet: owner },
      });
      const factory2 = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
      const router2 = await viem.deployContract("MockUniswapV2Router", [factory2.address, usdc.address], {
        client: { wallet: owner },
      });
      const publicClient = await viem.getPublicClient();
      const n0 = BigInt(await publicClient.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));
      const futureTcgv = getContractAddress({ from: owner.account.address, nonce: n0 + 1n });
      const nexusAddr = getContractAddress({ from: owner.account.address, nonce: n0 });
      await viem.deployContract("TCGNexusToken", [futureTcgv, user1.account.address, vault.account.address], {
        client: { wallet: owner },
      });
      const tcgv = await viem.deployContract(
        "TCGVaultToken",
        [
          ZERO,
          router2.address,
          vault.account.address,
          marketing.account.address,
          community.account.address,
          nexusAddr,
          owner.account.address,
        ],
        { client: { wallet: owner } },
      );
      await factory2.write.createPair([tcgv.address, usdc.address], { account: owner.account });
      const pairAddress = await factory2.read.getPair([tcgv.address, usdc.address]);
      await tcgv.write.setPair([pairAddress, true], { account: owner.account });
      await tcgv.write.mintPresale([owner.account.address, parseEther("1000000")], { account: owner.account });
      const buyRouter = await viem.deployContract(
        "TCGVaultBuyRouter",
        [
          router2.address,
          usdc.address,
          tcgv.address,
          vault.account.address,
          marketing.account.address,
          community.account.address,
        ],
        { client: { wallet: owner } },
      );
      await tcgv.write.setBuyRouter([buyRouter.address], { account: owner.account });
      const pair = await viem.getContractAt("MockUniswapV2Pair", pairAddress);
      await usdc.write.mint([pairAddress, parseUnits("10000", 6)], { account: owner.account });
      await tcgv.write.setMinAmounts([1n, 1n], { account: owner.account });
      await tcgv.write.transfer([pairAddress, 1n], { account: owner.account });
      await pair.write.sync({ account: owner.account });

      await usdc.write.mint([owner.account.address, 1n], { account: owner.account });
      await usdc.write.approve([buyRouter.address, 1n], { account: owner.account });
      await viem.assertions.revertWithCustomError(
        buyRouter.write.buyTCGVWithUSDC([1n, 0n, 2n ** 64n], { account: owner.account }),
        buyRouter,
        "NoTCGVReceived",
      );
    });

    it("BuyRouter sell reverts when swap yields zero USDC", async () => {
      const wallets = await viem.getWalletClients();
      const owner = wallets[0]!;
      const user1 = wallets[1]!;
      const vault = wallets[2]!;
      const marketing = wallets[3]!;
      const community = wallets[4]!;
      const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], {
        client: { wallet: owner },
      });
      const factory = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
      const router = await viem.deployContract("MockUniswapV2Router", [factory.address, usdc.address], {
        client: { wallet: owner },
      });
      const publicClient = await viem.getPublicClient();
      const n0 = BigInt(await publicClient.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));
      const futureTcgv = getContractAddress({ from: owner.account.address, nonce: n0 + 1n });
      const nexusAddr = getContractAddress({ from: owner.account.address, nonce: n0 });
      await viem.deployContract("TCGNexusToken", [futureTcgv, user1.account.address, vault.account.address], {
        client: { wallet: owner },
      });
      const tcgv = await viem.deployContract(
        "TCGVaultToken",
        [
          ZERO,
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
      const pair = await viem.getContractAt("MockUniswapV2Pair", pairAddress);
      await usdc.write.mint([pairAddress, 1n], { account: owner.account });
      await tcgv.write.transfer([pairAddress, parseEther("900000")], { account: owner.account });
      await pair.write.sync({ account: owner.account });

      await tcgv.write.approve([buyRouter.address, 1n], { account: owner.account });
      await viem.assertions.revertWithCustomError(
        buyRouter.write.sellTCGVForUSDC([1n, 0n, 2n ** 64n], { account: owner.account }),
        buyRouter,
        "InsufficientOutputAmount",
      );
    });
  });
});

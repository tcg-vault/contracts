/**
 * Tests for TCGRToken: soulbound, referrer binding, validated-buy rewards.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { parseEther, zeroAddress } from "viem";

const { viem, networkHelpers } = await hre.network.connect();

/** Inverse of TCGRToken: (usdc6 * 10^12 * 50) / 10000 — ceil so minted amount >= target. */
function usdc6ForTcgrReward(tcgrWei: bigint): bigint {
  const denom = 50n * 10n ** 8n;
  return (tcgrWei + denom - 1n) / denom;
}

async function deployFixture() {
  const wallets = await viem.getWalletClients();
  const owner = wallets[0]!;
  const minter = wallets[1]!;
  const referrer = wallets[2]!;
  const referee = wallets[3]!;
  const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], { client: { wallet: owner } });
  const tcgr = await viem.deployContract("TCGRToken", [minter.account.address, usdc.address], { client: { wallet: owner } });
  const qualifyingNft = await viem.deployContract("contracts/test/MockQualifyingNFT.sol:MockQualifyingNFT", [], {
    client: { wallet: owner },
  });
  await tcgr.write.setQualifyingNft([qualifyingNft.address], { account: owner.account });
  await qualifyingNft.write.mint([owner.account.address], { account: owner.account });
  await qualifyingNft.write.mint([referrer.account.address], { account: owner.account });
  return { owner, minter, referrer, referee, tcgr, qualifyingNft, usdc };
}

/** Mint tcgrWei to `recipient` via processValidatedBuy(referee, usdc). */
async function rewardReferrer(
  tcgr: Awaited<ReturnType<typeof deployFixture>>["tcgr"],
  minter: Awaited<ReturnType<typeof deployFixture>>["minter"],
  referee: Awaited<ReturnType<typeof deployFixture>>["referee"],
  recipient: `0x${string}`,
  tcgrWei: bigint,
) {
  await tcgr.write.setReferrer([recipient], { account: referee.account });
  const usdc6 = usdc6ForTcgrReward(tcgrWei);
  await tcgr.write.processValidatedBuy([referee.account.address, usdc6], { account: minter.account });
}

describe("TCGRToken", function () {
  it("constructor reverts when minter is zero", async function () {
    const wallets = await viem.getWalletClients();
    const owner = wallets[0]!;
    const { tcgr, usdc } = await networkHelpers.loadFixture(deployFixture);
    await viem.assertions.revertWithCustomError(
      viem.deployContract("TCGRToken", [zeroAddress, usdc.address], { client: { wallet: owner } }),
      tcgr,
      "ZeroAddress"
    );
  });

  it("constructor reverts when usdc is zero", async function () {
    const wallets = await viem.getWalletClients();
    const owner = wallets[0]!;
    const { tcgr, minter } = await networkHelpers.loadFixture(deployFixture);
    await viem.assertions.revertWithCustomError(
      viem.deployContract("TCGRToken", [minter.account.address, zeroAddress], { client: { wallet: owner } }),
      tcgr,
      "ZeroAddress"
    );
  });

  it("has correct name and symbol", async function () {
    const { tcgr } = await networkHelpers.loadFixture(deployFixture);
    assert.strictEqual(await tcgr.read.name(), "TCG-Referral");
    assert.strictEqual(await tcgr.read.symbol(), "TCGR");
  });

  it("returns minter set at deployment", async function () {
    const { tcgr, minter } = await networkHelpers.loadFixture(deployFixture);
    assert.strictEqual((await tcgr.read.minter()).toLowerCase(), minter.account.address.toLowerCase());
  });

  it("uses 30-day referral vesting bucket", async function () {
    const { tcgr } = await networkHelpers.loadFixture(deployFixture);
    assert.strictEqual(await tcgr.read.REFERRAL_VESTING_BUCKET(), 30n * 24n * 60n * 60n);
  });

  it("only minter can call processValidatedBuy", async function () {
    const { tcgr, minter, referrer, referee, owner } = await networkHelpers.loadFixture(deployFixture);
    await tcgr.write.setReferrer([referrer.account.address], { account: referee.account });
    const usdc6 = usdc6ForTcgrReward(parseEther("100"));
    await tcgr.write.processValidatedBuy([referee.account.address, usdc6], { account: minter.account });
    assert.ok((await tcgr.read.balanceOf([referrer.account.address])) >= parseEther("100"));

    await viem.assertions.revertWithCustomError(
      tcgr.write.processValidatedBuy([referee.account.address, usdc6], { account: owner.account }),
      tcgr,
      "OnlyMinter"
    );
  });

  it("setMinter updates minter and only owner can call", async function () {
    const { tcgr, owner, minter, referrer, referee } = await networkHelpers.loadFixture(deployFixture);
    const newMinter = referrer;
    await tcgr.write.setMinter([newMinter.account.address], { account: owner.account });
    assert.strictEqual((await tcgr.read.minter()).toLowerCase(), newMinter.account.address.toLowerCase());

    await tcgr.write.setReferrer([owner.account.address], { account: referee.account });
    const usdc6 = usdc6ForTcgrReward(parseEther("50"));
    await tcgr.write.processValidatedBuy([referee.account.address, usdc6], { account: newMinter.account });
    assert.ok((await tcgr.read.balanceOf([owner.account.address])) >= parseEther("50"));

    await viem.assertions.revertWithCustomError(
      tcgr.write.setMinter([newMinter.account.address], { account: minter.account }),
      tcgr,
      "OwnableUnauthorizedAccount"
    );
  });

  it("processValidatedBuy does nothing when usdc amount is zero", async function () {
    const { tcgr, minter, referrer, referee } = await networkHelpers.loadFixture(deployFixture);
    await tcgr.write.setReferrer([referrer.account.address], { account: referee.account });
    await tcgr.write.processValidatedBuy([referee.account.address, 0n], { account: minter.account });
    assert.strictEqual(await tcgr.read.balanceOf([referrer.account.address]), 0n);
  });

  it("setReferrer binds once; self and zero revert; second set reverts", async function () {
    const { tcgr, referrer, referee, owner } = await networkHelpers.loadFixture(deployFixture);
    await viem.assertions.revertWithCustomError(
      tcgr.write.setReferrer([zeroAddress], { account: referee.account }),
      tcgr,
      "ZeroAddress"
    );
    await viem.assertions.revertWithCustomError(
      tcgr.write.setReferrer([referee.account.address], { account: referee.account }),
      tcgr,
      "SelfReferralNotAllowed"
    );
    await tcgr.write.setReferrer([referrer.account.address], { account: referee.account });
    assert.strictEqual(
      (await tcgr.read.referrerOf([referee.account.address])).toLowerCase(),
      referrer.account.address.toLowerCase(),
    );
    await viem.assertions.revertWithCustomError(
      tcgr.write.setReferrer([owner.account.address], { account: referee.account }),
      tcgr,
      "ReferrerAlreadySet"
    );
  });

  it("processValidatedBuy no-op when referee has no referrer", async function () {
    const { tcgr, minter, referrer, referee } = await networkHelpers.loadFixture(deployFixture);
    await tcgr.write.processValidatedBuy([referee.account.address, usdc6ForTcgrReward(parseEther("1"))], {
      account: minter.account,
    });
    assert.strictEqual(await tcgr.read.balanceOf([referrer.account.address]), 0n);
  });

  it("is soulbound: transfer reverts", async function () {
    const { tcgr, minter, referrer, referee, owner } = await networkHelpers.loadFixture(deployFixture);
    await rewardReferrer(tcgr, minter, referee, referrer.account.address, parseEther("100"));
    await viem.assertions.revertWithCustomError(
      tcgr.write.transfer([owner.account.address, parseEther("10")], { account: referrer.account }),
      tcgr,
      "SoulboundTransferNotAllowed"
    );
  });

  it("is soulbound: transferFrom reverts", async function () {
    const { tcgr, minter, referrer, referee, owner } = await networkHelpers.loadFixture(deployFixture);
    await rewardReferrer(tcgr, minter, referee, referrer.account.address, parseEther("100"));
    await tcgr.write.approve([owner.account.address, parseEther("10")], { account: referrer.account });
    await viem.assertions.revertWithCustomError(
      tcgr.write.transferFrom([referrer.account.address, owner.account.address, parseEther("10")], { account: owner.account }),
      tcgr,
      "SoulboundTransferNotAllowed"
    );
  });

  it("setMinter reverts when new minter is zero", async function () {
    const { tcgr, owner } = await networkHelpers.loadFixture(deployFixture);
    await viem.assertions.revertWithCustomError(
      tcgr.write.setMinter([zeroAddress], { account: owner.account }),
      tcgr,
      "ZeroAddress"
    );
  });

  it("converter is zero by default", async function () {
    const { tcgr } = await networkHelpers.loadFixture(deployFixture);
    assert.strictEqual(await tcgr.read.converter(), zeroAddress);
  });

  it("converter() returns set converter address", async function () {
    const { tcgr, owner, referrer } = await networkHelpers.loadFixture(deployFixture);
    await tcgr.write.setConverter([referrer.account.address], { account: owner.account });
    assert.strictEqual((await tcgr.read.converter()).toLowerCase(), referrer.account.address.toLowerCase());
  });

  it("burnForConversion(account, 0) is no-op when called by converter", async function () {
    const { tcgr, owner, minter, referrer, referee } = await networkHelpers.loadFixture(deployFixture);
    await rewardReferrer(tcgr, minter, referee, referrer.account.address, parseEther("100"));
    const mockConverter = await viem.deployContract("contracts/test/MockTCGRConverter.sol:MockTCGRConverter", [], { client: { wallet: owner } });
    await tcgr.write.setConverter([mockConverter.address], { account: owner.account });
    await mockConverter.write.burnZero([tcgr.address, referrer.account.address], { account: owner.account });
    assert.ok((await tcgr.read.balanceOf([referrer.account.address])) >= parseEther("100"));
  });

  it("burnForConversion reverts ZeroAddress when account is zero (called by converter)", async function () {
    const { tcgr, owner } = await networkHelpers.loadFixture(deployFixture);
    const mockConverter = await viem.deployContract("contracts/test/MockTCGRConverter.sol:MockTCGRConverter", [], { client: { wallet: owner } });
    await tcgr.write.setConverter([mockConverter.address], { account: owner.account });
    await viem.assertions.revertWithCustomError(
      mockConverter.write.burnFromZeroAddress([tcgr.address], { account: owner.account }),
      tcgr,
      "ZeroAddress"
    );
  });

  it("setConverter updates converter and only owner can call", async function () {
    const { tcgr, owner, minter, referrer } = await networkHelpers.loadFixture(deployFixture);
    await tcgr.write.setConverter([referrer.account.address], { account: owner.account });
    assert.strictEqual((await tcgr.read.converter()).toLowerCase(), referrer.account.address.toLowerCase());

    await viem.assertions.revertWithCustomError(
      tcgr.write.setConverter([owner.account.address], { account: minter.account }),
      tcgr,
      "OwnableUnauthorizedAccount"
    );
  });

  it("setConverter(0) is allowed (disables converter)", async function () {
    const { tcgr, owner, referrer } = await networkHelpers.loadFixture(deployFixture);
    await tcgr.write.setConverter([referrer.account.address], { account: owner.account });
    await tcgr.write.setConverter([zeroAddress], { account: owner.account });
    assert.strictEqual(await tcgr.read.converter(), zeroAddress);
  });

  it("processValidatedBuy no-op when qualifying NFT is required but referrer has none", async function () {
    const { tcgr, owner, minter, referee, qualifyingNft } = await networkHelpers.loadFixture(deployFixture);
    const wallets = await viem.getWalletClients();
    const nonHolderReferrer = wallets[5]!;
    await tcgr.write.setReferrer([nonHolderReferrer.account.address], { account: referee.account });
    await tcgr.write.setQualifyingNft([qualifyingNft.address], { account: owner.account });
    await tcgr.write.processValidatedBuy([referee.account.address, usdc6ForTcgrReward(parseEther("10"))], {
      account: minter.account,
    });
    assert.strictEqual(await tcgr.read.balanceOf([nonHolderReferrer.account.address]), 0n);
  });

  it("only converter can call burnForConversion", async function () {
    const { tcgr, owner, minter, referrer, referee } = await networkHelpers.loadFixture(deployFixture);
    await rewardReferrer(tcgr, minter, referee, referrer.account.address, parseEther("100"));
    await tcgr.write.setConverter([zeroAddress], { account: owner.account });
    await viem.assertions.revertWithCustomError(
      tcgr.write.burnForConversion([referrer.account.address, parseEther("10")], { account: owner.account }),
      tcgr,
      "OnlyConverter"
    );
  });

  it("burnForConversion zero amount is no-op (only converter can call; convert(0) reverts in converter)", async function () {
    const { tcgr, owner, minter, referrer, referee } = await networkHelpers.loadFixture(deployFixture);
    await rewardReferrer(tcgr, minter, referee, referrer.account.address, parseEther("100"));
    const mockTcgv = await viem.deployContract("contracts/test/MockTCGVPresale.sol:MockTCGVPresale", [], { client: { wallet: owner } });
    await mockTcgv.write.mint([owner.account.address, parseEther("100")], { account: owner.account });
    const converterContract = await viem.deployContract("TCGRToTCGVConverter", [
      tcgr.address,
      mockTcgv.address,
      parseEther("1"),
    ], { client: { wallet: owner } });
    await tcgr.write.setConverter([converterContract.address], { account: owner.account });
    await mockTcgv.write.transfer([converterContract.address, parseEther("100")], { account: owner.account });
    await tcgr.write.approve([converterContract.address, parseEther("100")], { account: referrer.account });
    await viem.assertions.revertWithCustomError(
      converterContract.write.convert([0n, 0n], { account: referrer.account }),
      converterContract,
      "ZeroAmount"
    );
    assert.ok((await tcgr.read.balanceOf([referrer.account.address])) >= parseEther("100"));
  });

  it("burnForConversion reverts when insufficient balance", async function () {
    const { tcgr, owner, minter, referrer, referee } = await networkHelpers.loadFixture(deployFixture);
    await rewardReferrer(tcgr, minter, referee, referrer.account.address, parseEther("10"));
    await networkHelpers.time.increase(30n * 24n * 60n * 60n + 1n);
    const mockTcgv = await viem.deployContract("contracts/test/MockTCGVPresale.sol:MockTCGVPresale", [], { client: { wallet: owner } });
    await mockTcgv.write.mint([owner.account.address, parseEther("1000")], { account: owner.account });
    const converterContract = await viem.deployContract("TCGRToTCGVConverter", [
      tcgr.address,
      mockTcgv.address,
      parseEther("1"),
    ], { client: { wallet: owner } });
    await tcgr.write.setConverter([converterContract.address], { account: owner.account });
    await mockTcgv.write.transfer([converterContract.address, parseEther("100")], { account: owner.account });
    await tcgr.write.approve([converterContract.address, parseEther("100")], { account: referrer.account });
    await viem.assertions.revertWithCustomError(
      converterContract.write.convert([parseEther("100"), parseEther("100")], { account: referrer.account }),
      tcgr,
      "InsufficientBalance"
    );
  });

  it("convert reverts when TCGR allowance to converter is insufficient", async function () {
    const { tcgr, owner, minter, referrer, referee } = await networkHelpers.loadFixture(deployFixture);
    await rewardReferrer(tcgr, minter, referee, referrer.account.address, parseEther("50"));
    await networkHelpers.time.increase(30n * 24n * 60n * 60n + 1n);
    const mockTcgv = await viem.deployContract("contracts/test/MockTCGVPresale.sol:MockTCGVPresale", [], { client: { wallet: owner } });
    await mockTcgv.write.mint([owner.account.address, parseEther("1000")], { account: owner.account });
    const converterContract = await viem.deployContract("TCGRToTCGVConverter", [
      tcgr.address,
      mockTcgv.address,
      parseEther("1"),
    ], { client: { wallet: owner } });
    await tcgr.write.setConverter([converterContract.address], { account: owner.account });
    await mockTcgv.write.transfer([converterContract.address, parseEther("1000")], { account: owner.account });
    await tcgr.write.approve([converterContract.address, parseEther("10")], { account: referrer.account });
    await viem.assertions.revertWithCustomError(
      converterContract.write.convert([parseEther("50"), parseEther("50")], { account: referrer.account }),
      tcgr,
      "ERC20InsufficientAllowance"
    );
  });

  it("burnForConversion reverts when amount is not yet unlocked this month", async function () {
    const { tcgr, owner, minter, referrer, referee } = await networkHelpers.loadFixture(deployFixture);
    await rewardReferrer(tcgr, minter, referee, referrer.account.address, parseEther("10"));
    const mockTcgv = await viem.deployContract("contracts/test/MockTCGVPresale.sol:MockTCGVPresale", [], {
      client: { wallet: owner },
    });
    await mockTcgv.write.mint([owner.account.address, parseEther("100")], { account: owner.account });
    const converterContract = await viem.deployContract(
      "TCGRToTCGVConverter",
      [tcgr.address, mockTcgv.address, parseEther("1")],
      { client: { wallet: owner } },
    );
    await tcgr.write.setConverter([converterContract.address], { account: owner.account });
    await mockTcgv.write.transfer([converterContract.address, parseEther("100")], { account: owner.account });
    await tcgr.write.approve([converterContract.address, parseEther("1")], { account: referrer.account });
    await viem.assertions.revertWithCustomError(
      converterContract.write.convert([parseEther("1"), parseEther("1")], { account: referrer.account }),
      tcgr,
      "InsufficientUnlockedBalance"
    );
  });

  it("burnForConversion succeeds after moving into next referral bucket", async function () {
    const { tcgr, owner, minter, referrer, referee } = await networkHelpers.loadFixture(deployFixture);
    const amount = parseEther("10");
    await rewardReferrer(tcgr, minter, referee, referrer.account.address, amount);
    await networkHelpers.time.increase(30n * 24n * 60n * 60n + 1n);

    const mockTcgv = await viem.deployContract("contracts/test/MockTCGVPresale.sol:MockTCGVPresale", [], {
      client: { wallet: owner },
    });
    await mockTcgv.write.mint([owner.account.address, parseEther("100")], { account: owner.account });
    const converterContract = await viem.deployContract("TCGRToTCGVConverter", [
      tcgr.address,
      mockTcgv.address,
      parseEther("1"),
    ], { client: { wallet: owner } });
    await tcgr.write.setConverter([converterContract.address], { account: owner.account });
    await mockTcgv.write.transfer([converterContract.address, parseEther("100")], { account: owner.account });
    await tcgr.write.approve([converterContract.address, amount], { account: referrer.account });
    await converterContract.write.convert([amount, amount], { account: referrer.account });

    assert.strictEqual(await tcgr.read.balanceOf([referrer.account.address]), 0n);
  });

  it("setBannedFromReferralProgram: only owner", async function () {
    const { tcgr, owner, minter, referrer } = await networkHelpers.loadFixture(deployFixture);
    await viem.assertions.revertWithCustomError(
      tcgr.write.setBannedFromReferralProgram([referrer.account.address, true], { account: minter.account }),
      tcgr,
      "OwnableUnauthorizedAccount"
    );
    await tcgr.write.setBannedFromReferralProgram([referrer.account.address, true], { account: owner.account });
    assert.strictEqual(await tcgr.read.isBannedFromReferralProgram([referrer.account.address]), true);
  });

  it("setBannedFromReferralProgram reverts for zero address", async function () {
    const { tcgr, owner } = await networkHelpers.loadFixture(deployFixture);
    await viem.assertions.revertWithCustomError(
      tcgr.write.setBannedFromReferralProgram([zeroAddress, true], { account: owner.account }),
      tcgr,
      "ZeroAddress"
    );
  });

  it("processValidatedBuy no-op when buyer is banned from referral program", async function () {
    const { tcgr, owner, minter, referrer, referee } = await networkHelpers.loadFixture(deployFixture);
    await tcgr.write.setReferrer([referrer.account.address], { account: referee.account });
    await tcgr.write.setBannedFromReferralProgram([referee.account.address, true], { account: owner.account });
    const usdc6 = usdc6ForTcgrReward(parseEther("100"));
    await tcgr.write.processValidatedBuy([referee.account.address, usdc6], { account: minter.account });
    assert.strictEqual(await tcgr.read.balanceOf([referrer.account.address]), 0n);
    await tcgr.write.setBannedFromReferralProgram([referee.account.address, false], { account: owner.account });
    await tcgr.write.processValidatedBuy([referee.account.address, usdc6], { account: minter.account });
    assert.ok((await tcgr.read.balanceOf([referrer.account.address])) >= parseEther("100"));
  });

  it("processValidatedBuy no-op when referrer is banned from referral program", async function () {
    const { tcgr, owner, minter, referrer, referee } = await networkHelpers.loadFixture(deployFixture);
    await tcgr.write.setReferrer([referrer.account.address], { account: referee.account });
    const usdc6 = usdc6ForTcgrReward(parseEther("50"));
    await tcgr.write.processValidatedBuy([referee.account.address, usdc6], { account: minter.account });
    const balBefore = await tcgr.read.balanceOf([referrer.account.address]);
    assert.ok(balBefore >= parseEther("50"));

    await tcgr.write.setBannedFromReferralProgram([referrer.account.address, true], { account: owner.account });
    await tcgr.write.processValidatedBuy([referee.account.address, usdc6], { account: minter.account });
    assert.strictEqual(await tcgr.read.balanceOf([referrer.account.address]), balBefore);

    await tcgr.write.setBannedFromReferralProgram([referrer.account.address, false], { account: owner.account });
    await tcgr.write.processValidatedBuy([referee.account.address, usdc6], { account: minter.account });
    assert.ok((await tcgr.read.balanceOf([referrer.account.address])) > balBefore);
  });

  it("banned referrer receives no TCGR from any referee", async function () {
    const wallets = await viem.getWalletClients();
    const referee2 = wallets[4];
    if (!referee2) {
      throw new Error("need wallet index 4 for second referee");
    }
    const { tcgr, owner, minter, referrer, referee } = await networkHelpers.loadFixture(deployFixture);
    await tcgr.write.setReferrer([referrer.account.address], { account: referee.account });
    await tcgr.write.setReferrer([referrer.account.address], { account: referee2.account });
    await tcgr.write.setBannedFromReferralProgram([referrer.account.address, true], { account: owner.account });
    const usdc6 = usdc6ForTcgrReward(parseEther("10"));
    await tcgr.write.processValidatedBuy([referee.account.address, usdc6], { account: minter.account });
    await tcgr.write.processValidatedBuy([referee2.account.address, usdc6], { account: minter.account });
    assert.strictEqual(await tcgr.read.balanceOf([referrer.account.address]), 0n);
  });
});

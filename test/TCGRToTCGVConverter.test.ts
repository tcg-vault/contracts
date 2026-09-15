/**
 * Tests for TCGRToTCGVConverter: burn TCGR for TCGV at a fixed ratio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { parseEther } from "viem";

const { viem, networkHelpers } = await hre.network.connect();

function usdc6ForTcgrReward(tcgrWei: bigint): bigint {
  const denom = 50n * 10n ** 8n;
  return (tcgrWei + denom - 1n) / denom;
}

async function deployFixture() {
  const wallets = await viem.getWalletClients();
  const owner = wallets[0]!;
  const minter = wallets[1]!;
  const user = wallets[2]!;
  const referee = wallets[3]!;

  const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], { client: { wallet: owner } });
  const tcgr = await viem.deployContract("TCGRToken", [minter.account.address, usdc.address], { client: { wallet: owner } });
  const mockTcgv = await viem.deployContract("contracts/test/MockTCGVPresale.sol:MockTCGVPresale", [], { client: { wallet: owner } });
  await mockTcgv.write.mint([owner.account.address, parseEther("1000000")], { account: owner.account });

  const ratio = parseEther("1"); // 1 TCGR = 1 TCGV (18 decimals)
  const converter = await viem.deployContract("TCGRToTCGVConverter", [
    tcgr.address,
    mockTcgv.address,
    ratio,
  ], { client: { wallet: owner } });

  await tcgr.write.setConverter([converter.address], { account: owner.account });
  await mockTcgv.write.transfer([converter.address, parseEther("100000")], { account: owner.account });

  return { owner, minter, user, referee, tcgr, mockTcgv, converter, usdc };
}

async function mintTcgrToUser(
  tcgr: Awaited<ReturnType<typeof deployFixture>>["tcgr"],
  minter: Awaited<ReturnType<typeof deployFixture>>["minter"],
  referee: Awaited<ReturnType<typeof deployFixture>>["referee"],
  userAddr: `0x${string}`,
  tcgrWei: bigint,
) {
  await tcgr.write.setReferrer([userAddr], { account: referee.account });
  await tcgr.write.processValidatedBuy([referee.account.address, usdc6ForTcgrReward(tcgrWei)], { account: minter.account });
  await networkHelpers.time.increase(30n * 24n * 60n * 60n + 1n);
}

describe("TCGRToTCGVConverter", function () {
  it("stores tcgr, tcgv, ratio and returns getTcgvOut", async function () {
    const { tcgr, mockTcgv, converter } = await networkHelpers.loadFixture(deployFixture);
    assert.strictEqual((await converter.read.tcgr()).toLowerCase(), tcgr.address.toLowerCase());
    assert.strictEqual((await converter.read.tcgv()).toLowerCase(), mockTcgv.address.toLowerCase());
    assert.strictEqual(await converter.read.ratio(), parseEther("1"));
    const out = await converter.read.getTcgvOut([parseEther("100")]);
    assert.strictEqual(out, parseEther("100"));
  });

  it("convert burns TCGR and sends TCGV at 1:1 ratio", async function () {
    const { tcgr, mockTcgv, converter, minter, user, referee } = await networkHelpers.loadFixture(deployFixture);
    const amount = parseEther("500");
    await mintTcgrToUser(tcgr, minter, referee, user.account.address, amount);

    const userTcgvBefore = await mockTcgv.read.balanceOf([user.account.address]);
    await tcgr.write.approve([converter.address, amount], { account: user.account });
    await converter.write.convert([amount, amount], { account: user.account });
    const userTcgvAfter = await mockTcgv.read.balanceOf([user.account.address]);

    assert.strictEqual(await tcgr.read.balanceOf([user.account.address]), 0n);
    assert.strictEqual(userTcgvAfter - userTcgvBefore, amount);
  });

  it("convert with ratio 0.5: 100 TCGR gives 50 TCGV", async function () {
    const { tcgr, mockTcgv, converter, owner, minter, user, referee } = await networkHelpers.loadFixture(deployFixture);
    const halfRatio = (1n * 10n ** 18n) / 2n; // 0.5e18
    await converter.write.setRatio([halfRatio], { account: owner.account });
    assert.strictEqual(await converter.read.getTcgvOut([parseEther("100")]), parseEther("50"));

    await mintTcgrToUser(tcgr, minter, referee, user.account.address, parseEther("100"));
    const userTcgvBefore = await mockTcgv.read.balanceOf([user.account.address]);
    await tcgr.write.approve([converter.address, parseEther("100")], { account: user.account });
    await converter.write.convert([parseEther("100"), parseEther("50")], { account: user.account });
    const userTcgvAfter = await mockTcgv.read.balanceOf([user.account.address]);
    assert.strictEqual(userTcgvAfter - userTcgvBefore, parseEther("50"));
    assert.strictEqual(await tcgr.read.balanceOf([user.account.address]), 0n);
  });

  it("setRatio only owner and emits RatioUpdated", async function () {
    const { converter, owner, user } = await networkHelpers.loadFixture(deployFixture);
    const newRatio = parseEther("2");
    const hash = await converter.write.setRatio([newRatio], { account: owner.account });
    const publicClient = await viem.getPublicClient();
    const receipt = await publicClient!.waitForTransactionReceipt({ hash });
    const logs = await publicClient!.getContractEvents({
      address: converter.address,
      abi: converter.abi,
      eventName: "RatioUpdated",
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0]!.args.oldRatio, parseEther("1"));
    assert.strictEqual(logs[0]!.args.newRatio, newRatio);

    await viem.assertions.revertWithCustomError(
      converter.write.setRatio([parseEther("1")], { account: user.account }),
      converter,
      "OwnableUnauthorizedAccount"
    );
  });

  it("convert reverts when output falls below minTcgvOut", async function () {
    const { tcgr, converter, owner, minter, user, referee } = await networkHelpers.loadFixture(deployFixture);
    const amount = parseEther("100");
    await mintTcgrToUser(tcgr, minter, referee, user.account.address, amount);
    await tcgr.write.approve([converter.address, amount], { account: user.account });
    await converter.write.setRatio([parseEther("0.5")], { account: owner.account });
    await viem.assertions.revertWithCustomError(
      converter.write.convert([amount, amount], { account: user.account }),
      converter,
      "SlippageExceeded"
    );
  });

  it("convert reverts when insufficient TCGV reserve", async function () {
    const { tcgr, mockTcgv, converter, minter, user, referee } = await networkHelpers.loadFixture(deployFixture);
    await mintTcgrToUser(tcgr, minter, referee, user.account.address, parseEther("200000"));
    await tcgr.write.approve([converter.address, parseEther("200000")], { account: user.account });
    await viem.assertions.revertWithCustomError(
      converter.write.convert([parseEther("200000"), parseEther("200000")], { account: user.account }),
      converter,
      "InsufficientTcgvReserve"
    );
  });

  it("convert reverts ZeroAmount for zero input", async function () {
    const { converter, user } = await networkHelpers.loadFixture(deployFixture);
    await viem.assertions.revertWithCustomError(
      converter.write.convert([0n, 0n], { account: user.account }),
      converter,
      "ZeroAmount"
    );
  });

  it("convert reverts ZeroAmount when tcgvOut is zero (tiny amount)", async function () {
    const wallets = await viem.getWalletClients();
    const owner = wallets[0]!;
    const minter = wallets[1]!;
    const user = wallets[2]!;
    const referee = wallets[3]!;
    const usdc = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], { client: { wallet: owner } });
    const tcgr = await viem.deployContract("TCGRToken", [minter.account.address, usdc.address], { client: { wallet: owner } });
    const mockTcgv = await viem.deployContract("contracts/test/MockTCGVPresale.sol:MockTCGVPresale", [], { client: { wallet: owner } });
    await mockTcgv.write.mint([owner.account.address, parseEther("1000")], { account: owner.account });
    const tinyRatio = 1n; // 1 wei: (1 * 1) / 1e18 = 0
    const converter = await viem.deployContract("TCGRToTCGVConverter", [
      tcgr.address,
      mockTcgv.address,
      tinyRatio,
    ], { client: { wallet: owner } });
    await tcgr.write.setConverter([converter.address], { account: owner.account });
    await mockTcgv.write.transfer([converter.address, parseEther("1000")], { account: owner.account });
    await tcgr.write.setReferrer([user.account.address], { account: referee.account });
    await tcgr.write.processValidatedBuy([referee.account.address, usdc6ForTcgrReward(1n)], { account: minter.account });
    await tcgr.write.approve([converter.address, 1n], { account: user.account });
    await viem.assertions.revertWithCustomError(
      converter.write.convert([1n, 0n], { account: user.account }),
      converter,
      "ZeroAmount"
    );
  });

  it("constructor reverts when ratio is zero", async function () {
    const { tcgr, mockTcgv, converter } = await networkHelpers.loadFixture(deployFixture);
    const owner = (await viem.getWalletClients())[0]!;
    await viem.assertions.revertWithCustomError(
      viem.deployContract("TCGRToTCGVConverter", [tcgr.address, mockTcgv.address, 0n], { client: { wallet: owner } }),
      converter,
      "ZeroRatio"
    );
  });

  it("setRatio reverts when ratio is zero", async function () {
    const { converter, owner } = await networkHelpers.loadFixture(deployFixture);
    await viem.assertions.revertWithCustomError(
      converter.write.setRatio([0n], { account: owner.account }),
      converter,
      "ZeroRatio"
    );
  });

  it("Converted event is emitted", async function () {
    const { tcgr, mockTcgv, converter, minter, user, referee } = await networkHelpers.loadFixture(deployFixture);
    const amount = parseEther("77");
    await mintTcgrToUser(tcgr, minter, referee, user.account.address, amount);
    await tcgr.write.approve([converter.address, amount], { account: user.account });
    const hash = await converter.write.convert([amount, amount], { account: user.account });
    const publicClient = await viem.getPublicClient();
    const receipt = await publicClient!.waitForTransactionReceipt({ hash });
    const logs = await publicClient!.getContractEvents({
      address: converter.address,
      abi: converter.abi,
      eventName: "Converted",
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    assert.strictEqual(logs.length, 1);
    assert.strictEqual((logs[0]!.args as { user: string }).user.toLowerCase(), user.account.address.toLowerCase());
    assert.strictEqual((logs[0]!.args as { tcgrBurned: bigint }).tcgrBurned, amount);
    assert.strictEqual((logs[0]!.args as { tcgvOut: bigint }).tcgvOut, amount);
  });
});

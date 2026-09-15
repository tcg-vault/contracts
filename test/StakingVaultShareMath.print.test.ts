/**
 * Prints ERC-4626 asset↔share math for TCGVaultStakingVault with tracked totalAssets().
 * Formulae (OZ, _decimalsOffset = 0):
 *   convertToShares(assets) = assets * (totalSupply + 1) / (totalAssets + 1)   // Floor
 *   convertToAssets(shares) = shares * (totalAssets + 1) / (totalSupply + 1)   // Floor
 *   previewMint(shares)     = shares * (totalAssets + 1) / (totalSupply + 1)   // Ceil
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { parseEther, formatEther } from "viem";

const { viem } = await hre.network.connect();

function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b) / d;
}

function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b + d - 1n) / d;
}

function fmt(x: bigint): string {
  return `${formatEther(x)} (${x.toString()} wei)`;
}

describe("StakingVault ERC-4626 share math (printed)", function () {
  it("deposit/redeem amounts match OZ convert formulae with tracked totalAssets", async function () {
    const wallets = await viem.getWalletClients();
    const owner = wallets[0]!;
    const alice = wallets[1]!;
    const bob = wallets[2]!;

    const tcgv = await viem.deployContract(
      "contracts/test/MockTCGVStakingAsset.sol:MockTCGVStakingAsset",
      [owner.account.address],
      { client: { wallet: owner } },
    );
    const vault = await viem.deployContract("TCGVaultStakingVault", [tcgv.address], {
      client: { wallet: owner },
    });

    const REQUIRED_SHARES = parseEther("100");
    await vault.write.setRequiredStakeForBasicNFT([REQUIRED_SHARES], { account: owner.account });

    await tcgv.write.transfer([alice.account.address, parseEther("1000")], { account: owner.account });
    await tcgv.write.transfer([bob.account.address, parseEther("1000")], { account: owner.account });

    const logState = async (label: string) => {
      const totalAssets = await vault.read.totalAssets();
      const totalSupply = await vault.read.totalSupply();
      const bal = await tcgv.read.balanceOf([vault.address]);
      console.log(`\n=== ${label} ===`);
      console.log(`totalAssets() [tracked] = ${fmt(totalAssets)}`);
      console.log(`totalSupply() [shares]  = ${fmt(totalSupply)}`);
      console.log(`TCGV balanceOf(vault)   = ${fmt(bal)}`);
      console.log(`surplus (balance-tracked) = ${fmt(bal - totalAssets)}`);
      return { totalAssets, totalSupply, bal };
    };

    // --- Empty vault ---
    let { totalAssets, totalSupply } = await logState("EMPTY vault");
    assert.strictEqual(totalAssets, 0n);
    assert.strictEqual(totalSupply, 0n);

    const sharesAlice = REQUIRED_SHARES;
    const expectedAssetsCeil = mulDivCeil(sharesAlice, totalAssets + 1n, totalSupply + 1n);
    const previewMintAlice = await vault.read.previewMint([sharesAlice]);
    console.log(`\n--- Alice mint quote (exact stake ${formatEther(sharesAlice)} shares) ---`);
    console.log(`OZ previewMint Ceil: shares*(A+1)/(S+1) = ${fmt(expectedAssetsCeil)}`);
    console.log(`vault.previewMint(shares)               = ${fmt(previewMintAlice)}`);
    assert.strictEqual(previewMintAlice, expectedAssetsCeil);

    await tcgv.write.approve([vault.address, previewMintAlice], { account: alice.account });
    const aliceBalBefore = await tcgv.read.balanceOf([alice.account.address]);
    await vault.write.deposit([previewMintAlice, alice.account.address], { account: alice.account });
    const aliceBalAfter = await tcgv.read.balanceOf([alice.account.address]);
    const aliceShares = await vault.read.balanceOf([alice.account.address]);

    console.log(`\n--- After Alice deposit ---`);
    console.log(`Alice paid assets     = ${fmt(aliceBalBefore - aliceBalAfter)}`);
    console.log(`Alice received shares = ${fmt(aliceShares)}`);
    assert.strictEqual(aliceBalBefore - aliceBalAfter, previewMintAlice);
    assert.strictEqual(aliceShares, sharesAlice);

    ({ totalAssets, totalSupply } = await logState("AFTER Alice deposit"));
    assert.strictEqual(totalAssets, previewMintAlice);
    assert.strictEqual(totalSupply, sharesAlice);

    // Formula check at this state
    const sampleAssets = parseEther("10");
    const sampleShares = parseEther("10");
    const toSharesFloor = mulDivFloor(sampleAssets, totalSupply + 1n, totalAssets + 1n);
    const toAssetsFloor = mulDivFloor(sampleShares, totalAssets + 1n, totalSupply + 1n);
    const vaultToShares = await vault.read.convertToShares([sampleAssets]);
    const vaultToAssets = await vault.read.convertToAssets([sampleShares]);
    console.log(`\n--- Convert checks (A=${formatEther(totalAssets)}, S=${formatEther(totalSupply)}) ---`);
    console.log(`convertToShares(10e18): formula Floor = ${fmt(toSharesFloor)}`);
    console.log(`convertToShares(10e18): vault         = ${fmt(vaultToShares)}`);
    console.log(`convertToAssets(10e18): formula Floor = ${fmt(toAssetsFloor)}`);
    console.log(`convertToAssets(10e18): vault         = ${fmt(vaultToAssets)}`);
    assert.strictEqual(vaultToShares, toSharesFloor);
    assert.strictEqual(vaultToAssets, toAssetsFloor);

    // Donation must NOT change tracked totalAssets / convert rates
    const donation = parseEther("50");
    const toSharesBeforeDonation = await vault.read.convertToShares([sampleAssets]);
    await tcgv.write.transfer([vault.address, donation], { account: owner.account });
    ({ totalAssets, totalSupply } = await logState("AFTER 50 TCGV plain transfer (donation)"));
    const toSharesAfterDonation = await vault.read.convertToShares([sampleAssets]);
    console.log(`\nconvertToShares(10) before donation = ${fmt(toSharesBeforeDonation)}`);
    console.log(`convertToShares(10) after donation  = ${fmt(toSharesAfterDonation)}`);
    assert.strictEqual(totalAssets, previewMintAlice, "tracked totalAssets must ignore donation");
    assert.strictEqual(toSharesAfterDonation, toSharesBeforeDonation);

    // Bob deposits same exact stake — rate still 1:1 on tracked assets
    const sharesBob = REQUIRED_SHARES;
    const previewMintBob = await vault.read.previewMint([sharesBob]);
    const expectedBobAssets = mulDivCeil(sharesBob, totalAssets + 1n, totalSupply + 1n);
    console.log(`\n--- Bob mint quote ---`);
    console.log(`OZ previewMint Ceil = ${fmt(expectedBobAssets)}`);
    console.log(`vault.previewMint   = ${fmt(previewMintBob)}`);
    assert.strictEqual(previewMintBob, expectedBobAssets);

    await tcgv.write.approve([vault.address, previewMintBob], { account: bob.account });
    const bobBefore = await tcgv.read.balanceOf([bob.account.address]);
    await vault.write.deposit([previewMintBob, bob.account.address], { account: bob.account });
    const bobAfter = await tcgv.read.balanceOf([bob.account.address]);
    const bobShares = await vault.read.balanceOf([bob.account.address]);
    console.log(`Bob paid assets     = ${fmt(bobBefore - bobAfter)}`);
    console.log(`Bob received shares = ${fmt(bobShares)}`);
    assert.strictEqual(bobBefore - bobAfter, previewMintBob);
    assert.strictEqual(bobShares, sharesBob);

    ({ totalAssets, totalSupply } = await logState("AFTER Alice + Bob deposits"));
    assert.strictEqual(totalAssets, previewMintAlice + previewMintBob);
    assert.strictEqual(totalSupply, sharesAlice + sharesBob);

    // Alice full redeem — assets out from formula at pre-redeem state
    const aliceSharesNow = await vault.read.balanceOf([alice.account.address]);
    const expectedRedeemFloor = mulDivFloor(aliceSharesNow, totalAssets + 1n, totalSupply + 1n);
    const previewRedeemAlice = await vault.read.previewRedeem([aliceSharesNow]);
    console.log(`\n--- Alice full redeem ---`);
    console.log(`OZ previewRedeem Floor: shares*(A+1)/(S+1) = ${fmt(expectedRedeemFloor)}`);
    console.log(`vault.previewRedeem(shares)                = ${fmt(previewRedeemAlice)}`);
    assert.strictEqual(previewRedeemAlice, expectedRedeemFloor);

    const aliceTokBefore = await tcgv.read.balanceOf([alice.account.address]);
    await vault.write.redeem([aliceSharesNow, alice.account.address, alice.account.address], {
      account: alice.account,
    });
    const aliceTokAfter = await tcgv.read.balanceOf([alice.account.address]);
    const aliceReceived = aliceTokAfter - aliceTokBefore;
    console.log(`Alice received assets on redeem = ${fmt(aliceReceived)}`);
    assert.strictEqual(aliceReceived, previewRedeemAlice);
    assert.strictEqual(await vault.read.balanceOf([alice.account.address]), 0n);

    ({ totalAssets, totalSupply } = await logState("AFTER Alice redeem (Bob still in)"));
    assert.strictEqual(totalSupply, sharesBob);
    assert.strictEqual(totalAssets, previewMintAlice + previewMintBob - previewRedeemAlice);

    // Recover donation — tracked unchanged, surplus cleared
    const ownerBefore = await tcgv.read.balanceOf([owner.account.address]);
    await vault.write.recoverUnsolicitedAssets([owner.account.address], { account: owner.account });
    const ownerAfter = await tcgv.read.balanceOf([owner.account.address]);
    console.log(`\nOwner recovered surplus = ${fmt(ownerAfter - ownerBefore)}`);
    assert.strictEqual(ownerAfter - ownerBefore, donation);
    await logState("AFTER recoverUnsolicitedAssets");

    console.log("\nOK: paid assets ↔ minted shares and redeem assets match OZ formulae with tracked totalAssets.");
  });
});

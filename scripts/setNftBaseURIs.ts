/**
 * Set NFT baseURIs on BSC mainnet (56) or chapel testnet (97):
 *   - Founder → ipfs://<ROOT>/founder/
 *   - Basic   → https://metadata.tcg-vault.io/basic/
 *
 * Addresses default from:
 *   - bsc:     .cache/last-bsc-mainnet-deploy-full.json
 *   - bsctest: .cache/last-bsctest-deploy.json
 *
 * Optional: FOUNDER_NFT_ADDRESS, BASIC_NFT_ADDRESS, IPFS_ROOT_CID, BASIC_BASE_URI
 *
 * Usage:
 *   yarn hardhat run scripts/setNftBaseURIs.ts --network bsc
 *   yarn hardhat run scripts/setNftBaseURIs.ts --network bsctest
 *
 * bsctest signs with TCG_KEY_TESTNET (falls back to TCG_KEY if unset).
 */

import hre from "hardhat";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineChain, getAddress, type Address, type Hex } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_ROOT = join(__dirname, "..");
const MAINNET_CACHE = join(CONTRACTS_ROOT, ".cache", "last-bsc-mainnet-deploy-full.json");
const TESTNET_CACHE = join(CONTRACTS_ROOT, ".cache", "last-bsctest-deploy.json");

const DEFAULT_IPFS_ROOT = "bafybeiekepmukv7ipibpxyb46jsormteczxu22epbyh35vebf45duzgnw4";
const DEFAULT_BASIC_BASE = "https://metadata.tcg-vault.io/basic/";

function loadAddresses(chainId: number): { founderNFT?: string; basicNFT?: string } {
  if (chainId === 56 && existsSync(MAINNET_CACHE)) {
    const j = JSON.parse(readFileSync(MAINNET_CACHE, "utf8")) as {
      founderNFT?: string;
      basicNFT?: string;
    };
    return { founderNFT: j.founderNFT, basicNFT: j.basicNFT };
  }
  if (chainId === 97 && existsSync(TESTNET_CACHE)) {
    const j = JSON.parse(readFileSync(TESTNET_CACHE, "utf8")) as {
      addresses?: { founderNFT?: string; basicNFT?: string };
    };
    return {
      founderNFT: j.addresses?.founderNFT,
      basicNFT: j.addresses?.basicNFT,
    };
  }
  return {};
}

function resolveAddress(envName: string, cacheValue: string | undefined, label: string): Address {
  const fromEnv = process.env[envName]?.trim();
  const raw = fromEnv || cacheValue;
  if (!raw) throw new Error(`Missing ${label}: set ${envName} or populate deploy cache`);
  return getAddress(raw);
}

async function main() {
  const connection = await hre.network.connect();
  const { viem } = connection;
  const chainIdHex = (await connection.provider.request({ method: "eth_chainId" })) as string;
  const chainIdNum = Number(chainIdHex);

  if (chainIdNum !== 56 && chainIdNum !== 97) {
    throw new Error(`Refusing: expected BSC mainnet (56) or chapel (97), got ${chainIdNum}`);
  }

  const rpcUrl =
    (chainIdNum === 56 ? process.env.BSC_RPC_URL : process.env.BSCTEST_RPC_URL)?.trim() ||
    "http://127.0.0.1";
  const chain = defineChain({
    id: chainIdNum,
    name: chainIdNum === 56 ? "BNB Smart Chain" : "BNB Smart Chain Testnet",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const publicClient = await viem.getPublicClient({ chain });
  const [deployer] = await viem.getWalletClients({ chain });
  if (!deployer) throw new Error("No deployer wallet (check TCG_KEY)");

  const cache = loadAddresses(chainIdNum);
  const founderAddress = resolveAddress("FOUNDER_NFT_ADDRESS", cache.founderNFT, "Founder NFT");
  const basicAddress = resolveAddress("BASIC_NFT_ADDRESS", cache.basicNFT, "Basic NFT");

  const ipfsRoot = (process.env.IPFS_ROOT_CID?.trim() || DEFAULT_IPFS_ROOT)
    .replace(/^ipfs:\/\//, "")
    .replace(/\/$/, "");
  const founderBaseURI = `ipfs://${ipfsRoot}/founder/`;
  const basicBaseURI = process.env.BASIC_BASE_URI?.trim() || DEFAULT_BASIC_BASE;

  const founder = await viem.getContractAt("TCGVaultFounderNFT", founderAddress);
  const basic = await viem.getContractAt("TCGVaultBasicNFT", basicAddress);

  const founderOwner = getAddress((await founder.read.owner()) as string);
  const basicOwner = getAddress((await basic.read.owner()) as string);
  const sender = getAddress(deployer.account.address);

  const explorer =
    chainIdNum === 56 ? "https://bscscan.com" : "https://testnet.bscscan.com";

  console.log("chainId", chainIdNum);
  console.log("sender", sender);
  console.log("founder", founderAddress, "owner", founderOwner);
  console.log("basic  ", basicAddress, "owner", basicOwner);
  console.log("founderBaseURI", founderBaseURI);
  console.log("basicBaseURI  ", basicBaseURI);

  if (founderOwner !== sender) {
    throw new Error(`Deployer is not Founder owner (owner=${founderOwner})`);
  }
  if (basicOwner !== sender) {
    throw new Error(`Deployer is not Basic owner (owner=${basicOwner})`);
  }

  console.log("→ founder.setBaseURI");
  const h1 = (await founder.write.setBaseURI([founderBaseURI], {
    account: deployer.account,
  })) as Hex;
  console.log("  tx", h1);
  await publicClient.waitForTransactionReceipt({ hash: h1 });
  console.log("  ✓", `${explorer}/tx/${h1}`);

  console.log("→ basic.setBaseURI");
  const h2 = (await basic.write.setBaseURI([basicBaseURI], {
    account: deployer.account,
  })) as Hex;
  console.log("  tx", h2);
  await publicClient.waitForTransactionReceipt({ hash: h2 });
  console.log("  ✓", `${explorer}/tx/${h2}`);

  console.log("expected tokenURI(0):");
  console.log("  founder →", `${founderBaseURI}0`);
  console.log("  basic   →", `${basicBaseURI}0`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

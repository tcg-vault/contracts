import hre from "hardhat";
import { type Address, zeroAddress } from "viem";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

type SubgraphAddresses = Record<string, Address>;

function toAddress(v: string, label: string): Address {
  const s = v.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(s)) {
    throw new Error(`Invalid address for ${label}: ${v}`);
  }
  return s as Address;
}

function requiredEnvAddress(name: string): Address {
  const v = process.env[name];
  if (!v?.trim()) throw new Error(`Missing required env var ${name}`);
  return toAddress(v, name);
}

function optionalEnvAddress(name: string): Address | undefined {
  const v = process.env[name];
  if (!v?.trim()) return undefined;
  return toAddress(v, name);
}

/**
 * Minimal parser for The Graph manifest.
 * We only need `dataSources[].name` and `dataSources[].source.address`.
 */
function readSubgraphAddresses(manifestPath: string): SubgraphAddresses {
  const yml = readFileSync(manifestPath, "utf8");
  const out: SubgraphAddresses = {};

  const lines = yml.split(/\r?\n/);
  let currentName: string | null = null;
  for (const line of lines) {
    const nameMatch = line.match(/^\s*name:\s*([A-Za-z0-9_]+)\s*$/);
    if (nameMatch) {
      currentName = nameMatch[1];
      continue;
    }
    const addrMatch = line.match(/^\s*address:\s*["']?(0x[a-fA-F0-9]{40})["']?\s*$/);
    if (addrMatch && currentName) {
      out[currentName] = addrMatch[1].toLowerCase() as Address;
      currentName = null;
    }
  }

  return out;
}

type VerifyJob = {
  name: string;
  address: Address;
  contract?: string;
  constructorArguments: readonly unknown[];
};

async function verifyOne(job: VerifyJob): Promise<void> {
  try {
    const network = process.env.HARDHAT_NETWORK ?? "bsctest";
    const args = job.constructorArguments.map((v) => String(v));
    const proc = spawnSync(
      "yarn",
      [
        "hardhat",
        "verify",
        "--network",
        network,
        ...(job.contract ? ["--contract", job.contract] : []),
        job.address,
        ...args,
      ],
      { stdio: "pipe", encoding: "utf8", env: process.env },
    );
    const out = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`.trim();
    if (proc.status !== 0) {
      throw new Error(out || `hardhat verify exited with code ${proc.status}`);
    }
    console.log(`Verified: ${job.name} ${job.address}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes("already verified")) {
      console.log(`Already verified: ${job.name} ${job.address}`);
      return;
    }
    console.warn(`Verify failed: ${job.name} ${job.address}\n${msg}`);
  }
}

async function main() {
  // Note: on Hardhat 3, `hre.network.name` can be undefined depending on invocation.
  // Verification still targets the configured `--network` RPC used to run this script.

  const subgraphPath = resolve(
    process.env.SUBGRAPH_MANIFEST ?? "../subgraph/subgraph.yaml",
  );

  const sub = readSubgraphAddresses(subgraphPath);

  const tcgv = sub["TCGVaultToken"];
  const nexus = sub["TCGNexusToken"];
  const buyRouter = sub["TCGVaultBuyRouter"];
  const stakingVault = sub["TCGVaultStakingVault"];
  const basicNft = sub["TCGVaultBasicNFT"];
  const founderNft = sub["TCGVaultFounderNFT"];
  const initialLaunch = sub["TCGVaultInitialLaunch"];
  const tcgr = sub["TCGRToken"];
  const tcgrConverter = sub["TCGRToTCGVConverter"];
  const liquidityWrapper = sub["TCGVaultLiquidityWrapper"];

  const missing = Object.entries({
    TCGVaultToken: tcgv,
    TCGNexusToken: nexus,
    TCGVaultBuyRouter: buyRouter,
    TCGVaultStakingVault: stakingVault,
    TCGVaultBasicNFT: basicNft,
    TCGVaultFounderNFT: founderNft,
    TCGVaultInitialLaunch: initialLaunch,
    TCGRToken: tcgr,
    TCGRToTCGVConverter: tcgrConverter,
    TCGVaultLiquidityWrapper: liquidityWrapper,
  }).filter(([, v]) => !v);

  if (missing.length) {
    throw new Error(
      `Missing addresses in ${subgraphPath} for: ${missing.map(([k]) => k).join(", ")}`,
    );
  }

  // Pull constructor args from on-chain state when possible (avoids needing local deploy JSON).
  // Env vars can still override any value if needed.
  const { viem } = await hre.network.connect();

  const buyRouterC = await viem.getContractAt("TCGVaultBuyRouter", buyRouter!);
  const initialLaunchC = await viem.getContractAt("TCGVaultInitialLaunch", initialLaunch!);
  const founderNftC = await viem.getContractAt("TCGVaultFounderNFT", founderNft!);
  const converterC = await viem.getContractAt("TCGRToTCGVConverter", tcgrConverter!);

  const pancakeRouter =
    optionalEnvAddress("PANCAKE_ROUTER") ?? ((await buyRouterC.read.router()) as Address);
  const usdc =
    optionalEnvAddress("USDC_ADDRESS") ??
    optionalEnvAddress("STABLECOIN_ADDRESS") ??
    ((await buyRouterC.read.usdc()) as Address);
  const vault =
    optionalEnvAddress("VAULT_ADDRESS") ?? ((await buyRouterC.read.vault()) as Address);
  const marketing =
    optionalEnvAddress("MARKETING_ADDRESS") ?? ((await buyRouterC.read.marketing()) as Address);
  const community =
    optionalEnvAddress("COMMUNITY_ADDRESS") ?? ((await buyRouterC.read.community()) as Address);

  const treasury =
    optionalEnvAddress("TREASURY_ADDRESS") ?? ((await initialLaunchC.read.treasury()) as Address);
  const caspUsdc =
    optionalEnvAddress("CASP_USDC_ADDRESS") ??
    ((await founderNftC.read.caspUsdcRecipient()) as Address);

  const ratioWei =
    process.env.TCGR_RATIO_WEI?.trim()
      ? BigInt(process.env.TCGR_RATIO_WEI.trim())
      : ((await converterC.read.ratio()) as bigint);

  const tokenC = await viem.getContractAt("TCGVaultToken", tcgv!);
  const tokenBuyRouter = (await tokenC.read.buyRouter()) as Address;
  if (tokenBuyRouter.toLowerCase() !== buyRouter!.toLowerCase()) {
    console.warn(
      `Warning: TCGVaultToken.buyRouter()=${tokenBuyRouter} does not match subgraph BuyRouter=${buyRouter}`,
    );
  }

  console.log("BuyRouter address (subgraph):", buyRouter);
  console.log("BuyRouter constructor args (from on-chain immutables):");
  console.log({
    pancakeRouter,
    usdc,
    tcgv: tcgv!,
    vault,
    marketing,
    community,
  });
  console.log(
    "(Same order as deployBscTestnet.ts: PANCAKE_ROUTER, USDC, TCGV, VAULT, MARKETING, COMMUNITY)\n",
  );

  const jobs: VerifyJob[] = [
    {
      name: "TCGNexusToken",
      address: nexus!,
      contract: "contracts/TCGNexusToken.sol:TCGNexusToken",
      constructorArguments: [tcgv!, founderNft!, initialLaunch!],
    },
    {
      name: "TCGVaultToken",
      address: tcgv!,
      // Let Hardhat auto-match artifact by bytecode (this address can be from another commit).
      constructorArguments: [
        zeroAddress,
        pancakeRouter,
        vault,
        marketing,
        community,
        nexus!,
        initialLaunch!,
      ],
    },
    {
      name: "TCGVaultFounderNFT",
      address: founderNft!,
      contract: "contracts/TCGVaultFounderNFT.sol:TCGVaultFounderNFT",
      constructorArguments: [usdc, nexus!, caspUsdc],
    },
    {
      name: "TCGVaultInitialLaunch",
      address: initialLaunch!,
      contract: "contracts/TCGVaultInitialLaunch.sol:TCGVaultInitialLaunch",
      constructorArguments: [tcgv!, usdc, founderNft!, nexus!, treasury],
    },
    {
      name: "TCGVaultStakingVault",
      address: stakingVault!,
      // Let Hardhat auto-match artifact by bytecode.
      constructorArguments: [tcgv!],
    },
    {
      name: "TCGVaultBasicNFT",
      address: basicNft!,
      contract: "contracts/TCGVaultBasicNFT.sol:TCGVaultBasicNFT",
      constructorArguments: [stakingVault!],
    },
    {
      name: "TCGVaultBuyRouter",
      address: buyRouter!,
      // Let Hardhat auto-match artifact by bytecode.
      constructorArguments: [pancakeRouter, usdc, tcgv!, vault, marketing, community],
    },
    {
      name: "TCGVaultLiquidityWrapper",
      address: liquidityWrapper!,
      contract: "contracts/TCGVaultLiquidityWrapper.sol:TCGVaultLiquidityWrapper",
      constructorArguments: [tcgv!, pancakeRouter],
    },
    {
      name: "TCGRToken",
      address: tcgr!,
      contract: "contracts/TCGRToken.sol:TCGRToken",
      constructorArguments: [buyRouter!, usdc],
    },
    {
      name: "TCGRToTCGVConverter",
      address: tcgrConverter!,
      contract: "contracts/TCGRToTCGVConverter.sol:TCGRToTCGVConverter",
      constructorArguments: [tcgr!, tcgv!, ratioWei],
    },
  ];

  const waitSeconds = Number(process.env.VERIFY_WAIT_SECONDS ?? "0");
  if (waitSeconds > 0) {
    console.log(`Waiting ${waitSeconds}s before verification...`);
    await new Promise((r) => setTimeout(r, waitSeconds * 1000));
  }

  console.log(`Verifying ${jobs.length} contracts using manifest: ${subgraphPath}`);

  const publicClient = await viem.getPublicClient();
  for (const job of jobs) {
    const onChain = await publicClient.getBytecode({ address: job.address });
    if (!onChain || onChain === "0x") {
      console.warn(`Skip ${job.name}: no contract code at ${job.address} on this RPC`);
      continue;
    }
    await verifyOne(job);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});


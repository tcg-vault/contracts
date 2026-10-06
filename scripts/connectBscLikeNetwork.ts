/**
 * Connect Hardhat viem clients for live BSC (56) or Tenderly Virtual BSC (custom id).
 *
 * Tenderly Virtual TestNets often use a non-standard chainId (e.g. 99956).
 * hardhat-viem cannot resolve those from viem/chains, so we pass defineChain.
 */

import hre from "hardhat";
import { defineChain, type Chain } from "viem";

export const CHAIN_ID_BSC_MAINNET = 56n;

/** Default Tenderly Virtual BSC chain id for this project (override with TENDERLY_CHAIN_ID). */
export function tenderlyVirtualChainId(): bigint {
  const raw = process.env.TENDERLY_CHAIN_ID?.trim();
  return raw ? BigInt(raw) : 99956n;
}

export function isAllowedBscDeployChainId(chainId: bigint): boolean {
  return chainId === CHAIN_ID_BSC_MAINNET || chainId === tenderlyVirtualChainId();
}

function bscLikeChain(chainId: number): Chain {
  const isLive = chainId === Number(CHAIN_ID_BSC_MAINNET);
  return defineChain({
    id: chainId,
    name: isLive ? "BNB Smart Chain" : `Tenderly Virtual BSC (${chainId})`,
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: {
      default: {
        http: [
          (isLive ? process.env.BSC_RPC_URL : process.env.TENDERLY_RPC_URL)?.trim() ||
            "http://127.0.0.1",
        ],
      },
    },
  });
}

export async function connectBscLikeDeployNetwork() {
  const connection = await hre.network.connect();
  const { viem } = connection;

  const chainIdHex = (await connection.provider.request({
    method: "eth_chainId",
  })) as string;
  const chainIdNum = Number(chainIdHex);
  const chain = bscLikeChain(chainIdNum);

  const publicClient = await viem.getPublicClient({ chain });
  const walletClients = await viem.getWalletClients({ chain });
  const deployer = walletClients[0];
  if (!deployer) {
    throw new Error("No deployer wallet available for this network (check TCG_KEY).");
  }

  return {
    viem,
    connection,
    chain,
    chainId: BigInt(chainIdNum),
    publicClient,
    deployer,
    isTenderlyVirtual: BigInt(chainIdNum) === tenderlyVirtualChainId(),
  };
}

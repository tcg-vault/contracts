import { configVariable, defineConfig } from "hardhat/config";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatViemAssertions from "@nomicfoundation/hardhat-viem-assertions";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

export default defineConfig({
  // Coverage: run `yarn coverage` (uses this config + --coverage; reports in coverage/ as lcov & HTML).
  // Hardhat 3.1.10 instruments all sources; scripts/run-coverage.mjs then drops contracts/test from the report.
  plugins: [
    hardhatViem,
    hardhatViemAssertions,
    hardhatNodeTestRunner,
    hardhatNetworkHelpers,
    hardhatVerify,
  ],
  solidity: {
    // Coverage injects a library with pragma >=0.4.22; avoid 0.4.18 so it is not selected (use COVERAGE=1 + exclude WBNB).
    compilers: process.env.COVERAGE
      ? [
          // Optimizer off so coverage is not collapsed by inlining (e.g. maxDeposit/maxWithdraw `return 0`).
          { version: "0.8.27", settings: { optimizer: { enabled: false }, evmVersion: "cancun" as const } },
          { version: "0.6.6", settings: { optimizer: { enabled: true } } },
          { version: "0.5.16", settings: { optimizer: { enabled: true } } },
        ]
      : [
          { version: "0.8.27", settings: { optimizer: { enabled: true }, evmVersion: "cancun" as const } },
          { version: "0.6.6", settings: { optimizer: { enabled: true } } },
          { version: "0.5.16", settings: { optimizer: { enabled: true } } },
          { version: "0.4.18", settings: { optimizer: { enabled: true } } },
        ],
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
      forking: process.env.BSC_RPC_URL
        ? { url: process.env.BSC_RPC_URL, blockNumber: undefined }
        : undefined,
    },
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://localhost:8545",
      chainId: 56,
      // Use Anvil's rich default account as deployer, and a dedicated
      // EOA (no 7702 delegation code) as the trader/buyer.
      accounts: [
        // Anvil default account(0): 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        // Custom trader key provided for tests (no funds by default; script funds it from deployer).
        "0x5a21e32ae37de592bb8187ae8b3788be2af7d50376607c05c2d4e47211acd1fe",
      ],
    },
    mainnet: {
      type: "http",
      chainType: "l1",
      url: configVariable("MAINNET_RPC_URL"),
      chainId: 1,
      accounts: [configVariable("TCG_KEY")],
    },
    holesky: {
      type: "http",
      chainType: "l1",
      url: configVariable("HOLESKY_RPC_URL"),
      chainId: 17000,
      accounts: [configVariable("TCG_KEY")],
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      gasPrice: "auto",
      accounts: [configVariable("TCG_KEY")],
    },
    gnosis: {
      type: "http",
      chainType: "l1",
      url: configVariable("GNOSIS_RPC_URL"),
      chainId: 100,
      gasPrice: "auto",
      accounts: [configVariable("TCG_KEY")],
    },
    sokol: {
      type: "http",
      chainType: "l1",
      url: configVariable("SOKOL_RPC_URL"),
      chainId: 77,
      gasPrice: "auto",
      accounts: [configVariable("TCG_KEY")],
    },
    bsc: {
      type: "http",
      chainType: "l1",
      url: configVariable("BSC_RPC_URL"),
      chainId: 56,
      gasPrice: "auto",
      accounts: [configVariable("TCG_KEY")],
    },
    bsctest: {
      type: "http",
      chainType: "l1",
      url: configVariable("BSCTEST_RPC_URL"),
      chainId: 97,
      // Many BSC testnet RPCs return a low eth_gasPrice; the mempool then rejects with
      // "transaction underpriced". Use a sane floor (11 gwei) or set BSCTEST_GAS_PRICE_WEI in .env.
      gasPrice: process.env.BSCTEST_GAS_PRICE_WEI?.trim()
        ? BigInt(process.env.BSCTEST_GAS_PRICE_WEI.trim())
        : 11_000_000_000n,
      gasMultiplier: 1.15,
      accounts: [configVariable("TCG_KEY")],
    },
    tenderly: {
      type: "http",
      chainType: "l1",
      url: configVariable("TENDERLY_RPC_URL"),
      chainId: 1,
      gasPrice: "auto",
      accounts: [configVariable("TCG_KEY")],
    },
    arbitrum: {
      type: "http",
      chainType: "l1",
      url: configVariable("ARBITRUM_RPC_URL"),
      chainId: 42161,
      gasPrice: "auto",
      accounts: [configVariable("TCG_KEY")],
    },
    arbitrumsepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("ARBITRUM_SEPOLIA_RPC_URL"),
      chainId: 421614,
      gasPrice: "auto",
      accounts: [configVariable("TCG_KEY")],
    },
  },
  verify: {
    etherscan: {
      apiKey: process.env.BSC_SCAN_API_KEY ?? "",
    },
    blockscout: {
      enabled: false,
    },
  },
});

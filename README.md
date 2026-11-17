<p align="center">
  <img src="./assets/tcgv-128.png" width="80" height="80" alt="TCGV token logo">
</p>

# TCG-VAULT Smart Contracts

Solidity contracts for TCG-VAULT, an ecosystem for physical trading card games on BNB Smart Chain. They power the TCGV token, the Founder NFT sale and token presale, swaps, staking-based membership, and referral rewards.

[Official website](https://www.tcg-vault.io/en) · [White paper](https://www.tcg-vault.io/en/documents/whitepaper) · [Technical documentation](docs/README.md)

## 📍 Contract addresses

### BNB Smart Chain Mainnet

Chain ID **56** · Indexing start block [`126141159`](https://bscscan.com/block/126141159)

| Contract | Address |
| --- | --- |
| TCGV token | [`0xA9e2cCE103B171a9fE0F10F7C5Ca307368071301`](https://bscscan.com/address/0xA9e2cCE103B171a9fE0F10F7C5Ca307368071301) |
| NEXUS token | [`0x99272D120C0b0b91b09475941d521E59447D4eB1`](https://bscscan.com/address/0x99272D120C0b0b91b09475941d521E59447D4eB1) |
| TCGR referral token | [`0xb9265b3104403662f26ccb0476b54db777fc5089`](https://bscscan.com/address/0xb9265b3104403662f26ccb0476b54db777fc5089) |
| Founder NFT | [`0xA791B93157fD62b68fAcd7a4785F27F2E8C53Bb3`](https://bscscan.com/address/0xA791B93157fD62b68fAcd7a4785F27F2E8C53Bb3) |
| Basic NFT | [`0x18722dcaa6a227ac681dfd92b86e5ee4b6423cd9`](https://bscscan.com/address/0x18722dcaa6a227ac681dfd92b86e5ee4b6423cd9) |
| Initial Launch (presale) | [`0xb71732c9a8C1258be650cB2B2ac414aeB5757bcE`](https://bscscan.com/address/0xb71732c9a8C1258be650cB2B2ac414aeB5757bcE) |
| Staking Vault | [`0x93f3e6c3e235469ef0c0fc8ddef5e1335c8d1be6`](https://bscscan.com/address/0x93f3e6c3e235469ef0c0fc8ddef5e1335c8d1be6) |
| Buy Router | [`0x6c18E8f5f7994aCB0576AD701A45c342591B56E1`](https://bscscan.com/address/0x6c18E8f5f7994aCB0576AD701A45c342591B56E1) |
| Liquidity Wrapper | [`0xc24b33d7c3802227e3c81c7dcf8d4122ddfc0663`](https://bscscan.com/address/0xc24b33d7c3802227e3c81c7dcf8d4122ddfc0663) |
| TCGR → TCGV Converter | [`0xa6ee230b1dff349f15d7f2d1809f883612042534`](https://bscscan.com/address/0xa6ee230b1dff349f15d7f2d1809f883612042534) |
| Binance-Peg USDC (18 decimals) | [`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`](https://bscscan.com/address/0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d) |
| PancakeSwap V2 Factory | [`0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73`](https://bscscan.com/address/0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73) |
| PancakeSwap V2 Router | [`0x10ED43C718714eb63d5aA57B78B54704E256024E`](https://bscscan.com/address/0x10ED43C718714eb63d5aA57B78B54704E256024E) |

### BNB Smart Chain Testnet (Chapel)

Chain ID **97** · Indexing start block [`140266602`](https://testnet.bscscan.com/block/140266602)

| Contract | Address |
| --- | --- |
| TCGV token | [`0xeD20C8E7550E656829b0C18e1202e72094d103d2`](https://testnet.bscscan.com/address/0xeD20C8E7550E656829b0C18e1202e72094d103d2) |
| NEXUS token | [`0x8314E5Db499d558B3c0c5d781D0b32aBdA993F1a`](https://testnet.bscscan.com/address/0x8314E5Db499d558B3c0c5d781D0b32aBdA993F1a) |
| TCGR referral token | [`0x41AbebF2a996b0Ba2107A5d695C1C5BB39Bcf315`](https://testnet.bscscan.com/address/0x41AbebF2a996b0Ba2107A5d695C1C5BB39Bcf315) |
| Founder NFT | [`0xC2E0C660847af437b277Ac8f246aFf5985f9980F`](https://testnet.bscscan.com/address/0xC2E0C660847af437b277Ac8f246aFf5985f9980F) |
| Basic NFT | [`0xf6079745Be57782EB341afB2984C6ce57FaBf27c`](https://testnet.bscscan.com/address/0xf6079745Be57782EB341afB2984C6ce57FaBf27c) |
| Initial Launch (presale) | [`0xc12779f6e9D77EE83D9379974DaeEDd6872D1261`](https://testnet.bscscan.com/address/0xc12779f6e9D77EE83D9379974DaeEDd6872D1261) |
| Staking Vault | [`0x9d5A75640a6ab059b3478c00EC041bb73FB7A431`](https://testnet.bscscan.com/address/0x9d5A75640a6ab059b3478c00EC041bb73FB7A431) |
| Buy Router | [`0x49dB50A0CF1059Ddf3F93317Cfc465831071D6FB`](https://testnet.bscscan.com/address/0x49dB50A0CF1059Ddf3F93317Cfc465831071D6FB) |
| Liquidity Wrapper | [`0xe9F9ED3F7A4D0087CFc3767D8A9AEC9CdccC076e`](https://testnet.bscscan.com/address/0xe9F9ED3F7A4D0087CFc3767D8A9AEC9CdccC076e) |
| TCGR → TCGV Converter | [`0x6F3991A152B721cf762F835fa6B2490239f44840`](https://testnet.bscscan.com/address/0x6F3991A152B721cf762F835fa6B2490239f44840) |
| Mock USDC (6 decimals) | [`0x7a92Ee5771893f6A196E87e97aEa0A59CecA2ACC`](https://testnet.bscscan.com/address/0x7a92Ee5771893f6A196E87e97aEa0A59CecA2ACC) |
| PancakeSwap V2 Factory | [`0x6725F303b657a9451d8BA641348b6761A6CC7a17`](https://testnet.bscscan.com/address/0x6725F303b657a9451d8BA641348b6761A6CC7a17) |
| PancakeSwap V2 Router | [`0xD99D1c33F9fC3444f8101754aBC46c52416550D1`](https://testnet.bscscan.com/address/0xD99D1c33F9fC3444f8101754aBC46c52416550D1) |

The mainnet integration reference includes fee recipients, NFT metadata, and staking configuration. [Mainnet integration reference](docs/FRONTEND_ADDRESSES.md#production--bsc-mainnet)

## 🧩 How the contracts fit together

| Area | Contracts and responsibilities |
| --- | --- |
| Tokens and rewards | [`TCGVaultToken`](contracts/TCGVaultToken.sol) is the BEP-20 utility token. [`TCGNexusToken`](contracts/TCGNexusToken.sol) is the non-transferable governance and cashback token. [`TCGRToken`](contracts/TCGRToken.sol) tracks non-transferable referral rewards. The [converter](contracts/TCGRToTCGVConverter.sol) exchanges unlocked TCGR for TCGV. |
| Launch and membership | [`TCGVaultFounderNFT`](contracts/TCGVaultFounderNFT.sol) runs the Founder NFT sale. [`TCGVaultInitialLaunch`](contracts/TCGVaultInitialLaunch.sol) records TCGV presale allocations and handles vesting claims. The [staking vault](contracts/TCGVaultStakingVault.sol) holds TCGV deposits and manages eligibility for the non-transferable [Basic NFT](contracts/TCGVaultBasicNFT.sol). |
| Trading and liquidity | [`TCGVaultBuyRouter`](contracts/TCGVaultBuyRouter.sol) routes TCGV/USDC swaps. [`TCGVaultLiquidityWrapper`](contracts/TCGVaultLiquidityWrapper.sol) handles adding and removing liquidity through approved DEX routers. |

Founder NFT and presale payments go directly to their configured custody recipients. On-chain cancellations emit refund-due events for off-chain settlement. [Product lifecycle and refund flow](docs/PRODUCT_LIFECYCLE.md)

## 💱 Trading fees

| Trading path | Fee asset | Default buy fee | Default sell fee |
| --- | --- | ---: | ---: |
| TCG-VAULT Buy Router | USDC | 5% of input | 4% of output |
| Direct swaps through a registered pool | TCGV | 6% of TCGV bought | 5% of TCGV sold |

Authorized administrators can change fee rates up to the hard-coded ceilings, which match the defaults above. The issuer has made a contractual commitment to keep fee rates from rising. Read the deployed fee parameters for quotes and integrations. [On-chain fee reference](docs/FEE_REFERENCE.md) · [Terms of Use](https://www.tcg-vault.io/en/documents/terms-of-use)

The Buy Router is exempt from the token’s pool fees. Eligible buys through the router mint NEXUS cashback. Fees go to configured recipients and liquidity allocations, depending on the trading path. [Fee splits and cashback rules](docs/FEE_REFERENCE.md)

## 🛡️ Security review

Hacken published its final smart contract security assessment on **24 September 2026**, covering commit [`dd5b374`](https://github.com/tcg-vault/contracts/tree/dd5b3747d8f546ee0f0a6adeedf42f5bd5935edd). The report records 35 findings, with 32 resolved, two accepted, and one mitigated. [Hacken final report](https://hacken.io/audits/tcg-vault/sca-tcg-vault-vault-token-apr2026/)

## 🛠️ Build and test locally

Use **Node.js 22 LTS (22.10 or newer)** and **Yarn 4.5.1**. Run these commands from the repository root.

```sh
yarn install --immutable
yarn build
yarn test
```

The project uses Hardhat 3 and Solidity 0.8.27 for the protocol contracts. Builds and local tests require no deployment credentials. [Mainnet deployment runbook](docs/MAINNET_DEPLOYMENT.md) · [BSC fork testing guide](scripts/README_BSC_FORK.md)

## 📄 License

[MIT](LICENSE)

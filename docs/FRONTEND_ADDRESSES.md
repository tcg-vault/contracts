# TCG-VAULT — Frontend network addresses

Complete reference for **BSC mainnet (prod)** and **BSC testnet (chapel)**.

## Subgraphs (Goldsky)

| Network | GraphQL endpoint |
|---|---|
| **Prod (BSC mainnet)** | https://api.goldsky.com/api/public/project_cmmy4l6c3g8oy01t5berz7ioa/subgraphs/tcg-vault/prod/gn |
| **Testnet (chapel)** | https://api.goldsky.com/api/public/project_cmmy4l6c3g8oy01t5berz7ioa/subgraphs/tcg-vault/testnet/gn |

---

## Production — BSC mainnet

| | |
|---|---|
| **Network** | BSC |
| **Chain ID** | `56` |
| **Explorer** | https://bscscan.com |
| **Deploy cache** | `contracts/.cache/last-bsc-mainnet-deploy-full.json` |
| **Start block** | `126141159` |

### Core contracts

| Contract | Address |
|---|---|
| TCGV | `0xA9e2cCE103B171a9fE0F10F7C5Ca307368071301` |
| NEXUS | `0x99272D120C0b0b91b09475941d521E59447D4eB1` |
| USDC (Binance-Peg, 18 decimals) | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` |
| BuyRouter | `0x6c18E8f5f7994aCB0576AD701A45c342591B56E1` |
| StakingVault | `0x93f3e6c3e235469ef0c0fc8ddef5e1335c8d1be6` |
| Founder NFT | `0xA791B93157fD62b68fAcd7a4785F27F2E8C53Bb3` |
| Basic NFT | `0x18722dcaa6a227ac681dfd92b86e5ee4b6423cd9` |
| Initial Launch | `0xb71732c9a8C1258be650cB2B2ac414aeB5757bcE` |
| Liquidity Wrapper | `0xc24b33d7c3802227e3c81c7dcf8d4122ddfc0663` |
| TCGR | `0xb9265b3104403662f26ccb0476b54db777fc5089` |
| TCGR Converter | `0xa6ee230b1dff349f15d7f2d1809f883612042534` |

### PancakeSwap V2 (mainnet)

| | Address |
|---|---|
| Factory | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` |
| Router | `0x10ED43C718714eb63d5aA57B78B54704E256024E` |

### Protocol wallets (mainnet)

| Role | Address |
|---|---|
| Vault (fee recipient) | `0xF71E94507Aeb70eab40FccA845bace37db2609F7` |
| Marketing | `0xe611d9C15D493700D32357cC7402d814Ae50f241` |
| Community | `0xdF93bB41B17F0884c356C27521C08fc4C735f5c3` |
| CASP USDC / Treasury | `0xAda4a1cC0B8C5500be84a124413D356600992498` |
| Liquidity recipient | `0xC0C7A4aF7256c58E0eAe6126D670F327002d8EbD` |
| Team recipient | `0x056417581709F8A8A21463Ab5A3a7C33E23e2042` |
| Ops recipient | `0xe611d9C15D493700D32357cC7402d814Ae50f241` |

### NFT metadata (`baseURI`)

| NFT | `setBaseURI` value |
|---|---|
| Founder | `ipfs://bafybeihc5paec3djiq5bwqcjqzpl4n6yltrs3qjyfq26lo6hprvt4mlbwa/founder/` |
| Basic | `https://metadata.tcg-vault.io/basic/` |

Resolved examples (after a token is minted):

- Founder `tokenURI(0)` → `ipfs://bafybeihc5paec3djiq5bwqcjqzpl4n6yltrs3qjyfq26lo6hprvt4mlbwa/founder/0` → **Founder #0**
- Basic `tokenURI(0)` → `https://metadata.tcg-vault.io/basic/0` → **Basique #0**

> Display `#N` / trait `Numéro` match on-chain `tokenId` (including `0`).  
> `tokenURI` reverts until that `tokenId` exists (OpenZeppelin ERC-721).

### Basic NFT stake threshold

| | |
|---|---|
| `basicNftMinStakeWei` | `5000000000000000000000` (5000 TCGV, 18 decimals) |

---

## Testnet — BSC chapel

| | |
|---|---|
| **Network** | BSC Testnet (chapel) |
| **Chain ID** | `97` |
| **Explorer** | https://testnet.bscscan.com |
| **Deploy cache** | `contracts/.cache/last-bsctest-deploy.json` |
| **Start block** | `132622896` |

### Core contracts

| Contract | Address |
|---|---|
| TCGV | `0x99752e2282bf24f6Eb02f31aD690D956F62f35AE` |
| NEXUS | `0x57082Dfbf81447a8052340Fe5C0815a8ACBEF44e` |
| USDC (mock) | `0x5aD64762b69a1b20d28B3F49C75e542F30F4edC2` |
| BuyRouter | `0x15C70fE86a2D6ed692078D589Ccf00444C787626` |
| StakingVault | `0xDEBA0199f7df33cC63379A5a3033FC97353e7e50` |
| Founder NFT | `0x4EcbF40C843F6Fb416F59BE0a2476Cd2B7bd1C16` |
| Basic NFT | `0x68d542FEe765E861Df2E74Fe74049d2C92454701` |
| Initial Launch | `0x2F48Ac385Ed87Aeb0BafdbE4Deb5688f215e3452` |
| Liquidity Wrapper | `0x97A78F6869B1Ed992B8B131519e647074B6CB8f5` |
| TCGR | `0x0Ad4DDf35cbf9dd4D9eD3A8Ca62C53F34eF49847` |
| TCGR Converter | `0x8E5c4A7E31A6748fbA6897a36697827B002cB477` |

### PancakeSwap V2 (testnet)

| | Address |
|---|---|
| Factory | `0x6725F303b657a9451d8BA641348b6761A6CC7a17` |
| Router | `0xD99D1c33F9fC3444f8101754aBC46c52416550D1` |

### NFT metadata (`baseURI`)

Same as prod:

| NFT | `setBaseURI` value |
|---|---|
| Founder | `ipfs://bafybeihc5paec3djiq5bwqcjqzpl4n6yltrs3qjyfq26lo6hprvt4mlbwa/founder/` |
| Basic | `https://metadata.tcg-vault.io/basic/` |

---

## Quick JSON (both networks)

```json
{
  "subgraphs": {
    "prod": "https://api.goldsky.com/api/public/project_cmmy4l6c3g8oy01t5berz7ioa/subgraphs/tcg-vault/prod/gn",
    "testnet": "https://api.goldsky.com/api/public/project_cmmy4l6c3g8oy01t5berz7ioa/subgraphs/tcg-vault/testnet/gn"
  },
  "metadata": {
    "founderBaseURI": "ipfs://bafybeihc5paec3djiq5bwqcjqzpl4n6yltrs3qjyfq26lo6hprvt4mlbwa/founder/",
    "basicBaseURI": "https://metadata.tcg-vault.io/basic/"
  },
  "prod": {
    "chainId": 56,
    "network": "bsc",
    "startBlock": 126141159,
    "explorer": "https://bscscan.com",
    "addresses": {
      "tcgv": "0xA9e2cCE103B171a9fE0F10F7C5Ca307368071301",
      "nexus": "0x99272D120C0b0b91b09475941d521E59447D4eB1",
      "usdc": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      "buyRouter": "0x6c18E8f5f7994aCB0576AD701A45c342591B56E1",
      "stakingVault": "0x93f3e6c3e235469ef0c0fc8ddef5e1335c8d1be6",
      "founderNFT": "0xA791B93157fD62b68fAcd7a4785F27F2E8C53Bb3",
      "basicNFT": "0x18722dcaa6a227ac681dfd92b86e5ee4b6423cd9",
      "initialLaunch": "0xb71732c9a8C1258be650cB2B2ac414aeB5757bcE",
      "liquidityWrapper": "0xc24b33d7c3802227e3c81c7dcf8d4122ddfc0663",
      "tcgr": "0xb9265b3104403662f26ccb0476b54db777fc5089",
      "tcgrConverter": "0xa6ee230b1dff349f15d7f2d1809f883612042534",
      "pancakeFactory": "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
      "pancakeRouter": "0x10ED43C718714eb63d5aA57B78B54704E256024E",
      "vault": "0xF71E94507Aeb70eab40FccA845bace37db2609F7",
      "marketing": "0xe611d9C15D493700D32357cC7402d814Ae50f241",
      "community": "0xdF93bB41B17F0884c356C27521C08fc4C735f5c3",
      "caspUsdc": "0xAda4a1cC0B8C5500be84a124413D356600992498",
      "treasury": "0xAda4a1cC0B8C5500be84a124413D356600992498",
      "liquidityRecipient": "0xC0C7A4aF7256c58E0eAe6126D670F327002d8EbD",
      "teamRecipient": "0x056417581709F8A8A21463Ab5A3a7C33E23e2042",
      "opsRecipient": "0xe611d9C15D493700D32357cC7402d814Ae50f241"
    },
    "basicNftMinStakeWei": "5000000000000000000000"
  },
  "testnet": {
    "chainId": 97,
    "network": "chapel",
    "startBlock": 132622896,
    "explorer": "https://testnet.bscscan.com",
    "addresses": {
      "tcgv": "0x99752e2282bf24f6Eb02f31aD690D956F62f35AE",
      "nexus": "0x57082Dfbf81447a8052340Fe5C0815a8ACBEF44e",
      "usdc": "0x5aD64762b69a1b20d28B3F49C75e542F30F4edC2",
      "buyRouter": "0x15C70fE86a2D6ed692078D589Ccf00444C787626",
      "stakingVault": "0xDEBA0199f7df33cC63379A5a3033FC97353e7e50",
      "founderNFT": "0x4EcbF40C843F6Fb416F59BE0a2476Cd2B7bd1C16",
      "basicNFT": "0x68d542FEe765E861Df2E74Fe74049d2C92454701",
      "initialLaunch": "0x2F48Ac385Ed87Aeb0BafdbE4Deb5688f215e3452",
      "liquidityWrapper": "0x97A78F6869B1Ed992B8B131519e647074B6CB8f5",
      "tcgr": "0x0Ad4DDf35cbf9dd4D9eD3A8Ca62C53F34eF49847",
      "tcgrConverter": "0x8E5c4A7E31A6748fbA6897a36697827B002cB477",
      "pancakeFactory": "0x6725F303b657a9451d8BA641348b6761A6CC7a17",
      "pancakeRouter": "0xD99D1c33F9fC3444f8101754aBC46c52416550D1"
    }
  }
}
```

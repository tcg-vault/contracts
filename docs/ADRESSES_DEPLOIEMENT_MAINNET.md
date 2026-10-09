# Adresses nécessaires — déploiement mainnet BSC (TCG Vault)

Wallets ops **rotés** (oct. 2026).  
Décision ops : `OPS_RECIPIENT` = **Structure & Marketing** (5 % immédiat + 11 % vesting).

Stablecoin figé : Binance-Peg USDC  
`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` (18 décimales).

Pas d’adresse « burn » à fournir (géré on-chain via `address(0)`).

Contrats déjà déployés (BSC) : voir `.cache/last-bsc-mainnet-deploy-full.json`.  
Migration wallets : redeploy **BuyRouter seul** + setters (`setAddresses`, `setCaspUsdcRecipient`, `setTreasury`, `setAllocationRecipients`) — pas de full redeploy.

---

## 1. Wallets ops (courants)

| Label | Adresse |
|-------|---------|
| Coffre Communautaire en transit | `0xF71E94507Aeb70eab40FccA845bace37db2609F7` |
| Structure & Marketing | `0xe611d9C15D493700D32357cC7402d814Ae50f241` |
| Récompenses Communautaires | `0xdF93bB41B17F0884c356C27521C08fc4C735f5c3` |
| Liquidité | `0xC0C7A4aF7256c58E0eAe6126D670F327002d8EbD` |
| LP/Tokens | `0x81BdE116c685bC342585d382729C0465AB8C1594` |
| Équipe Fondatrice | `0x056417581709F8A8A21463Ab5A3a7C33E23e2042` |
| Prévente (CASP) | `0xAda4a1cC0B8C5500be84a124413D356600992498` |
| Prévente (CASP post-libération) | `0x2995715C5Ea51FFfEaE1AF7d74a68d12F02C529c` |
| Réserve Stratégique (5 % tokens) | `0x4F4EDA82D4cd73c7aa9f3602319239BDfe53F481` |
| Réserve de Structuration (70k) | `0x34Fbc9bd41047a99E0F3D89b19c95BD137B19E81` |

---

## 2. Mapping tokenomics → contrats

Répartition supply (G.5) : **60 % prévente / 20 % liquidité / 11 % structure & marketing / 5 % réserve stratégique / 4 % équipe fondatrice**.

On-chain : **60 % / 20 % / 4 % team / 5 % ops direct + 11 % ops vesting**.

| Livre blanc | % | Rôle contrat | Variable `.env` | Adresse |
|-------------|---|--------------|-----------------|---------|
| Liquidité | 20 % | Liquidité | `LIQUIDITY_RECIPIENT` | `0xC0C7A4aF7256c58E0eAe6126D670F327002d8EbD` |
| Équipe fondatrice | 4 % | Team | `TEAM_RECIPIENT` | `0x056417581709F8A8A21463Ab5A3a7C33E23e2042` |
| Réserve stratégique + Structure & marketing | 5 % + 11 % | Ops | `OPS_RECIPIENT` | `0xe611d9C15D493700D32357cC7402d814Ae50f241` |

> Les 5 % + 11 % partent vers **Structure & Marketing**. Redistribution vers Réserve Stratégique = ops off-chain.

---

## 3. Mapping vers les 8 rôles `.env` — **figé**

| # | Rôle contrat | Variable `.env` | Adresse | Source |
|---|--------------|-----------------|---------|--------|
| 1 | Vault communautaire (frais) | `VAULT_ADDRESS` | `0xF71E94507Aeb70eab40FccA845bace37db2609F7` | Coffre Communautaire en transit |
| 2 | Marketing & Structure (frais) | `MARKETING_ADDRESS` | `0xe611d9C15D493700D32357cC7402d814Ae50f241` | Structure & Marketing |
| 3 | Récompenses communautaires (frais) | `COMMUNITY_ADDRESS` | `0xdF93bB41B17F0884c356C27521C08fc4C735f5c3` | Récompenses Communautaires |
| 4 | CASP USDC (Founder) | `CASP_USDC_ADDRESS` | `0xAda4a1cC0B8C5500be84a124413D356600992498` | Prévente (CASP) — inchangé on-chain |
| 5 | Trésorerie Initial Launch | `TREASURY_ADDRESS` | `0xAda4a1cC0B8C5500be84a124413D356600992498` | Même CASP |
| 6 | Liquidité | `LIQUIDITY_RECIPIENT` | `0xC0C7A4aF7256c58E0eAe6126D670F327002d8EbD` | Liquidité |
| 7 | Équipe fondatrice | `TEAM_RECIPIENT` | `0x056417581709F8A8A21463Ab5A3a7C33E23e2042` | Équipe Fondatrice |
| 8 | Ops (5 % + 11 %) | `OPS_RECIPIENT` | `0xe611d9C15D493700D32357cC7402d814Ae50f241` | Structure & Marketing |

**Note :** `#2` et `#8` = même safe.

---

## 4. Bloc `.env`

```env
VAULT_ADDRESS="0xF71E94507Aeb70eab40FccA845bace37db2609F7"
MARKETING_ADDRESS="0xe611d9C15D493700D32357cC7402d814Ae50f241"
COMMUNITY_ADDRESS="0xdF93bB41B17F0884c356C27521C08fc4C735f5c3"
CASP_USDC_ADDRESS="0xAda4a1cC0B8C5500be84a124413D356600992498"
TREASURY_ADDRESS="0xAda4a1cC0B8C5500be84a124413D356600992498"
LIQUIDITY_RECIPIENT="0xC0C7A4aF7256c58E0eAe6126D670F327002d8EbD"
TEAM_RECIPIENT="0x056417581709F8A8A21463Ab5A3a7C33E23e2042"
OPS_RECIPIENT="0xe611d9C15D493700D32357cC7402d814Ae50f241"
USDC_ADDRESS="0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
```

Hors des 8 slots :
- LP/Tokens `0x81BdE116c685bC342585d382729C0465AB8C1594`
- Réserve de Structuration `0x34Fbc9bd41047a99E0F3D89b19c95BD137B19E81`
- Réserve Stratégique `0x4F4EDA82D4cd73c7aa9f3602319239BDfe53F481` (réallocation ops off-chain si besoin)

---

## 5. Migration on-chain (sans full redeploy)

Prérequis : `supplyRecomputed == false` (pas encore `finalize`).

1. Deploy nouveau `TCGVaultBuyRouter` (vault/marketing/community immutables)
2. `token.setBuyRouter(newRouter)`
3. `stakingVault.setBasicNFTPricingRouter(newRouter)`
4. `token.setAddresses(vault, marketing, community)`
5. `founderNFT.setCaspUsdcRecipient(casp)`
6. `initialLaunch.setTreasury(treasury)`
7. `token.setAllocationRecipients(liquidity, team, ops)`
8. Verify nouveau BuyRouter sur BscScan ; maj frontend

---

## 6. Rappel rôles

| # | Rôle | Quand |
|---|------|-------|
| 1–3 | Frais vault / marketing / community | Continu (trading) |
| 4–5 | USDC Founder + prévente → CASP | Pendant / après prévente |
| 6–8 | Liquidité / team / ops | Au `finalize` (fin prévente / TGE) |

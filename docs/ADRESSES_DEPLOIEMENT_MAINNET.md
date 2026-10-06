# Adresses nécessaires — déploiement mainnet BSC (TCG Vault)

Source wallets : **Livre Blanc MiCA v1.3.18** — Annexe 2 (2 oct. 2026).  
Décision ops : `OPS_RECIPIENT` = **Structure & Marketing** (5 % immédiat + 11 % vesting).

Stablecoin figé : Binance-Peg USDC  
`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` (18 décimales).

Pas d’adresse « burn » à fournir (géré on-chain via `address(0)`).

---

## 1. Wallets livre blanc (Annexe 2)

| Label | Adresse |
|-------|---------|
| Coffre Communautaire en transit (USDC + $TCGV) | `0x0c25b43363317B81d1F989b87776B772279364aa` |
| Structure & Marketing | `0xF189f0cEe29116B334F4B99466F4EC839eC57C42` |
| Liquidité | `0xdE7632E9071579976f3C33aCc3072De49a4554c2` |
| LP/Tokens | `0x44F36c7304dEd310A6F7e231A70803453eDDa455` |
| Récompenses Communautaires | `0xC01748415A5dBf19174E31d667795B41c2A7b2DD` |
| Réserve de Structuration | `0xAb31d8F895676ce570adf900Db59b5F107680C81` |
| Réserve Stratégique | `0xa3922236F7788dcE164321b117f95E5238931a44` |
| Prévente (CASP) | `0xAda4a1cC0B8C5500be84a124413D356600992498` |
| Prévente (post-libération CASP) | `0x1944E2EebbB7013BEc62128202976892d888a5D3` |
| Équipe Fondatrice | `0xEC8220c64a8Ac3d33230864965a1266B478b8fd6` |

---

## 2. Mapping tokenomics livre blanc → contrats

Répartition supply (G.5) : **60 % prévente / 20 % liquidité / 11 % structure & marketing / 5 % réserve stratégique / 4 % équipe fondatrice**.

On-chain (`TCGVaultToken`) : **60 % / 20 % / 4 % team / 5 % ops direct + 11 % ops vesting**.

| Livre blanc | % | Vesting LB | Rôle contrat | Variable `.env` | Adresse |
|-------------|---|------------|--------------|-----------------|---------|
| Liquidité | 20 % | — | Liquidité | `LIQUIDITY_RECIPIENT` | `0xdE7632E9071579976f3C33aCc3072De49a4554c2` |
| Équipe fondatrice | 4 % | cliff 12 + vest 24 | Team | `TEAM_RECIPIENT` | `0xEC8220c64a8Ac3d33230864965a1266B478b8fd6` |
| Réserve stratégique + Structure & marketing | 5 % + 11 % | immédiat + vest 36 mois | Ops | `OPS_RECIPIENT` | `0xF189f0cEe29116B334F4B99466F4EC839eC57C42` |

> Les 5 % + 11 % partent vers **une seule** adresse on-chain (Structure & Marketing). Redistribution éventuelle vers Réserve Stratégique = ops off-chain.

---

## 3. Mapping vers les 8 rôles `.env` — **figé**

| # | Rôle contrat | Variable `.env` | Adresse | Source |
|---|--------------|-----------------|---------|--------|
| 1 | Vault communautaire (frais) | `VAULT_ADDRESS` | `0x0c25b43363317B81d1F989b87776B772279364aa` | Coffre Communautaire en transit |
| 2 | Marketing & Structure (frais) | `MARKETING_ADDRESS` | `0xF189f0cEe29116B334F4B99466F4EC839eC57C42` | Structure & Marketing |
| 3 | Récompenses communautaires (frais) | `COMMUNITY_ADDRESS` | `0xC01748415A5dBf19174E31d667795B41c2A7b2DD` | Récompenses Communautaires |
| 4 | CASP USDC (Founder) | `CASP_USDC_ADDRESS` | `0xAda4a1cC0B8C5500be84a124413D356600992498` | Prévente (CASP) |
| 5 | Trésorerie Initial Launch | `TREASURY_ADDRESS` | `0xAda4a1cC0B8C5500be84a124413D356600992498` | Même CASP |
| 6 | Liquidité | `LIQUIDITY_RECIPIENT` | `0xdE7632E9071579976f3C33aCc3072De49a4554c2` | Liquidité |
| 7 | Équipe fondatrice | `TEAM_RECIPIENT` | `0xEC8220c64a8Ac3d33230864965a1266B478b8fd6` | Équipe Fondatrice |
| 8 | Ops (5 % + 11 %) | `OPS_RECIPIENT` | `0xF189f0cEe29116B334F4B99466F4EC839eC57C42` | Structure & Marketing |

**Note :** `#2` et `#8` = même safe (frais trading + allocation ops).

---

## 4. Bloc `.env` (prêt deploy)

```env
VAULT_ADDRESS="0x0c25b43363317B81d1F989b87776B772279364aa"
MARKETING_ADDRESS="0xF189f0cEe29116B334F4B99466F4EC839eC57C42"
COMMUNITY_ADDRESS="0xC01748415A5dBf19174E31d667795B41c2A7b2DD"
CASP_USDC_ADDRESS="0xAda4a1cC0B8C5500be84a124413D356600992498"
TREASURY_ADDRESS="0xAda4a1cC0B8C5500be84a124413D356600992498"
LIQUIDITY_RECIPIENT="0xdE7632E9071579976f3C33aCc3072De49a4554c2"
TEAM_RECIPIENT="0xEC8220c64a8Ac3d33230864965a1266B478b8fd6"
OPS_RECIPIENT="0xF189f0cEe29116B334F4B99466F4EC839eC57C42"
USDC_ADDRESS="0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
```

Hors deploy initial :
- Prévente (post-libération CASP) `0x1944E2EebbB7013BEc62128202976892d888a5D3`
- LP/Tokens `0x44F36c7304dEd310A6F7e231A70803453eDDa455`
- Réserve de Structuration `0xAb31d8F895676ce570adf900Db59b5F107680C81`
- Réserve Stratégique `0xa3922236F7788dcE164321b117f95E5238931a44` (réallocation ops off-chain si besoin)

---

## 5. Rappel rôles

| # | Rôle | Quand |
|---|------|-------|
| 1–3 | Frais vault / marketing / community | Continu (trading) |
| 4–5 | USDC Founder + prévente → CASP | Pendant la prévente |
| 6–8 | Liquidité / team / ops | Au `finalize` (fin prévente / TGE) |

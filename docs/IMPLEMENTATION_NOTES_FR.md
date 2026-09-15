# Notes d’implémentation (contrats)

Description **factuelle** du comportement actuel des smart contracts dans ce dépôt. Pour les frais et rôles détaillés (bps, chemins pool vs routeur USDC), voir [**FEE_REFERENCE.md**](FEE_REFERENCE.md).

## Frais et cashback

- **Paire DEX — routeur OFF (`TCGVaultToken`) :** achat **6 %** en TCGV (tiers du montant de taxe → vault / marketing / `pendingAutolp`, ≈ **2 % + 2 % + 2 %** notionnels) ; vente **5 %** avec répartition par défaut (**40 % / 40 % / 20 %** de la part taxe → vault / autolp / marketing ; communauté **0 %**). Pas de burn de supply sur ces frais. **Aucun** mint $TCGNEXUS sur l’achat paire.
- **Portail USDC — routeur ON (`TCGVaultBuyRouter`) :** achat **5 %** de l’USDC (**3 %** vault + **2 %** marketing) puis swap ; vente **4 %** sur l’USDC sortant (**FEE_REFERENCE.md** §2.2). Le routeur est exclu des frais sur le token pour éviter la double taxation.
- **Cashback $TCGNEXUS :** **uniquement** via `recordBuyAndMintCashback` après achat via le routeur USDC — **30 %** / **3 %** du TCGV reçu (prévente / post-finalisation).
- **Plafonds :** token paire `MAX_BUY_TAX_BP = 600`, `MAX_SELL_TAX_BP = 500` ; routeur `MAX_BUY_TOTAL_BP = 500`, `MAX_SELL_TAX_BP = 400`. Les taxes restent bornées par ces constantes (`setBuyFeeParams` / `setSellFeeParams`) et peuvent être remontées après une baisse.

## NEXUS (`TCGNexusToken`)

- Décimales **18** ; minter = adresse `TCGVaultToken` (immutable).
- Soulbound : pas de transfert entre comptes.

## NFT Founder (`TCGVaultFounderNFT`)

- **500** exemplaires : **245 + 245** payants (200 / 350 USDC) + **10** réserve stratégique (`mintStrategicReserve`, sans USDC ni bonus NEXUS).
- Déclenchement vague 2 : `wave2StartTimestamp` est fixé au **premier mint payant + 7 jours** (`WAVE1_DURATION`), avec bascule anticipée si les 245 de vague 1 sont vendus avant l’échéance.
- Répartition USDC à chaque mint payant : **30 %** vault / **60 %** liquidité / **10 %** ops (arrondis vers ops si besoin).
- L’acheteur reçoit **30 %** du prix en **NEXUS** (calcul dans le contrat).

## Prévente token (`TCGVaultInitialLaunch`)

- Prix : **0,005** USDC / 1 TCGV (vague 1) puis **0,008** à partir de `block.timestamp >= founderNFT.wave2StartTimestamp()`.
- Chronologie de fin : après le start de la vague 2 Founder, une fenêtre de **10 jours** (`FOUNDER_WAVE2_DURATION`) est appliquée, puis compte à rebours **120 h** (`presaleEndTime()` = `wave2Start + 10j + 120h`).
- Plafond dur **600 M** TCGV ; plafond par wallet **4 %** du hard cap.
- Bonus NEXUS : **30 %** de l’USDC engagé (style Founder).
- Finalisation : `finalize()` seulement après `presaleEndTime() + 20 jours` (`FINALIZE_DELAY_AFTER_PRESALE_END`) ; pas de finalisation anticipée au seul hard cap.
- Après `finalize()` : **TGE 10 %**, puis **10 % / mois** pendant **9** mois (`releasable()` / `claim()`).

## Post-TGE — routeur et token

- Routeur USDC : adresse exclue des frais sur `TCGVaultToken` pour éviter la double taxation sur ce parcours.
- Voir [**PRODUCT_LIFECYCLE.md**](PRODUCT_LIFECYCLE.md) (résumé cycle de vie) et les sources Solidity.

## Staking et NFT Basique

- Vault **ERC-4626** sur le TCGV ; seuil `requiredStakeForBasicNFT` pour mint du NFT Basique au **receiver** ; retrait sous le minimum **brûle** le NFT Basique du wallet.
- NFT Basique **soulbound**.

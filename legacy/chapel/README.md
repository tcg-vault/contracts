# BSC testnet (chapel) — deployed contract snapshots

Frozen Solidity sources used **only** to verify contracts already live on BSC testnet.
The active implementations stay in `contracts/*.sol`. Snapshots live under `legacy/` (not compiled by Hardhat).

## TCGVaultBuyRouter

| | |
|---|---|
| **Address** | `0x3d5c49910f32ed78dc83141fabf1033d7b5e52e2` |
| **Snapshot** | `TCGVaultBuyRouter.deployed.sol` (git commit `cd4b6ed`) |
| **Verify** | `yarn verify:bsctest:buyrouter` |

The file you pasted in chat matches **current** `contracts/TCGVaultBuyRouter.sol` (HEAD).
The bytecode on testnet was built from an **earlier** revision (`cd4b6ed`, May 2026) with
`@openzeppelin/contracts@5.6.1` and the same Hardhat settings (`solc 0.8.27`, `cancun`, optimizer on).

Do not edit `TCGVaultBuyRouter.deployed.sol` unless you redeploy; change `contracts/TCGVaultBuyRouter.sol` instead.

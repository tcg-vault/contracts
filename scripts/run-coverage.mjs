#!/usr/bin/env node
/**
 * Run Hardhat coverage using the main hardhat.config.ts.
 * Excludes fork-only contracts (WBNB, Pancake*) so we can drop the 0.4.18 compiler
 * and the injected coverage library (pragma >=0.4.22) compiles with 0.5.16+.
 * After a successful run, strips contracts/test from lcov and prints production-only totals.
 */
import { spawnSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const excludeScript = join(ROOT, "scripts", "coverage-exclude-fork-contracts.mjs");

let exitCode = 1;
try {
  const hide = spawnSync("node", [excludeScript, "hide"], { cwd: ROOT });
  if (hide.status !== 0) {
    console.error("Failed to hide fork contracts for coverage");
    process.exit(1);
  }
  const r = spawnSync(
    "yarn",
    ["hardhat", "test", "--coverage"],
    { cwd: ROOT, stdio: "inherit", shell: true, env: { ...process.env, COVERAGE: "1" } }
  );
  exitCode = r.status ?? 1;
  if (exitCode === 0) {
    const filter = join(ROOT, "scripts", "coverage-production-only.mjs");
    const f = spawnSync("node", [filter], { cwd: ROOT, stdio: "inherit" });
    if (f.status !== 0) exitCode = f.status ?? 1;
  }
} finally {
  spawnSync("node", [excludeScript, "show"], { cwd: ROOT });
}
process.exit(exitCode);

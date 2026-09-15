#!/usr/bin/env node
/**
 * Rewrite coverage/lcov.info to production contracts only (drop contracts/test
 * and node_modules) and print a Hardhat-style table with uncovered lines.
 *
 * Run: yarn coverage  (invoked automatically)  or  node scripts/coverage-production-only.mjs
 */
import { copyFileSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const LCOV_PATH = "coverage/lcov.info";
const LCOV_FULL_PATH = "coverage/lcov.full.info";

const EXCLUDE = ["contracts/test/", "node_modules/"];

function isProduction(path) {
  if (!path) return false;
  const normalized = path.replaceAll("\\", "/");
  return !EXCLUDE.some((p) => normalized.includes(p));
}

function formatUncovered(lines) {
  if (lines.length === 0) return "-";
  const sorted = [...lines].sort((a, b) => a - b);
  const intervals = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      intervals.push(start === end ? `${start}` : `${start}-${end}`);
      if (i < sorted.length) {
        start = sorted[i];
        end = sorted[i];
      }
    }
  }
  const joined = intervals.join(", ");
  return joined.length > 80 ? `${joined.slice(0, 77)}…` : joined;
}

try {
  const raw = readFileSync(LCOV_PATH, "utf8");
  copyFileSync(LCOV_PATH, LCOV_FULL_PATH);

  const files = [];
  const keptRecords = [];
  for (const record of raw.split("end_of_record")) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const sf = trimmed.match(/^SF:(.+)$/m);
    if (!sf) continue;
    const path = sf[1].trim();
    if (!isProduction(path)) continue;

    const uncovered = [];
    let covered = 0;
    let total = 0;
    for (const line of trimmed.split("\n")) {
      const da = line.match(/^DA:(\d+),(\d+)/);
      if (da) {
        total += 1;
        if (da[2] === "0") uncovered.push(parseInt(da[1], 10));
        else covered += 1;
      }
    }
    const lf = trimmed.match(/^LF:(\d+)/m);
    const lh = trimmed.match(/^LH:(\d+)/m);
    if (lf && lh) {
      total = parseInt(lf[1], 10);
      covered = parseInt(lh[1], 10);
    }
    files.push({ path, covered, total, uncovered });
    keptRecords.push(trimmed);
  }

  const filtered = keptRecords.length
    ? `${keptRecords.join("\nend_of_record\n")}\nend_of_record\n`
    : "TN:\n";
  writeFileSync(LCOV_PATH, filtered.startsWith("TN:") ? filtered : `TN:\n${filtered}`);

  files.sort((a, b) => a.path.localeCompare(b.path));

  console.log("\n=== Production coverage (excluding contracts/test and node_modules) ===\n");
  const nameWidth = Math.max(24, ...files.map((f) => f.path.replace("contracts/", "").length));
  const header = `${"File".padEnd(nameWidth)}  Line %     Covered   Uncovered lines`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const f of files) {
    const name = f.path.replace("contracts/", "");
    const pct = f.total ? ((f.covered / f.total) * 100).toFixed(2) : "100.00";
    const mark = pct === "100.00" ? "✓" : " ";
    console.log(
      `${mark} ${name.padEnd(nameWidth)}  ${pct.padStart(6)}%  ${String(f.covered).padStart(4)}/${String(f.total).padEnd(4)}  ${formatUncovered(f.uncovered)}`,
    );
    if (f.uncovered.length > 0 && formatUncovered(f.uncovered).endsWith("…")) {
      console.log(`    all uncovered: ${f.uncovered.join(", ")}`);
    }
  }
  const totalLines = files.reduce((s, d) => s + d.total, 0);
  const totalCovered = files.reduce((s, d) => s + d.covered, 0);
  const totalPct = totalLines ? ((totalCovered / totalLines) * 100).toFixed(2) : "100.00";
  console.log("-".repeat(header.length));
  console.log(
    `  ${"Total".padEnd(nameWidth)}  ${totalPct.padStart(6)}%  ${String(totalCovered).padStart(4)}/${String(totalLines).padEnd(4)}`,
  );
  console.log(`\nFull (unfiltered) lcov saved to ${join(LCOV_FULL_PATH)}`);
} catch (e) {
  console.error("Run yarn coverage first.", e.message ?? e);
  process.exit(1);
}

// Fails when a file other than a protected table's writer module can write
// that table. See scripts/check-protected-table-writers-core.mjs for the
// rules, the allowlists and why each entry is there.
//
// Usage:
//   npm run check:protected-table-writers

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROTECTED_TABLES,
  SCANNED_DIRECTORIES,
  SCANNED_EXTENSIONS,
  checkProtectedTableWriters,
  describeFindings,
} from "./check-protected-table-writers-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", ".next"]);

const walk = (dir, found = []) => {
  let entries;
  try {
    entries = readdirSync(join(root, dir));
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRECTORY_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(join(root, full)).isDirectory()) walk(full, found);
    else found.push(full);
  }
  return found;
};

const sources = SCANNED_DIRECTORIES.flatMap((dir) => walk(dir))
  .filter((path) => SCANNED_EXTENSIONS.has(extname(path)))
  .map((path) => ({
    // Slash paths on every platform, so allowlist keys match on Windows too.
    path: relative(root, join(root, path)).split(sep).join("/"),
    text: readFileSync(join(root, path), "utf8"),
  }));

const findings = checkProtectedTableWriters({ sources });

if (findings.length > 0) {
  console.error(describeFindings(findings));
  process.exit(1);
}

console.log(
  `Protected table writer check passed: ${sources.length} file(s) scanned; ` +
    PROTECTED_TABLES.map((entry) => `${entry.table} is written only by ${entry.writers.join(", ")}`).join("; ") +
    "."
);

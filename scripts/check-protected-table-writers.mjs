// Fails when a file other than a protected table's writer module can write
// that table. See scripts/check-protected-table-writers-core.mjs for the
// rules, the allowlists and why each entry is there.
//
// Usage:
//   npm run check:protected-table-writers

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROTECTED_TABLES,
  checkProtectedTableWriters,
  describeFindings,
  selectScannedPaths,
} from "./check-protected-table-writers-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// Tracked files plus new files that are not ignored, so a file added locally
// is checked before it is committed. Fail closed: a scan that read nothing
// would pass.
const listed = spawnSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
);
if (listed.status !== 0 || listed.error) {
  console.error(
    "Protected table writer check could not list repository files with git:",
    listed.error?.message || listed.stderr
  );
  process.exit(1);
}

const paths = selectScannedPaths(listed.stdout.split("\0").filter(Boolean)).filter((path) =>
  // A tracked file deleted in the working tree is not there to read.
  existsSync(join(root, path))
);
if (paths.length === 0) {
  console.error("Protected table writer check found no source files to scan.");
  process.exit(1);
}

const sources = paths.map((path) => ({
  path,
  text: readFileSync(join(root, path), "utf8"),
}));

const findings = checkProtectedTableWriters({ sources });

if (findings.length > 0) {
  console.error(describeFindings(findings));
  process.exit(1);
}

console.log(
  `Protected table writer check passed: ${sources.length} source file(s) analysed; ` +
    PROTECTED_TABLES.map(
      (entry) => `${entry.table} is written only by ${entry.writers.join(", ")}`
    ).join("; ") +
    "."
);

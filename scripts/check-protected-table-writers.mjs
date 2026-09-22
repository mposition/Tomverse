// Fails when a scanned file other than a protected table's writer module
// contains a write this check can read: a delegate write, raw SQL naming the
// table beside a write verb, or a new route to runtime-built SQL. See
// scripts/check-protected-table-writers-core.mjs for the rules, the
// allowlists, and what the check does and does not promise.
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

// TRUNCATE against the permission ledger.
//
// The ledger's row triggers refuse UPDATE and DELETE and cannot see TRUNCATE:
// it fires no row trigger, and a cascade from `User` or `EmailDelivery`
// reaches these tables through their foreign keys
// (prisma/migrations/20260921170000_email_permission_ledger). A BEFORE
// TRUNCATE trigger would have closed it and would also have broken 84 of the
// 138 DB integration suites, which reset themselves by truncating exactly
// those two tables; revoking the privilege is the lever that fits and it
// reaches every table in the schema, so it belongs with whoever owns the
// database roles.
//
// What is closed here is the vector this repository controls: none of its own
// code may issue the statement. A fixture may, and says so by living under
// tests/ -- `selectScannedPaths` already excludes those.
const LEDGER_TABLES = [
  "EmailPermissionEvent",
  "EmailSendApproval",
  "EmailSendApprovalMember",
  "EmailSendApprovalRevocation",
  "EmailPermissionDecision",
  "EmailPermissionDecisionEvidence",
];

// One statement, however it is spelled: the table may be quoted or not, may be
// schema-qualified, and may be the second or tenth name in the list.
const TRUNCATE_STATEMENT = /\bTRUNCATE\b[\s\S]{0,400}?;/gi;

const truncateFindings = [];
for (const { path, text } of sources) {
  TRUNCATE_STATEMENT.lastIndex = 0;
  let match;
  while ((match = TRUNCATE_STATEMENT.exec(text)) !== null) {
    for (const table of LEDGER_TABLES) {
      if (new RegExp(`\\b${table}\\b`).test(match[0])) {
        truncateFindings.push({ path, table });
      }
    }
  }
}

if (truncateFindings.length > 0) {
  console.error(
    "Protected table writer check failed: the permission ledger is append-only " +
      "and TRUNCATE is the one verb its triggers cannot refuse.\n" +
      truncateFindings
        .map(({ path, table }) => `  - ${path} truncates ${table}`)
        .join("\n") +
      "\n\nIf a fixture needs this, it belongs under tests/. If production " +
      "code does, the ledger is not append-only and that is a contract change."
  );
  process.exit(1);
}

if (findings.length > 0) {
  console.error(describeFindings(findings));
  process.exit(1);
}

console.log(
  `Protected table writer check passed: ${sources.length} source file(s) analysed; ` +
    PROTECTED_TABLES.map(
      (entry) => `no direct ${entry.table} write found outside ${entry.writers.join(", ")}`
    ).join("; ") +
    `; no TRUNCATE of the permission ledger's ${LEDGER_TABLES.length} table(s) outside tests.`
);

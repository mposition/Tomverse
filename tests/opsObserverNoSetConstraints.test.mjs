// The ops-observer tables refuse a late COMMIT with deferred constraint
// triggers (docs/policy/sre-ops.md §6 item 5). A session can move a deferrable
// check earlier with SET CONSTRAINTS ... IMMEDIATE, and the database cannot
// refuse that to the code that holds the connection. So no source may issue
// it.
//
// The sweep reads every code, SQL and shell file outside tests/ and
// node_modules -- root files such as proxy.ts, tools/, prisma/ and vendor/
// included -- as raw text. It does not try to tell comments from code: every
// language draws that line differently, and a stripper that guessed wrong
// would hide the statement it exists to find. Instead a file may mention the
// phrase only where REVIEWED_MENTIONS names it, with the exact count; each of
// those is prose in a comment, and a new mention anywhere fails until a
// reviewer adds it here.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_FILE = /\.(ts|tsx|mts|cts|mjs|js|cjs|sql|rs|py|sh|bash|ps1|psm1)$/i;
const SKIPPED = new Set(["node_modules", ".git", ".next", "tests", "target", "dist"]);

/**
 * SET and CONSTRAINTS with any whitespace or SQL comments between them. No word
 * boundary before SET: an escaped newline in a string literal ("\nSET ...")
 * puts a letter right before it. Over-matching only costs a review. The block
 * comment is the unambiguous form (no lazy any-character run), so no input can
 * make the match backtrack exponentially.
 */
const STATEMENT = /SET(?:\s|\/\*(?:[^*]|\*+[^*/])*\*+\/|--[^\n]*\n)*CONSTRAINTS\b/gi;

/** Comment prose that names the rule. Path (POSIX) -> exact number of matches. */
const REVIEWED_MENTIONS = {
  // Explains that the AMUX fence never runs it.
  "prisma/migrations/20260929200000_amux_commit_deadline_check/migration.sql": 1,
  // States the limit of the deferred deadline check twice, and names this
  // test's file (opsObserverNoSetConstraints) once.
  "prisma/migrations/20261003070000_ops_observer_genesis_state/migration.sql": 3,
  // Points back to the genesis and state migration's statement of that limit.
  "prisma/migrations/20261003090000_ops_observer_delivery/migration.sql": 1,
  // Points back to the same statement of that limit.
  "prisma/migrations/20261004030000_ops_observer_transition/migration.sql": 1,
};

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (SOURCE_FILE.test(entry.name)) yield path;
  }
}

const count = (text) => (text.match(STATEMENT) ?? []).length;

test("no source outside tests mentions SET CONSTRAINTS beyond the reviewed comments", () => {
  const found = {};
  const scanned = new Set();
  for (const file of walk(root)) {
    const rel = file.slice(root.length).split(sep).join("/");
    scanned.add(rel);
    const n = count(readFileSync(file, "utf8"));
    if (n > 0) found[rel] = n;
  }
  // The sweep must actually have read the places a statement could hide.
  for (const required of ["proxy.ts", "prisma/", "tools/", "vendor/", "scripts/", "lib/", "app/"]) {
    assert.ok(
      [...scanned].some((rel) => (required.endsWith("/") ? rel.startsWith(required) : rel === required)),
      `the sweep did not read ${required}`,
    );
  }
  assert.ok(scanned.size > 500, "the sweep must see the source tree");
  assert.deepEqual(found, REVIEWED_MENTIONS);
});

test("the pattern finds the statement however it is spelled, and in any surrounding code", () => {
  const cases = [
    "SET CONSTRAINTS ALL IMMEDIATE;",
    "set   constraints all immediate",
    "SET/* early */CONSTRAINTS ALL IMMEDIATE",
    "SET -- now\nCONSTRAINTS ALL IMMEDIATE",
    'remaining--; await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")',
    'psql --command "SET CONSTRAINTS ALL IMMEDIATE"',
    'const sql = "--\\nSET CONSTRAINTS ALL IMMEDIATE";',
  ];
  for (const text of cases) assert.equal(count(text), 1, text);
  assert.equal(count("RESET constraints_x; SETTINGS CONSTRAINTS"), 0);
});

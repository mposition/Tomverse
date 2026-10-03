// The ops-observer tables refuse a late COMMIT with deferred constraint
// triggers (docs/policy/sre-ops.md §6 item 5). A session can move a deferrable
// check earlier with SET CONSTRAINTS ... IMMEDIATE, and the database cannot
// refuse that to the code that holds the connection. So no source may issue
// it: this sweep reads every code and SQL file in the repository outside
// tests/ and node_modules -- root files such as proxy.ts, tools/, prisma/,
// vendor/ included -- and fails if any does. Comments are stripped first, so a
// file that explains the rule is not mistaken for one that breaks it.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_FILE = /\.(ts|tsx|mts|cts|mjs|js|cjs|sql|rs|py|sh)$/;
const SKIPPED = new Set(["node_modules", ".git", ".next", "tests", "target", "dist"]);
const STATEMENT = /\bSET\s+CONSTRAINTS\b/i;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (SOURCE_FILE.test(entry.name)) yield path;
  }
}

/** The text without block comments, `--`/`//` line comments and `#` comment lines. */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])(--|\/\/).*$/gm, "$1")
    .replace(/^\s*#.*$/gm, "");
}

test("no source outside tests issues SET CONSTRAINTS", () => {
  const offenders = [];
  let scanned = 0;
  for (const file of walk(root)) {
    scanned += 1;
    if (STATEMENT.test(code(readFileSync(file, "utf8")))) offenders.push(file.slice(root.length));
  }
  assert.ok(scanned > 500, "the sweep must actually see the source tree");
  assert.deepEqual(offenders, []);
});

test("comment stripping removes explanations and keeps statements", () => {
  assert.match(code("-- explains SET CONSTRAINTS\nSET CONSTRAINTS ALL IMMEDIATE;"), STATEMENT);
  assert.doesNotMatch(code("-- explains SET CONSTRAINTS\n// and SET CONSTRAINTS\n/* SET CONSTRAINTS */"), STATEMENT);
  assert.match(code('await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")'), STATEMENT);
});

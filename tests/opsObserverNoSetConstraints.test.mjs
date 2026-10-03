// The ops-observer tables refuse a late COMMIT with deferred constraint
// triggers (docs/policy/sre-ops.md §6 item 5). A session can move a deferrable
// check earlier with SET CONSTRAINTS ... IMMEDIATE, and the database cannot
// refuse that to the code that holds the connection. So no application source
// may issue it: this sweep fails if any file outside tests/ does.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIRECTORIES = ["app", "lib", "scripts", "packages", "components"];
const SOURCE_FILE = /\.(ts|tsx|mjs|js|cjs|sql)$/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (SOURCE_FILE.test(entry.name)) yield path;
  }
}

test("no application source issues SET CONSTRAINTS", () => {
  const offenders = [];
  let scanned = 0;
  for (const dir of SOURCE_DIRECTORIES) {
    let present = true;
    try {
      readdirSync(join(root, dir));
    } catch {
      present = false;
    }
    if (!present) continue;
    for (const file of walk(join(root, dir))) {
      scanned += 1;
      if (/\bSET\s+CONSTRAINTS\b/i.test(readFileSync(file, "utf8"))) offenders.push(file.slice(root.length));
    }
  }
  assert.ok(scanned > 500, "the sweep must actually see the source tree");
  assert.deepEqual(offenders, []);
});

// Reports the tables the application writes and never deletes from.
//
// See scripts/report-unswept-tables-core.mjs for why this is a report rather
// than a gate, and what each of the three exits from the list means.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditUnsweptTables,
  BOUNDED_TABLES,
  RETAINED_TABLES,
} from "./report-unswept-tables-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const schema = readFileSync(join(root, "prisma", "schema.prisma"), "utf8");
const models = [...schema.matchAll(/^model ([A-Za-z0-9_]+) \{/gm)].map(
  (match) => {
    const name = match[1];
    const body =
      new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`, "m").exec(schema)?.[0] ||
      "";
    return { name, hasUserCascade: /onDelete:\s*Cascade/.test(body) };
  }
);

const SOURCE_ROOTS = ["lib", "app", "scripts", "components"];
const SKIPPED = new Set(["node_modules", ".next", ".git", "dist", "build"]);
const files = [];
const walk = (directory) => {
  for (const entry of readdirSync(join(root, directory))) {
    if (SKIPPED.has(entry)) continue;
    const relative = join(directory, entry);
    if (statSync(join(root, relative)).isDirectory()) walk(relative);
    else if (/\.(ts|tsx|mjs)$/.test(entry)) files.push(relative);
  }
};
for (const directory of SOURCE_ROOTS) walk(directory);
const source = files.map((file) => readFileSync(join(root, file), "utf8")).join("\n");

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const created = new Set();
const deleted = new Set();
for (const { name } of models) {
  const delegate = escape(name[0].toLowerCase() + name.slice(1));
  // Prisma calls are often chained across lines, so the delegate and the
  // operation are matched with the newline between them allowed.
  const uses = (operations) =>
    new RegExp(
      `\\.\\s*${delegate}\\s*\\n?\\s*\\.\\s*(?:${operations})\\b`
    ).test(source);
  if (uses("create|createMany|upsert")) created.add(name);
  if (
    uses("delete|deleteMany") ||
    new RegExp(`DELETE FROM "?${escape(name)}"?`, "i").test(source)
  ) {
    deleted.add(name);
  }
}

const { unswept, cascadeOnly, errors } = auditUnsweptTables({
  models,
  created,
  deleted,
});

console.log(
  `Read ${models.length} model(s); the application creates rows in ${created.size} ` +
    `and deletes rows from ${deleted.size}.`
);
console.log(
  `Registered as bounded: ${Object.keys(BOUNDED_TABLES).length}; ` +
    `as deliberately retained: ${Object.keys(RETAINED_TABLES).length}.`
);

if (cascadeOnly.length > 0) {
  console.log(
    `\n${cascadeOnly.length} table(s) are removed only when their parent is:\n` +
      cascadeOnly.map((name) => `  - ${name}`).join("\n") +
      "\n  A cascade answers whether the row outlives the account. It does not\n" +
      "  answer whether the table stops growing while the account is active."
  );
}

if (unswept.length > 0) {
  console.log(
    `\n${unswept.length} table(s) nothing removes rows from, and nothing bounds:\n` +
      unswept.map((name) => `  - ${name}`).join("\n") +
      "\n  Each needs a decision: a retention policy in lib/retentionPolicyCore.ts,\n" +
      "  or an entry in this script's bounded/retained registry with the reason."
  );
} else {
  console.log("\nNo unbounded, unswept table without a stated reason.");
}

if (errors.length > 0) {
  console.error(
    `\n${errors.length} registry problem(s):\n` +
      errors.map((message) => `  - ${message}`).join("\n")
  );
  process.exit(1);
}

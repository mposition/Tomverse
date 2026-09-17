import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  PROTECTED_TABLES,
  RAW_SQL_ALLOWLIST,
  UNSAFE_RAW_ALLOWLIST,
  checkProtectedTableWriters,
} from "../scripts/check-protected-table-writers-core.mjs";

// The protected-table writer check: positive and negative fixtures for each
// rule, pinned as deliberately as each other. A check that fires on reads gets
// switched off; one that misses an alias is decoration.
//
// Contract: docs/policy/marketing-automation.md §6.

const ROOT = resolve(import.meta.dirname, "..");

const realAllowlistPaths = new Set([
  ...RAW_SQL_ALLOWLIST.map((entry) => entry.path),
  ...UNSAFE_RAW_ALLOWLIST.map((entry) => entry.path),
]);

/** Findings for fixture files only: the real allowlisted files are not in a fixture run. */
const check = (sources) =>
  checkProtectedTableWriters({ sources }).filter(
    (finding) => !realAllowlistPaths.has(finding.path)
  );

const one = (path, text) => check([{ path, text }]);

test("delegate writes are findings, in every spelling", () => {
  const cases = {
    "lib/a.ts": "await prisma.adminAuditLog.create({ data })",
    "lib/b.ts": 'await tx.adminAuditLog["update"]({ where, data })',
    "lib/c.ts": "await prisma.adminAuditLog.deleteMany({})",
    "lib/d.ts": "await prisma?.adminAuditLog?.upsert(args)",
    "lib/e.ts": 'await prisma["adminAuditLog"].createMany({ data })',
    "lib/f.ts": "await tx.adminAuditLog[operation](args)",
    "lib/g.ts": "const delegate = prisma.adminAuditLog; await delegate.create(args)",
    "lib/h.ts": "const { create } = prisma.adminAuditLog; await create(args)",
    "lib/i.ts": "await writeVia(prisma.adminAuditLog)",
    "lib/j.ts": "await (prisma.adminAuditLog).create(args)",
    "app/k.tsx":
      "export default async function K() { await prisma.adminAuditLog.updateMany({}); return <div /> }",
    "scripts/l.mjs": "await prisma.adminAuditLog.createManyAndReturn({ data })",
  };
  for (const [path, text] of Object.entries(cases)) {
    const findings = one(path, text);
    assert.equal(findings.length, 1, `${path}: ${text}`);
    assert.equal(findings[0].rule, "delegate-write", path);
    assert.equal(findings[0].table, "AdminAuditLog", path);
  }
});

test("reads, the writer module and look-alikes are not findings", () => {
  assert.deepEqual(
    one(
      "lib/reads.ts",
      [
        "await prisma.adminAuditLog.findMany({ take: 10 })",
        "await prisma.adminAuditLog.findFirst({})",
        'await prisma.adminAuditLog["count"]()',
        "await tx.adminAuditLog.aggregate({ _count: true })",
        "await prisma.adminAuditLog.groupBy({ by: ['action'] })",
        "await prisma.adminAuditLog.findUniqueOrThrow({ where })",
      ].join("\n")
    ),
    []
  );
  assert.deepEqual(one("lib/adminAudit.ts", "await client.adminAuditLog.create({ data })"), []);
  // An object key in a mock, a local of the same name, a type name and a comment.
  assert.deepEqual(
    one(
      "lib/lookalikes.ts",
      [
        "const mock = { adminAuditLog: { create: async () => ({ id: '1' }) } };",
        "const adminAuditLog = rows; adminAuditLog.push(row);",
        "type Input = Prisma.AdminAuditLogCreateInput;",
        "// prisma.adminAuditLog.create is only called by lib/adminAudit.ts",
      ].join("\n")
    ),
    []
  );
});

test("raw SQL naming the table beside a write verb is a finding, in either order and across literals", () => {
  const cases = {
    "lib/tagged.ts":
      'await prisma.$executeRaw`INSERT INTO "AdminAuditLog" ("id") VALUES (${id})`',
    "lib/split.ts": [
      "const TABLE = '\"AdminAuditLog\"';",
      "// many lines later",
      "const VERB = 'DELETE FROM';",
    ].join("\n"),
    "lib/reversed.ts": "const a = 'truncate'; const b = 'public.adminauditlog';",
    "lib/alter.ts":
      'await prisma.$executeRaw`ALTER TABLE "AdminAuditLog" DISABLE TRIGGER ALL`',
    "prisma/migrations/20990101000000_x/migration.sql":
      "UPDATE \"AdminAuditLog\" SET \"summary\" = '';",
  };
  for (const [path, text] of Object.entries(cases)) {
    const findings = one(path, text);
    assert.equal(findings.length, 1, path);
    assert.equal(findings[0].rule, "raw-sql", path);
  }
});

test("a table name without a write verb, or only in comments, is not a raw SQL finding", () => {
  assert.deepEqual(
    one("lib/select.ts", 'await prisma.$queryRaw`SELECT count(*) FROM "AdminAuditLog"`'),
    []
  );
  assert.deepEqual(
    one("lib/commented.ts", '// DELETE FROM "AdminAuditLog" would break the chain\nconst x = 1;'),
    []
  );
  assert.deepEqual(
    one(
      "prisma/migrations/20990101000000_y/migration.sql",
      '-- never UPDATE "AdminAuditLog" here\n/* DELETE FROM "AdminAuditLog" */\nSELECT 1;'
    ),
    []
  );
  // An action name is not a verb: `update_started` has no word boundary.
  assert.deepEqual(
    one(
      "lib/action.ts",
      "const table = 'AdminAuditLog'; const action = 'settings.update_started';"
    ),
    []
  );
});

test("runtime-built SQL is inventoried by file and count, in both directions", () => {
  const added = one("lib/new.ts", "await tx.$executeRawUnsafe(sql, ...values)");
  assert.equal(added.length, 1);
  assert.equal(added[0].rule, "unsafe-raw");

  const prismaRaw = one(
    "lib/prisma-raw.ts",
    "await tx.$queryRaw`SELECT ${Prisma.raw(column)}`"
  );
  assert.equal(prismaRaw.length, 1);
  assert.equal(prismaRaw[0].rule, "unsafe-raw");

  const [entry] = UNSAFE_RAW_ALLOWLIST;
  const extra = checkProtectedTableWriters({
    sources: [
      {
        path: entry.path,
        text: Array.from({ length: entry.count + 1 }, () => "await tx.$queryRawUnsafe(q);").join(
          "\n"
        ),
      },
    ],
  }).filter((finding) => finding.path === entry.path);
  assert.equal(extra.length, 1, "one more call than reviewed is a finding");
  assert.match(extra[0].detail, new RegExp(`allowlist says ${entry.count}`));

  const gone = checkProtectedTableWriters({
    sources: [{ path: entry.path, text: "export const nothing = 1;" }],
  }).filter((finding) => finding.path === entry.path);
  assert.equal(gone.length, 1, "an entry whose calls are gone is a finding");
  assert.match(gone[0].detail, /found 0/);
});

test("excluded trees are not scanned", () => {
  assert.deepEqual(
    one(
      "prisma/generated/prisma/internal/class.ts",
      "await c.$executeRawUnsafe(q); await c.adminAuditLog.create(x)"
    ),
    []
  );
  assert.deepEqual(
    one("prisma/migrations-archive/1/migration.sql", 'INSERT INTO "AdminAuditLog" VALUES (1);'),
    []
  );
});

test("a raw SQL allowlist entry that stops matching is reported", () => {
  const [entry] = RAW_SQL_ALLOWLIST;
  const findings = checkProtectedTableWriters({
    sources: [{ path: entry.path, text: "export const unrelated = 'hello';" }],
  }).filter((finding) => finding.path === entry.path);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "stale-allowlist");
});

test("account deletion's runtime SQL never names a protected table", () => {
  // lib/accountDataAnonymisation.ts may build SQL at runtime because its table
  // names come from two literal lists. That reason stops holding the day one of
  // those lists names a table whose rows are evidence.
  const source = readFileSync(resolve(ROOT, "lib/accountDataAnonymisation.ts"), "utf8");
  const tables = [...source.matchAll(/\btable:\s*"([A-Za-z0-9]+)"/g)].map((match) => match[1]);
  assert.ok(tables.length >= 2, "the scan must reach the declared tables");
  for (const { table } of PROTECTED_TABLES) {
    assert.ok(
      !tables.includes(table),
      `${table} must not be anonymised or deleted by account deletion`
    );
  }
});

test("the repository passes the check as it stands", () => {
  const result = spawnSync(
    process.execPath,
    [resolve(ROOT, "scripts/check-protected-table-writers.mjs")],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

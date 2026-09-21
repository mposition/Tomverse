import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  DELEGATE_NAME_ALLOWLIST,
  EXCLUDED_PREFIXES,
  PROTECTED_TABLES,
  RAW_SQL_ALLOWLIST,
  RETENTION_SETTING_ALLOWLIST,
  RUNTIME_SQL_ALLOWLIST,
  PROTECTED_EXPORT_ALLOWLIST,
  TEMPLATE_SEAL_DYNAMIC_KEY_ALLOWLIST,
  checkProtectedTableWriters,
  selectScannedPaths,
  sourceFingerprint,
  sqlWithoutComments,
} from "../scripts/check-protected-table-writers-core.mjs";

// The protected-table writer check: positive and negative fixtures for each
// rule, pinned as deliberately as each other. A check that fires on reads gets
// switched off; one that misses an alias is decoration. The bypass fixtures
// below include every probe from the independent review that rejected the
// first version.
//
// Contract: docs/policy/marketing-automation.md §6.

const ROOT = resolve(import.meta.dirname, "..");

const realAllowlistPaths = new Set([
  ...DELEGATE_NAME_ALLOWLIST.map((entry) => entry.path),
  ...RAW_SQL_ALLOWLIST.map((entry) => entry.path),
  ...RUNTIME_SQL_ALLOWLIST.map((entry) => entry.path),
  ...RETENTION_SETTING_ALLOWLIST.map((entry) => entry.path),
  // Every allowlist, every time. A fixture run holds none of the real files,
  // so each one reports "allowlist says N, found 0" -- and an allowlist left
  // out of this set puts that finding into all twenty fixtures at once. Which
  // is what happened when the seal rule was added: seven unrelated tests went
  // red and the rule itself had no test at all.
  ...PROTECTED_EXPORT_ALLOWLIST.map((entry) => entry.path),
]);

/** Findings for fixture files only: the real allowlisted files are not in a fixture run. */
const check = (sources) =>
  checkProtectedTableWriters({ sources }).filter(
    (finding) => !realAllowlistPaths.has(finding.path)
  );

const one = (path, text) => check([{ path, text }]);

const assertOneFinding = (path, text, rule) => {
  const findings = one(path, text);
  assert.equal(findings.length >= 1, true, `${path} should fail: ${text}`);
  assert.ok(
    findings.some((finding) => finding.rule === rule),
    `${path} should fail with ${rule}, got ${JSON.stringify(findings)}`
  );
};

test("the scan reaches root entry points and every JS/TS extension, and nothing excluded", () => {
  const selected = selectScannedPaths([
    "instrumentation.ts",
    "proxy.ts",
    "lib/bypass.mts",
    "lib/bypass.cts",
    "scripts/bypass.cjs",
    "components/Bypass.jsx",
    "apps/mobile/src/x.ts",
    "prisma/migrations/1/migration.sql",
    "scripts\\windows-style.mjs",
    "tests/integration/x.db.test.ts",
    "prisma/generated/prisma/client.ts",
    "prisma/migrations-archive/1/migration.sql",
    "docs/example.ts",
    "README.md",
    "scripts/check-protected-table-writers-core.mjs",
    "scripts/check-protected-table-writers-bypass.mjs",
  ]);
  assert.deepEqual(selected, [
    "instrumentation.ts",
    "proxy.ts",
    "lib/bypass.mts",
    "lib/bypass.cts",
    "scripts/bypass.cjs",
    "components/Bypass.jsx",
    "apps/mobile/src/x.ts",
    "prisma/migrations/1/migration.sql",
    "scripts/windows-style.mjs",
    "scripts/check-protected-table-writers-bypass.mjs",
  ]);
});

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
    "lib/m.mts": "await prisma.adminAuditLog.create({ data })",
    "lib/n.ts": "const { adminAuditLog: audit } = prisma; await audit.create({ data });",
    "lib/o.ts": "const { adminAuditLog } = tx; await adminAuditLog.create({ data });",
  };
  for (const [path, text] of Object.entries(cases)) {
    assertOneFinding(path, text, "delegate-write");
  }
});

test("a delegate reached by name at runtime is a finding", () => {
  assertOneFinding(
    "lib/named.ts",
    'const model = "adminAuditLog"; await prisma[model].create({ data });',
    "delegate-name"
  );
  assertOneFinding(
    "lib/named.ts",
    'const model = "adminAuditLog"; await prisma[model].create({ data });',
    "dynamic-delegate"
  );
  assertOneFinding(
    "lib/reflect.ts",
    'await Reflect.get(prisma, "adminAuditLog").create({ data });',
    "delegate-name"
  );
  assertOneFinding(
    "lib/assembled.ts",
    'const name = ["admin", "AuditLog"].join(""); await prisma[name].create({ data });',
    "dynamic-delegate"
  );
  assertOneFinding(
    "lib/helper.ts",
    "export const write = (source, key, data) => source[key].create({ data });",
    "dynamic-delegate"
  );
  assertOneFinding(
    "lib/reflect-dynamic.ts",
    "export const pick = (tx, key) => Reflect.get(tx, key);",
    "dynamic-delegate"
  );
  assertOneFinding(
    "lib/destructure-dynamic.ts",
    "export const pick = (key) => { const { [key]: d } = prisma; return d; };",
    "dynamic-delegate"
  );
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
  assert.deepEqual(
    one(
      "lib/lookalikes.ts",
      [
        "const mock = { adminAuditLog: { create: async () => ({ id: '1' }) } };",
        "const adminAuditLog = rows; adminAuditLog.push(row);",
        "type Input = Prisma.AdminAuditLogCreateInput;",
        'type Record = "feedback" | "adminAuditLog";',
        "// prisma.adminAuditLog.create is only called by lib/adminAudit.ts",
        "const item = rows[index]; const cell = grid[row][column];",
        "const { [FIELD]: removed, ...rest } = item.gold;",
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
    "prisma/migrations/20990101000000_quoted/migration.sql":
      "SELECT '-- literal'; DELETE FROM \"AdminAuditLog\";",
    "prisma/migrations/20990101000000_dollar/migration.sql":
      "CREATE FUNCTION f() RETURNS void AS $body$ DELETE FROM \"AdminAuditLog\"; $body$ LANGUAGE sql;",
  };
  for (const [path, text] of Object.entries(cases)) {
    assertOneFinding(path, text, "raw-sql");
  }
});

test("a table name without a write verb, or only in real comments, is not a raw SQL finding", () => {
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
      '-- never UPDATE "AdminAuditLog" here\n/* DELETE /* nested */ FROM "AdminAuditLog" */\nSELECT 1;'
    ),
    []
  );
  assert.deepEqual(
    one(
      "lib/action.ts",
      "const table = 'AdminAuditLog'; const action = 'settings.update_started';"
    ),
    []
  );
});

test("the SQL comment lexer keeps quotes, identifiers and dollar bodies", () => {
  assert.equal(sqlWithoutComments("SELECT '--x' AS a; -- gone\nSELECT 1"), "SELECT '--x' AS a;  \nSELECT 1");
  assert.equal(sqlWithoutComments('SELECT "a--b" FROM t'), 'SELECT "a--b" FROM t');
  assert.equal(sqlWithoutComments("SELECT 'it''s /* not */ a comment'"), "SELECT 'it''s /* not */ a comment'");
  assert.equal(sqlWithoutComments("$$ -- kept $$ x /* a /* b */ c */ y"), "$$ -- kept $$ x   y");
});

test("an allowlisted raw SQL file that gains a statement fails", () => {
  const entry = RAW_SQL_ALLOWLIST.find((candidate) => candidate.path.endsWith(".sql"));
  const original = readFileSync(resolve(ROOT, entry.path), "utf8");
  const clean = checkProtectedTableWriters({
    sources: [{ path: entry.path, text: original }],
  }).filter((finding) => finding.path === entry.path);
  assert.deepEqual(clean, [], "the recorded counts match the file as it stands");

  const extended = checkProtectedTableWriters({
    sources: [{ path: entry.path, text: `${original}\nDELETE FROM "AdminAuditLog";\n` }],
  }).filter((finding) => finding.path === entry.path);
  assert.equal(extended.length, 1);
  assert.equal(extended[0].rule, "raw-sql");
});

test("the listed runtime-SQL spellings are inventoried, in both directions", () => {
  const cases = {
    "lib/new.ts": "await tx.$executeRawUnsafe(sql, ...values)",
    "lib/prisma-raw.ts": "await tx.$queryRaw`SELECT ${Prisma.raw(column)}`",
    "lib/prisma-raw-bracket.ts": 'await tx.$executeRaw(Prisma["raw"](sql))',
    "lib/destructured.ts": "const { $executeRawUnsafe: run } = tx; await run.call(tx, sql);",
    "lib/named-method.ts": 'await tx["$queryRawUnsafe"](sql)',
    "lib/reflect-method.ts": 'await Reflect.get(tx, "$executeRawUnsafe").call(tx, sql)',
    "lib/non-inline.ts": "const statement = build(); await tx.$executeRaw(statement);",
    "lib/extends.ts": "export const extended = prisma.$extends({ model: {} });",
    "lib/driver.ts": 'import { Pool } from "pg"; await new Pool().query(`DELETE FROM "${table}"`);',
    "scripts/driver.cjs": 'const { Client } = require("pg");',
    "scripts/driver-dynamic.mjs": 'const { default: postgres } = await import("postgres");',
  };
  for (const [path, text] of Object.entries(cases)) {
    assertOneFinding(path, text, "runtime-sql");
  }

  assert.deepEqual(
    one(
      "lib/inline.ts",
      [
        'await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"k"}))`',
        'await tx.$executeRaw(Prisma.sql`UPDATE "Other" SET "x" = ${value}`)',
      ].join("\n")
    ),
    []
  );

  const [entry] = RUNTIME_SQL_ALLOWLIST.filter((candidate) => candidate.count > 1);
  const gone = checkProtectedTableWriters({
    sources: [{ path: entry.path, text: "export const nothing = 1;" }],
  }).filter((finding) => finding.path === entry.path);
  assert.equal(gone.length, 1, "an entry whose uses are gone is a finding");
  assert.match(gone[0].detail, /found 0/);

  const extra = checkProtectedTableWriters({
    sources: [
      {
        path: entry.path,
        text: Array.from({ length: entry.count + 1 }, () => "await tx.$queryRawUnsafe(q);").join("\n"),
      },
    ],
  }).filter((finding) => finding.path === entry.path);
  assert.equal(extra.length, 1, "one more use than reviewed is a finding");
});

test("round-2 review probes: assignment destructuring, destructured raw methods, internals", () => {
  assertOneFinding(
    "lib/assign-delegate.ts",
    "let audit; ({ adminAuditLog: audit } = prisma); await audit.create({ data });",
    "delegate-write"
  );
  const runtimeCases = {
    "lib/assign-unsafe.ts": "let run; ({ $executeRawUnsafe: run } = tx); await run.call(tx, sql);",
    "lib/destructured-tagged.ts":
      "const { $executeRaw: run } = tx; const { raw } = Prisma; await run.call(tx, raw(sql));",
    "lib/destructured-extends.ts":
      "const { $extends: extend } = prisma; export const extended = extend.call(prisma, extension);",
    "lib/reflect-tagged.ts": 'await Reflect.get(tx, "$executeRaw").call(tx, statement);',
    "lib/internal-request.ts": "await prisma._request(args);",
    "lib/internal-raw.ts": "await prisma.$executeRawInternal(tx, statement);",
  };
  for (const [path, text] of Object.entries(runtimeCases)) {
    assertOneFinding(path, text, "runtime-sql");
  }
});

test("a type-only driver import is not runtime SQL", () => {
  assert.deepEqual(one("lib/types.ts", 'import type { Pool } from "pg"; export type P = Pool;'), []);
  assert.deepEqual(one("lib/types2.ts", 'import { type Pool } from "pg"; export type P = Pool;'), []);
});

test("a database driver file is pinned by content", () => {
  const entry = RUNTIME_SQL_ALLOWLIST.find((candidate) => candidate.sha256);
  const original = readFileSync(resolve(ROOT, entry.path), "utf8");
  assert.equal(sourceFingerprint(original), entry.sha256, "the pin matches the file as it stands");
  assert.equal(
    sourceFingerprint(original.split("\n").join("\r\n")),
    entry.sha256,
    "line endings do not change the pin"
  );
  const edited = checkProtectedTableWriters({
    sources: [{ path: entry.path, text: `${original}\nawait client.query(getRepairSql());\n` }],
  }).filter((finding) => finding.path === entry.path);
  assert.equal(edited.length, 1);
  assert.match(edited[0].detail, /changed since review/);
});

test("migration SQL: E-strings, numbered dollar tags and dynamic EXECUTE", () => {
  assertOneFinding(
    "prisma/migrations/20990101000000_e/migration.sql",
    "SELECT E'foo\\'--bar'; DELETE FROM \"AdminAuditLog\";",
    "raw-sql"
  );
  assertOneFinding(
    "prisma/migrations/20990101000000_tag/migration.sql",
    "SELECT $body1$--kept$body1$; DELETE FROM \"AdminAuditLog\";",
    "raw-sql"
  );
  assertOneFinding(
    "prisma/migrations/20990101000000_exec/migration.sql",
    "DO $$ BEGIN EXECUTE 'DELETE FROM \"' || 'Admin' || 'AuditLog' || '\"'; END $$;",
    "runtime-sql"
  );
  assert.deepEqual(
    one(
      "prisma/migrations/20990101000000_trigger/migration.sql",
      'CREATE TRIGGER "t" BEFORE INSERT ON "Other" FOR EACH ROW EXECUTE FUNCTION "f"();'
    ),
    []
  );
  assert.equal(
    sqlWithoutComments("SELECT E'a\\'-- not a comment'; -- gone"),
    "SELECT E'a\\'-- not a comment';  "
  );
  assert.equal(sqlWithoutComments("SELECT $x1$ -- kept $x1$"), "SELECT $x1$ -- kept $x1$");
});

test("excluded trees are not scanned, and the self-exclusion is exact", () => {
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
  assertOneFinding(
    "scripts/check-protected-table-writers-extra.mjs",
    "await prisma.adminAuditLog.create({ data })",
    "delegate-write"
  );
});

test("every allowlist and exclusion entry carries a reason and a positive count", () => {
  for (const entry of [
    ...EXCLUDED_PREFIXES,
    ...DELEGATE_NAME_ALLOWLIST,
    ...RAW_SQL_ALLOWLIST,
    ...RUNTIME_SQL_ALLOWLIST,
    ...RETENTION_SETTING_ALLOWLIST,
  ]) {
    assert.ok(typeof entry.reason === "string" && entry.reason.trim().length >= 20, JSON.stringify(entry));
  }
  for (const entry of [
    ...DELEGATE_NAME_ALLOWLIST,
    ...RUNTIME_SQL_ALLOWLIST,
    ...RETENTION_SETTING_ALLOWLIST,
  ]) {
    assert.ok(Number.isInteger(entry.count) && entry.count > 0, JSON.stringify(entry));
  }
  for (const entry of RAW_SQL_ALLOWLIST) {
    assert.ok(entry.tableMentions > 0 && entry.writeVerbs > 0, JSON.stringify(entry));
  }
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

test("naming the retention setting outside the allowlist is a finding", () => {
  // Both spellings, because passing the constant to set_config() needs no
  // literal anywhere and would otherwise be invisible to a text rule.
  assertOneFinding(
    "lib/somethingElse.ts",
    "await tx.$executeRawUnsafe(\"SET LOCAL tomverse.marketing_retention_compaction = 'on'\");",
    "retention-setting"
  );
  assertOneFinding(
    "lib/somethingElse.ts",
    "import { MARKETING_RETENTION_SETTING } from '@/lib/marketingAutomationSchema';",
    "retention-setting"
  );
});

test("a file that does not name the setting is not a finding", () => {
  assert.deepEqual(one("lib/somethingElse.ts", "export const x = 1;"), []);
});

test("the allowlist is exact in both directions", () => {
  // One mention where the allowlist expects two is as much a change as three.
  // Unfiltered on purpose: this fixture *is* an allowlisted path, so the
  // helper that hides real allowlist entries would hide the finding too.
  const findings = checkProtectedTableWriters({
    sources: [
      {
        path: "lib/marketingAutomationSchema.ts",
        text: "const x = 'tomverse.marketing_retention_compaction';",
      },
    ],
  }).filter((finding) => finding.path === "lib/marketingAutomationSchema.ts");
  assert.ok(
    findings.some((finding) => finding.rule === "retention-setting"),
    JSON.stringify(findings)
  );
});

test("the repository passes the check as it stands", () => {
  const result = spawnSync(
    process.execPath,
    [resolve(ROOT, "scripts/check-protected-table-writers.mjs")],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

// The seal rule, in both directions.
//
// `sealMarketingTemplateProof()` mints the Guard's only evidence that a human
// approved these exact words, so who may call it is the difference between a
// post a person approved and a post nobody saw. The first version counted the
// name as a string; every case below is one the review got past it.

const sealSource = (body) => [{ path: "lib/attacker.ts", text: body }];

const SEAL_IMPORT =
  'import { sealMarketingTemplateProof } from "@/lib/marketingGuardCore";\n';

test("the seal rule counts calls, and refuses every way of moving the value", () => {
  const escapes = [
    // The review's own bypass: an alias exported from a file allowed to call
    // it, so the mention count in both files stayed exactly right.
    SEAL_IMPORT + "export const mint = sealMarketingTemplateProof;",
    // The same idea without the export.
    SEAL_IMPORT + "const mint = sealMarketingTemplateProof;\nmint({});",
    // Renamed on the way in, so the call is written under another name.
    'import { sealMarketingTemplateProof as mint } from "@/lib/marketingGuardCore";\nmint({});',
    // Handed on rather than used.
    SEAL_IMPORT + "export { sealMarketingTemplateProof };",
    // Passed as an argument, which puts it wherever the callee keeps it.
    SEAL_IMPORT + "register(sealMarketingTemplateProof);",
    // Through a namespace, which the name-counting rule never saw at all.
    'import * as guard from "@/lib/marketingGuardCore";\nguard.sealMarketingTemplateProof({});',
    // The whole module re-exported, which writes the name down nowhere.
    'export * from "@/lib/marketingGuardCore";',
    'export * as guard from "@/lib/marketingGuardCore";',
    // A second declaration: same name, different function, same effect.
    "export function sealMarketingTemplateProof(proof) {\n  return proof;\n}",
    // A computed key, which puts the name in a string where an identifier rule
    // never looks. The fourth review called the seal through this.
    'import * as guard from "@/lib/marketingGuardCore";\nguard["sealMarketingTemplateProof"]({});',
    'const guard = require("@/lib/marketingGuardCore");\nguard["sealMarketingTemplateProof"]({});',
    'import * as guard from "@/lib/marketingGuardCore";\nconst mint = Reflect.get(guard, "sealMarketingTemplateProof");',
    // The module bound to a name at run time rather than at parse time.
    'const guard = await import("@/lib/marketingGuardCore");\nguard.sealMarketingTemplateProof({});',
    'import guard from "@/lib/marketingGuardCore";\nguard.sealMarketingTemplateProof({});',
    // The module path and the property name held in constants, which is how
    // the fifth review wrote it: every rule was reading an identifier where it
    // wanted a literal, and the file came back with nothing at all.
    'const p = "@/lib/marketingGuardCore";\nconst k = "sealMarketingTemplateProof";\nconst g = await import(p);\ng[k]({});',
    'const p = "@/lib/marketingGuardCore";\nconst k = "sealMarketingTemplateProof";\nconst g = require(p);\ng[k]({});',
    'const k = "sealMarketingTemplateProof";\nimport * as guard from "@/lib/marketingGuardCore";\nconst mint = Reflect.get(guard, k);',
    // The sixth review split both strings with a `+`, which the constant map
    // read as two halves of nothing.
    'const p = "@/lib/" + "marketingGuardCore";\nconst k = "sealMarketing" + "TemplateProof";\nconst g = await import(p);\ng[k]({});',
    'const g = await import(`@/lib/${"marketingGuardCore"}`);\ng["sealMarketingTemplateProof"]({});',
    // Neither half readable: which module and which key are both unknown, and
    // one of the pairs it could be is the seal.
    'const g = await import(`@/lib/${name}`);\ng[key]({});',
    // The eighth review's shape: the name is in the binding pattern rather
    // than in a property access, and the rule was watching the variable.
    'const p = getPath();\nconst k = getKey();\nconst { [k]: mint } = await import(p);\nmint({});',
    'const { ["sealMarketingTemplateProof"]: mint } = await import("@/lib/marketingGuardCore");\nmint({});',
    'const { sealMarketingTemplateProof: mint } = await import("@/lib/marketingGuardCore");\nmint({});',
    // The ninth review's three: the module through a second variable, the
    // assignment form, and a rest binding that hands on every export at once.
    'const g = await import(p);\nconst { [k]: mint } = g;\nmint({});',
    'let mint;\n({ [k]: mint } = await import(p));\nmint({});',
    'const { ...rest } = await import(p);\nrest[k]({});',
    // The tenth review: the same bypass one name along. The computed-access
    // rules were written for the template proof and the facts seal was added
    // beside them rather than into them.
    'const g = await import(p);\ng["sealMarketingFacts"]({});',
    'import * as guard from "@/lib/marketingGuardCore";\nguard["sealMarketingFacts"]({});',
    'import * as guard from "@/lib/marketingGuardCore";\nconst mint = Reflect.get(guard, "sealMarketingFacts");',
    // The eleventh review: a namespace export has an exportClause, and a
    // descriptor or enumeration reaches the value without a member access.
    'import * as guard from "@/lib/marketingGuardCore";\nObject.getOwnPropertyDescriptor(guard, "sealMarketingFacts").value({});',
    'import * as guard from "@/lib/marketingGuardCore";\nObject.getOwnPropertyDescriptor(guard, "sealMarketingTemplateProof").value({});',
    'const guard = await import(p);\nfor (const value of Object.values(guard)) use(value);',
    'const guard = await import(p);\nfor (const key in guard) use(guard[key]);',
    // A third protected mint joins the same list and therefore inherits every
    // escape rule instead of growing a third checker beside the first two.
    'const guard = await import(p);\nguard["sealMarketingGuardContext"]({});',
  ];

  for (const text of escapes) {
    const findings = check(sealSource(text));
    assert.ok(
      findings.some((finding) => finding.rule === "guard-seal"),
      `should be a guard-seal finding: ${JSON.stringify(text)}`
    );
  }
});

test("a direct call is counted, and an allowlisted file may make exactly its own", () => {
  const unlisted = check(
    sealSource(SEAL_IMPORT + "export const proof = sealMarketingTemplateProof({});")
  );
  assert.equal(
    unlisted.filter((finding) => finding.rule === "guard-seal").length,
    1,
    JSON.stringify(unlisted)
  );

  const listed = PROTECTED_EXPORT_ALLOWLIST.find(
    (entry) => entry.name === "sealMarketingTemplateProof",
  );
  const sealFindings = (text) =>
    checkProtectedTableWriters({
      sources: [{ path: listed.path, text }],
    }).filter(
      (finding) =>
        finding.rule === "guard-seal" && finding.path === listed.path,
    );

  assert.deepEqual(
    sealFindings(SEAL_IMPORT + "export const proof = sealMarketingTemplateProof({});"),
    []
  );

  const overTheLimit = sealFindings(
    SEAL_IMPORT +
      "export const a = sealMarketingTemplateProof({});\n" +
      "export const b = sealMarketingTemplateProof({});"
  );
  assert.equal(overTheLimit.length, 1, JSON.stringify(overTheLimit));
});

test("mentioning the seal without calling it is not a finding", () => {
  // A comment and a string are not calls, and a rule that fired on them would
  // be switched off by whoever wrote the next comment.
  const quiet = check(
    sealSource(
      "// sealMarketingTemplateProof is documented here.\n" +
        'const name = "sealMarketingTemplateProof";\n' +
        "export const note = name;"
    )
  );
  assert.deepEqual(
    quiet.filter((finding) => finding.rule === "guard-seal"),
    []
  );
});

test("the declaring file may declare it and is not required to call it", () => {
  const declared = checkProtectedTableWriters({
    sources: [
      {
        path: "lib/marketingGuardCore.ts",
        text: "export function sealMarketingTemplateProof(proof) {\n  return proof;\n}",
      },
    ],
  }).filter(
    (finding) =>
      finding.rule === "guard-seal" &&
      finding.path === "lib/marketingGuardCore.ts"
  );
  assert.deepEqual(declared, [], JSON.stringify(declared));
});

test("a computed key on an unreadable module is refused, and named files are not", () => {
  // The text in front of a hole fixes nothing: `@/locales/${segment}` reaches
  // this module when `segment` is `../lib/marketingGuardCore`, and the first
  // version of this rule read the prefix as a fence. So every unreadable
  // specifier is possible...
  const loader =
    "const bundle = await import(`../locales/${locale}.ts`);\n" +
    "export const strings = bundle[locale];";

  const findings = check(sealSource(loader));
  assert.ok(
    findings.some((finding) => finding.rule === "guard-seal"),
    JSON.stringify(findings)
  );

  // ...and the two files that legitimately do this are named, which is a
  // decision somebody wrote down rather than a shape somebody guessed.
  for (const path of TEMPLATE_SEAL_DYNAMIC_KEY_ALLOWLIST) {
    const quiet = checkProtectedTableWriters({
      sources: [{ path, text: loader }],
    }).filter(
      (finding) => finding.rule === "guard-seal" && finding.path === path
    );
    assert.deepEqual(quiet, [], path);
  }
});

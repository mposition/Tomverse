import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Guards the properties that make the migration history able to build a
 * database from empty.
 *
 * It could not, for a year: 20260704131220_init created only "Conversation"
 * and "Message", so every later migration that touched a `db push`-created
 * table failed on an empty database. Nothing caught it, because the test
 * database was built with `db push` too and deployments only ever ran against
 * databases that already had the tables.
 *
 * The DB integration suite now builds from `migrate deploy` and asserts no
 * drift, which is the real proof. These assertions are the cheap ones that run
 * everywhere and fail with an explanation rather than a Postgres error.
 */

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "prisma", "migrations");
const ARCHIVE = join(ROOT, "prisma", "migrations-archive");
const BASELINE = "00000000000000_baseline";

const migrationNames = () =>
  readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

test("the baseline is the first migration Prisma applies", () => {
  const names = migrationNames();
  assert.ok(names.includes(BASELINE), `${BASELINE} is missing`);
  // Prisma applies migrations in lexicographic order, so a baseline that does
  // not sort first would run after migrations that assume it.
  assert.equal(
    names[0],
    BASELINE,
    `${BASELINE} must sort first; found ${names[0]}`
  );
});

test("the baseline carries the CHECK constraints schema.prisma cannot express", () => {
  // `prisma migrate diff --from-empty --to-schema` does not emit CHECK
  // constraints, and `migrate diff` cannot see them drift either. Regenerating
  // the baseline from the schema alone would drop all ten silently, so they
  // are named here.
  const sql = readFileSync(join(MIGRATIONS, BASELINE, "migration.sql"), "utf8");
  const required = [
    "User_plan_check",
    "ProviderCreditConfig_creditMicroUsd_nonnegative",
    "ProviderCreditConfig_usageBaselineMicroUsd_nonnegative",
    "ProductAnalyticsEvent_source_check",
    "ProductAnalyticsEvent_name_check",
    "ProductAnalyticsEvent_modelCount_check",
    "ProductAnalyticsEvent_language_check",
    "ProductAnalyticsEvent_country_check",
    "ProductAnalyticsEvent_plan_check",
    "ModelRegistryEntry_provider_connection_allowlist_check",
  ];
  for (const name of required) {
    assert.ok(
      sql.includes(`"${name}"`),
      `the baseline no longer creates ${name}`
    );
  }
});

test("the replaced history is kept, and kept out of Prisma's way", () => {
  const archived = readdirSync(ARCHIVE, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory()
  );
  // The archive is the record of how the schema actually got here; the CHECK
  // constraints above were recovered from it.
  assert.ok(
    archived.length >= 78,
    `expected the 78 replaced migrations to remain archived, found ${archived.length}`
  );
  // Prisma reads only `migrations.path` from prisma.config.ts. If the archive
  // ever moved under it, deploys would try to replay a history that cannot run.
  const config = readFileSync(join(ROOT, "prisma.config.ts"), "utf8");
  assert.ok(
    /path:\s*"prisma\/migrations"/.test(config),
    "prisma.config.ts must point migrations.path at prisma/migrations"
  );
});

test("the integration database is built from migrations by default", () => {
  // CHECK constraints are not the only thing schema.prisma cannot express.
  // `PlanChangeRequest_userId_active_key` is a partial unique index -- the only
  // thing stopping two racing confirms from both reserving a plan change --
  // and it exists solely in a migration. A `db push` database does not have
  // it, which is how its own regression test came to fail on develop.
  //
  // So the default matters: flipping this back to `push` would quietly drop
  // every partial index and CHECK constraint in the schema, and the suite
  // would keep reporting green for the ones nothing tests.
  const runner = readFileSync(
    join(ROOT, "scripts", "run-db-integration-tests.mjs"),
    "utf8"
  );
  assert.ok(
    /DB_INTEGRATION_SCHEMA_SOURCE\s*\|\|\s*"migrations"/.test(runner),
    "the DB integration runner must default to building from migrations"
  );
  assert.ok(
    runner.includes('"migrate", "deploy"') &&
      runner.includes('"--exit-code"'),
    "the migrations path must run migrate deploy and then assert no drift"
  );
});

test("the baseline guard decides from the schema, not from the history", () => {
  // The bug a restore drill found: the guard read `_prisma_migrations` first
  // and called an empty history "fresh". A `prisma db push` database has a
  // complete schema and an empty history, so it was sent into `migrate deploy`
  // and failed on `relation "User" already exists` -- leaving a failed row that
  // blocks every later deploy.
  const guard = readFileSync(
    join(ROOT, "scripts", "baseline-existing-database.mjs"),
    "utf8"
  );
  const schemaProbe = guard.indexOf(`to_regclass('public."User"')`);
  const historyProbe = guard.indexOf("to_regclass('public._prisma_migrations')");
  assert.ok(schemaProbe > 0 && historyProbe > 0, "both probes must exist");
  assert.ok(
    schemaProbe < historyProbe,
    "the guard must check for the schema before reading the migration history"
  );
  // And the ambiguous restore -- a current schema beside an older history --
  // must refuse rather than let deploy poison the history.
  assert.ok(
    guard.includes("schemaMatchesPrisma"),
    "the guard must detect a schema that already matches schema.prisma"
  );
});

test("deployments baseline a pre-existing database before applying migrations", () => {
  const scripts = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8")
  ).scripts;
  const migrate = scripts["db:migrate"];
  assert.ok(
    migrate.includes("baseline-existing-database.mjs"),
    "db:migrate must run the baseline guard"
  );
  // Order matters: a database that predates the baseline has to be marked
  // before deploy tries to apply it, or deploy fails on `relation "User"
  // already exists` and blocks every later deployment.
  //
  // The deploy step is `scripts/run-prisma-migrate-deploy.mjs`, which retries a
  // database it could not reach; matching either spelling keeps this about the
  // order rather than about how the step is spelled.
  const deployStep = migrate.search(
    /run-prisma-migrate-deploy\.mjs|prisma\s+migrate\s+deploy/
  );
  assert.ok(deployStep >= 0, "db:migrate must run the deploy step");
  assert.ok(
    migrate.indexOf("baseline-existing-database.mjs") < deployStep,
    "the baseline guard must run before the deploy step"
  );
});

// ---------------------------------------------------------------------------
// Migrations `migrate diff` cannot see (2026-10-02)
// ---------------------------------------------------------------------------
//
// The first migration to ship on its own with nothing schema.prisma describes
// -- a partial expression index -- was refused by the guard on staging: the
// database "matched" schema.prisma before it was applied, which is what the
// guard reads as a restore that already holds it. Such a migration now declares
// a presence probe, and the guard proceeds only when every probe proves absence.

test("a migration names one relation in its header, or declares nothing", async () => {
  const { presenceDeclarationIn } = await import("../scripts/baseline-presence-core.mjs");
  assert.deepEqual(
    presenceDeclarationIn(`-- intro
--
-- baseline-check: present-if-relation "X_key"

CREATE INDEX x;`),
    { kind: "relation", relation: "X_key" },
  );
  assert.deepEqual(presenceDeclarationIn("CREATE INDEX x;"), { kind: "none" });
  // A function is not a relation; it has its own declaration and question.
  assert.deepEqual(
    presenceDeclarationIn(`-- baseline-check: present-if-function "f_x"
CREATE FUNCTION f_x();`),
    { kind: "function", function: "f_x" },
  );
  const digest = "a".repeat(64);
  assert.deepEqual(
    presenceDeclarationIn(`-- baseline-check: replace-function-if-body-sha256 "f_x" "${digest}"
CREATE OR REPLACE FUNCTION f_x();`),
    { kind: "function-replacement", function: "f_x", previousBodySha256: digest },
  );
  assert.deepEqual(
    presenceDeclarationIn(`-- baseline-check: replace-function-if-body-sha256 "f_x(text,text)" "${digest}"
CREATE OR REPLACE FUNCTION f_x(text, text);`),
    { kind: "function-replacement", function: "f_x", functionArgs: ["text", "text"],
      previousBodySha256: digest },
  );
  for (const [label, sql] of [
    // SQL instead of a name: the guard asks its own fixed question, so a
    // declaration that tries to supply one is not a declaration at all.
    ["sql", `-- baseline-check: present-if SELECT dblink_exec('x', 'DELETE FROM "User"')
CREATE INDEX x;`],
    ["two", `-- baseline-check: present-if-relation "A"
-- baseline-check: present-if-relation "B"
CREATE INDEX x;`],
    ["quoted inside", `-- baseline-check: present-if-relation "a\"b"
CREATE INDEX x;`],
    ["schema-qualified", `-- baseline-check: present-if-relation "other.X"
CREATE INDEX x;`],
    ["unknown kind", `-- baseline-check: present-if-trigger "T"
CREATE INDEX x;`],
    ["function schema-qualified", `-- baseline-check: present-if-function "other.f"
CREATE INDEX x;`],
    ["replacement bad digest", `-- baseline-check: replace-function-if-body-sha256 "f_x" "abc"
CREATE INDEX x;`],
    ["replacement schema-qualified", `-- baseline-check: replace-function-if-body-sha256 "other.f" "${digest}"
CREATE INDEX x;`],
    ["replacement unsafe signature", `-- baseline-check: replace-function-if-body-sha256 "f_x(text);DELETE" "${digest}"
CREATE INDEX x;`],
    ["too long", `-- baseline-check: present-if-relation "${"a".repeat(64)}"
CREATE INDEX x;`],
  ]) {
    assert.deepEqual(presenceDeclarationIn(sql), { kind: "invalid" }, label);
  }
  // Only the header counts: a declaration after the first statement -- in a
  // function body, say -- is not one.
  assert.deepEqual(
    presenceDeclarationIn(`CREATE FUNCTION f() AS $$
-- baseline-check: present-if-relation "X"
$$;`),
    { kind: "none" },
  );
});

test("the guard asks one fixed question with the name bound, and accepts one boolean", async () => {
  const { presenceQuery, presenceAnswer } = await import("../scripts/baseline-presence-core.mjs");
  assert.deepEqual(presenceQuery("X_key"), {
    text: 'SELECT to_regclass($1) IS NOT NULL AS "present"',
    values: ['public."X_key"'],
    rowMode: "array",
  });
  const { functionPresenceQuery, presenceQueryFor } = await import("../scripts/baseline-presence-core.mjs");
  const fn = functionPresenceQuery("f_x");
  assert.deepEqual(fn, {
    text: "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1) AS \"present\"",
    values: ["f_x"],
    rowMode: "array",
  });
  assert.deepEqual(presenceQueryFor({ name: "m", function: "f_x" }), fn);
  assert.deepEqual(presenceQueryFor({ name: "m", relation: "X_key" }), presenceQuery("X_key"));
  const { functionBodyQuery, replacementAnswer } = await import("../scripts/baseline-presence-core.mjs");
  assert.deepEqual(presenceQueryFor({ name: "m", function: "f_x", previousBodySha256: "a".repeat(64) }), functionBodyQuery("f_x"));
  assert.deepEqual(functionBodyQuery("f_x").values, ["f_x"]);
  assert.match(functionBodyQuery("f_x").text, /p\.pronargs = 0/);
  const typed = functionBodyQuery("f_x", ["text", "text"]);
  assert.deepEqual(typed.values, ["f_x", 'public."f_x"(text,text)']);
  assert.match(typed.text, /pg_catalog\.to_regprocedure\(\$2\)/);
  assert.deepEqual(presenceQueryFor({ name: "m", function: "f_x",
    functionArgs: ["text", "text"], previousBodySha256: "a".repeat(64) }), typed);
  const oldBody = "BEGIN RETURN NEW; END;";
  const oldHash = createHash("sha256").update(oldBody).digest("hex");
  assert.equal(replacementAnswer([[oldBody]], oldHash), false);
  assert.equal(replacementAnswer([["changed"]], oldHash), true);
  for (const rows of [[], [[oldBody], [oldBody]], [[null]], [[false]], undefined]) {
    assert.equal(replacementAnswer(rows, oldHash), undefined, JSON.stringify(rows));
  }
  assert.equal(presenceAnswer([[false]]), false);
  assert.equal(presenceAnswer([[true]]), true);
  for (const rows of [[], [[false], [false]], [[false, true]], [["f"]], [[null]], undefined]) {
    assert.equal(presenceAnswer(rows), undefined, JSON.stringify(rows));
  }
});

test("a checksum-bound sidecar names every CHECK replacement without changing migration SQL", async () => {
  const {
    canonicalMigrationSqlSha256,
    pendingProbes,
    replacedCheckTargetsIn,
    supplementalProofIn,
  } = await import("../scripts/baseline-presence-core.mjs");
  const name = "20261008130000_amux_v4_claim_owner_resolution";
  const directory = join(MIGRATIONS, name);
  const sql = readFileSync(join(directory, "migration.sql"), "utf8");
  const proofText = readFileSync(join(directory, "baseline-check.json"), "utf8");
  const proof = JSON.parse(proofText);
  const targets = [
    {
      table: "AmuxIdeaAnalysisBudgetHold",
      constraint: "AmuxIdeaAnalysisBudgetHold_status_check",
    },
    {
      table: "AmuxIdeaAnalysisBudgetHold",
      constraint: "AmuxIdeaAnalysisBudgetHold_lifecycle_check",
    },
    {
      table: "AmuxIdeaTransferPreview",
      constraint: "AmuxIdeaTransferPreview_state_check",
    },
    {
      table: "AmuxIdeaTransferPreview",
      constraint: "AmuxIdeaTransferPreview_state_confirm_check",
    },
  ];
  const expected = targets.map((target, index) => ({
    ...target,
    previousDefinitionSha256: proof.replacedChecks[index].previousDefinitionSha256,
  }));

  assert.equal(canonicalMigrationSqlSha256(sql), proof.migrationSqlSha256);
  assert.equal(
    canonicalMigrationSqlSha256(sql.replaceAll("\n", "\r\n")),
    proof.migrationSqlSha256,
    "checkout CRLF conversion must not invalidate the proof",
  );
  assert.notEqual(
    canonicalMigrationSqlSha256(`${sql} `),
    proof.migrationSqlSha256,
    "no other SQL change may retain the proof",
  );
  assert.deepEqual(replacedCheckTargetsIn(sql), {
    kind: "check-replacement",
    checks: targets,
  });
  assert.deepEqual(supplementalProofIn(sql, proofText), {
    kind: "check-replacement",
    checks: expected,
  });
  assert.deepEqual(
    pendingProbes([name], () => sql, () => proofText),
    { probes: [{ name, replacedChecks: expected }], undeclared: [] },
  );
});

test("CHECK replacement sidecars reject unbound, partial, ambiguous, and mixed declarations", async () => {
  const {
    canonicalMigrationSqlSha256,
    pendingProbes,
    replacedCheckTargetsIn,
    supplementalProofIn,
  } = await import("../scripts/baseline-presence-core.mjs");
  const directory = join(MIGRATIONS, "20261008130000_amux_v4_claim_owner_resolution");
  const sql = readFileSync(join(directory, "migration.sql"), "utf8");
  const proof = JSON.parse(readFileSync(join(directory, "baseline-check.json"), "utf8"));
  const encoded = (value) => JSON.stringify(value);
  const invalid = [
    ["malformed JSON", "{"],
    ["changed SQL", encoded(proof), `${sql} `],
    ["partial list", encoded({ ...proof, replacedChecks: proof.replacedChecks.slice(0, -1) })],
    ["unknown target", encoded({
      ...proof,
      replacedChecks: proof.replacedChecks.map((entry, index) =>
        index === 0 ? { ...entry, constraint: "Unknown_check" } : entry),
    })],
    ["extra registry field", encoded({ ...proof, query: "SELECT true" })],
  ];
  for (const [label, proofText, candidateSql = sql] of invalid) {
    assert.deepEqual(supplementalProofIn(candidateSql, proofText), { kind: "invalid" }, label);
  }
  assert.deepEqual(supplementalProofIn(sql, undefined), { kind: "none" });

  const ambiguousSql = `ALTER TABLE "T"
    DROP CONSTRAINT "old_check",
    ADD CONSTRAINT "new_check" CHECK (true);\n`;
  const ambiguousProof = encoded({
    version: 1,
    migrationSqlSha256: canonicalMigrationSqlSha256(ambiguousSql),
    replacedChecks: [],
  });
  assert.deepEqual(supplementalProofIn(ambiguousSql, ambiguousProof), { kind: "invalid" });

  const mixedSql = `${sql}\nCREATE TABLE "AlreadyPresent" ("id" TEXT PRIMARY KEY);\n`;
  const mixedSqlProof = encoded({
    ...proof,
    migrationSqlSha256: canonicalMigrationSqlSha256(mixedSql),
  });
  assert.deepEqual(
    supplementalProofIn(mixedSql, mixedSqlProof),
    { kind: "invalid" },
    "the CHECK proof cannot excuse any other pending DDL",
  );

  const oneReplacement = `ALTER TABLE "T"
    DROP CONSTRAINT "T_state_check",
    ADD CONSTRAINT "T_state_check" CHECK ("state" IN ('a', 'b'));`;
  assert.deepEqual(replacedCheckTargetsIn(oneReplacement), {
    kind: "check-replacement",
    checks: [{ table: "T", constraint: "T_state_check" }],
  });
  for (const [label, suffix] of [
    ["ADD COLUMN", `, ADD COLUMN "extra" TEXT`],
    ["RENAME", `, RENAME COLUMN "state" TO "other"`],
    ["ENABLE TRIGGER", `, ENABLE TRIGGER "guard"`],
  ]) {
    const withExtraAction = oneReplacement.replace(/;$/, `${suffix};`);
    assert.deepEqual(
      replacedCheckTargetsIn(withExtraAction),
      { kind: "invalid" },
      `the sidecar does not prove an ${label} action in the same ALTER TABLE`,
    );
  }
  const quotedFake = `SELECT 'ALTER TABLE "T" DROP CONSTRAINT "T_state_check", ` +
    `ADD CONSTRAINT "T_state_check" CHECK (true);';`;
  assert.deepEqual(replacedCheckTargetsIn(quotedFake), { kind: "invalid" });
  assert.deepEqual(
    replacedCheckTargetsIn(`-- ${oneReplacement.replaceAll("\n", " ")}\n`),
    { kind: "none" },
    "DDL written only in a comment is not a replacement",
  );
  assert.deepEqual(
    replacedCheckTargetsIn(`DO $$ BEGIN EXECUTE '${oneReplacement}'; END $$;`),
    { kind: "invalid" },
    "procedural and dollar-quoted SQL is outside the approved sidecar grammar",
  );

  const headerSql = `-- baseline-check: present-if-relation "X"\n${sql}`;
  const headerProof = encoded({
    ...proof,
    migrationSqlSha256: canonicalMigrationSqlSha256(headerSql),
  });
  assert.deepEqual(
    pendingProbes(["mixed"], () => headerSql, () => headerProof),
    { probes: [], undeclared: ["mixed"] },
  );
});

test("CHECK replacement probes use a fixed read-only catalog question and fail closed", async () => {
  const {
    checkDefinitionQuery,
    checkReplacementAnswer,
    checkReplacementSetAnswer,
    presenceVerdict,
  } = await import("../scripts/baseline-presence-core.mjs");
  const target = { table: "T", constraint: "T_state_check" };
  const query = checkDefinitionQuery(target);
  assert.deepEqual(query.values, ["T", "T_state_check"]);
  assert.equal(query.rowMode, "array");
  assert.match(query.text, /pg_catalog\.pg_get_constraintdef\(c\.oid, false\)/);
  assert.match(query.text, /n\.nspname = 'public'/);
  assert.match(query.text, /c\.contype = 'c'/);
  assert.doesNotMatch(query.text, /T_state_check|\bT\b/);

  const prior = "CHECK ((status = 'reserved'::text) IS TRUE)";
  const priorDigest = createHash("sha256").update(prior).digest("hex");
  assert.equal(checkReplacementAnswer([[prior]], priorDigest), false);
  assert.equal(checkReplacementAnswer([[`${prior} `]], priorDigest), true);
  for (const rows of [[], [[prior], [prior]], [[null]], [[false]], undefined]) {
    assert.equal(checkReplacementAnswer(rows, priorDigest), undefined, JSON.stringify(rows));
  }
  assert.equal(checkReplacementSetAnswer([false, false, false, false]), false);
  assert.equal(checkReplacementSetAnswer([false, true, false, false]), true);
  assert.equal(checkReplacementSetAnswer([false, undefined, false, false]), undefined);
  assert.equal(checkReplacementSetAnswer([]), undefined);
  assert.equal(presenceVerdict(["m"], new Map([["m", false]])).proceed, true);
  for (const answer of [true, undefined]) {
    assert.deepEqual(
      presenceVerdict(["m"], new Map([["m", answer]])),
      { proceed: false, notProvenAbsent: ["m"] },
    );
  }
});

test("the guard proceeds only when every pending migration proves absence", async () => {
  const { pendingProbes, presenceVerdict } = await import("../scripts/baseline-presence-core.mjs");
  const sql = {
    a: `-- baseline-check: present-if-relation "A"\nCREATE INDEX a;`,
    b: `-- baseline-check: present-if-relation "B"\nCREATE INDEX b;`,
    c: "CREATE INDEX c;",
    f: `-- baseline-check: present-if-function "F"
CREATE FUNCTION f();`,
    r: `-- baseline-check: replace-function-if-body-sha256 "R" "${"a".repeat(64)}"
CREATE OR REPLACE FUNCTION r();`,
  };
  assert.deepEqual(pendingProbes(["a", "f"], (name) => sql[name]), {
    probes: [{ name: "a", relation: "A" }, { name: "f", function: "F" }],
    undeclared: [],
  });
  assert.deepEqual(pendingProbes(["r"], (name) => sql[name]), {
    probes: [{ name: "r", function: "R", previousBodySha256: "a".repeat(64) }],
    undeclared: [],
  });
  assert.deepEqual(pendingProbes(["a", "c"], (name) => sql[name]).undeclared, ["c"]);
  assert.deepEqual(pendingProbes(["a", "b"], (name) => sql[name]).probes, [
    { name: "a", relation: "A" },
    { name: "b", relation: "B" },
  ]);
  assert.equal(presenceVerdict(["a", "b"], new Map([["a", false], ["b", false]])).proceed, true);
  for (const answer of [true, null, undefined, "f", 0]) {
    const verdict = presenceVerdict(["a", "b"], new Map([["a", false], ["b", answer]]));
    assert.equal(verdict.proceed, false, String(answer));
    assert.deepEqual(verdict.notProvenAbsent, ["b"]);
  }
});

test("the guard reads probes only on the refusal path, read-only and rolled back", () => {
  const guard = readFileSync(join(ROOT, "scripts", "baseline-existing-database.mjs"), "utf8");
  const match = guard.indexOf("schemaMatchesPrisma()) {");
  const probe = guard.indexOf("pendingProbes(", match);
  // The query the guard runs is the core's fixed one, never a migration's text.
  assert.ok(guard.includes("client.query(presenceQueryFor(probe))"));
  assert.ok(guard.includes("replacementAnswer(rows, probe.previousBodySha256)"));
  const readOnly = guard.indexOf('"BEGIN READ ONLY"', probe);
  const repeatableRead = guard.indexOf(
    '"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"',
    probe,
  );
  const rollback = guard.indexOf('"ROLLBACK"', readOnly);
  assert.ok(
    match > 0 && probe > match && readOnly > probe &&
      repeatableRead > probe && rollback > readOnly,
  );
  // An undeclared migration still meets the original refusal.
  assert.ok(guard.includes("undeclared,"));
});

test("the AMUX chunk deadline migration pins the exact previous function body", async () => {
  const { presenceDeclarationIn } = await import("../scripts/baseline-presence-core.mjs");
  const sql = readFileSync(
    join(MIGRATIONS, "20261003130000_amux_v4_chunk_completion_deadline", "migration.sql"),
    "utf8",
  );
  const previousSql = readFileSync(
    join(MIGRATIONS, "20261001102300_amux_v4_draft_units", "migration.sql"),
    "utf8",
  );
  const previousBody = /CREATE FUNCTION amux_v4_chunk_completion_immutable\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$/.exec(previousSql)?.[1];
  assert.ok(previousBody);
  const created = /CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?"?([a-z0-9_]+)"?\(/i.exec(sql)?.[1];
  assert.deepEqual(presenceDeclarationIn(sql), {
    kind: "function-replacement",
    function: created,
    previousBodySha256: createHash("sha256").update(previousBody).digest("hex"),
  });
});
test("the AMUX unit actor replacement pins its five-text-argument predecessor", async () => {
  const { presenceDeclarationIn, pendingProbes } = await import("../scripts/baseline-presence-core.mjs");
  const sql = readFileSync(join(MIGRATIONS,
    "20261005090000_amux_v4_unit_actor_scope", "migration.sql"), "utf8");
  const previousSql = readFileSync(join(MIGRATIONS,
    "20261001102600_amux_v4_unit_decisions", "migration.sql"), "utf8");
  const previousBody = /CREATE FUNCTION amux_v4_unit_audit_matches\([\s\S]*?AS \$\$([\s\S]*?)\$\$/.exec(previousSql)?.[1];
  assert.ok(previousBody);
  const declaration = {
    kind: "function-replacement",
    function: "amux_v4_unit_audit_matches",
    functionArgs: ["text", "text", "text", "text", "text"],
    previousBodySha256: createHash("sha256").update(previousBody).digest("hex"),
  };
  assert.deepEqual(presenceDeclarationIn(sql), declaration);
  assert.deepEqual(pendingProbes(["replacement"], () => sql), {
    probes: [{ name: "replacement", function: declaration.function,
      functionArgs: declaration.functionArgs,
      previousBodySha256: declaration.previousBodySha256 }], undeclared: [],
  });
});

test("the Decision Maker switch isolation check pins the S1b switch guard body", async () => {
  const { presenceDeclarationIn } = await import("../scripts/baseline-presence-core.mjs");
  const sql = readFileSync(
    join(MIGRATIONS, "20261008090000_amux_decision_maker_switch_serialization", "migration.sql"),
    "utf8",
  );
  const previousSql = readFileSync(
    join(MIGRATIONS, "20261008030000_amux_decision_maker_switch", "migration.sql"),
    "utf8",
  );
  const previousBody = /CREATE OR REPLACE FUNCTION "amux_decision_maker_switch_event_guard"\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$/.exec(previousSql)?.[1];
  assert.ok(previousBody);
  assert.deepEqual(presenceDeclarationIn(sql), {
    kind: "function-replacement",
    function: "amux_decision_maker_switch_event_guard",
    previousBodySha256: createHash("sha256").update(previousBody).digest("hex"),
  });
  // No migration between the two redefines the function.
  const between = readdirSync(MIGRATIONS)
    .filter(
      (name) =>
        name > "20261008030000_amux_decision_maker_switch" &&
        name < "20261008090000_amux_decision_maker_switch_serialization",
    )
    .filter((name) => {
      try {
        return /FUNCTION "amux_decision_maker_switch_event_guard"\(/.test(
          readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"),
        );
      } catch {
        return false;
      }
    });
  assert.deepEqual(between, []);
});

test("the Decision Maker stale-close interval pins the S1c request event guard body", async () => {
  const { presenceDeclarationIn } = await import("../scripts/baseline-presence-core.mjs");
  const sql = readFileSync(
    join(MIGRATIONS, "20261008130000_amux_decision_maker_stale_close_hours", "migration.sql"),
    "utf8",
  );
  const previousSql = readFileSync(
    join(MIGRATIONS, "20261008090100_amux_decision_maker_request_ledger", "migration.sql"),
    "utf8",
  );
  const previousBody = /CREATE OR REPLACE FUNCTION "amux_decision_maker_request_event_guard"\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$/.exec(previousSql)?.[1];
  assert.ok(previousBody);
  assert.deepEqual(presenceDeclarationIn(sql), {
    kind: "function-replacement",
    function: "amux_decision_maker_request_event_guard",
    previousBodySha256: createHash("sha256").update(previousBody).digest("hex"),
  });
  // No migration between the two redefines the function.
  const between = readdirSync(MIGRATIONS)
    .filter(
      (name) =>
        name > "20261008090100_amux_decision_maker_request_ledger" &&
        name < "20261008130000_amux_decision_maker_stale_close_hours",
    )
    .filter((name) => {
      try {
        return /FUNCTION "amux_decision_maker_request_event_guard"\(/.test(
          readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"),
        );
      } catch {
        return false;
      }
    });
  assert.deepEqual(between, []);
});

test("the sre-ops digest registration pins the billing migration's insert trigger body", async () => {
  const { presenceDeclarationIn } = await import("../scripts/baseline-presence-core.mjs");
  const sql = readFileSync(join(MIGRATIONS, "20261008010000_agent_digest_sre_ops", "migration.sql"), "utf8");
  // The body this replacement may overwrite is the last definition before it:
  // 20261004000000_agent_digest_billing_finance_ops, which itself replaced the
  // first migration's.
  const previousSql = readFileSync(
    join(MIGRATIONS, "20261004000000_agent_digest_billing_finance_ops", "migration.sql"),
    "utf8",
  );
  const previousBody = /FUNCTION agent_digest_item_before_insert\(\) RETURNS trigger[\s\S]*?AS \$\$([\s\S]*?)\$\$/.exec(previousSql)?.[1];
  assert.ok(previousBody);
  assert.deepEqual(presenceDeclarationIn(sql), {
    kind: "function-replacement",
    function: "agent_digest_item_before_insert",
    previousBodySha256: createHash("sha256").update(previousBody).digest("hex"),
  });
  // No migration between the two redefines the function.
  const between = readdirSync(MIGRATIONS)
    .filter((name) => name > "20261004000000_agent_digest_billing_finance_ops" && name < "20261008010000_agent_digest_sre_ops")
    .filter((name) => {
      try {
        return /FUNCTION agent_digest_item_before_insert\(/.test(readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"));
      } catch {
        return false;
      }
    });
  assert.deepEqual(between, []);
});

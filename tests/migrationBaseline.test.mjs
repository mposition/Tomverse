import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

test("the webhook shadow index migration names its own index", async () => {
  const { presenceDeclarationIn } = await import("../scripts/baseline-presence-core.mjs");
  const sql = readFileSync(
    join(MIGRATIONS, "20261002120000_marketing_webhook_shadow_event_unique", "migration.sql"),
    "utf8",
  );
  const declaration = presenceDeclarationIn(sql);
  const index = /CREATE UNIQUE INDEX "([^"]+)"/.exec(sql)?.[1];
  assert.deepEqual(declaration, { kind: "relation", relation: index });
});

test("a migration that creates only a function names that function", async () => {
  const { presenceDeclarationIn } = await import("../scripts/baseline-presence-core.mjs");
  const sql = readFileSync(
    join(MIGRATIONS, "20261003130000_support_triage_arm_timeouts", "migration.sql"),
    "utf8",
  );
  const created = /CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?"?([a-z0-9_]+)"?\(/i.exec(sql)?.[1];
  assert.deepEqual(presenceDeclarationIn(sql), { kind: "function", function: created });
});

test("the B07 v5 stage guard is detectable before migration deployment", async () => {
  const { presenceDeclarationIn } = await import("../scripts/baseline-presence-core.mjs");
  const sql = readFileSync(join(MIGRATIONS,
    "20261006160000_prompt_refiner_one_shot_post_unknown_v5", "migration.sql"),
  "utf8");
  const created = /CREATE FUNCTION "([a-z0-9_]+)"\(/.exec(sql)?.[1];
  assert.deepEqual(presenceDeclarationIn(sql), {
    kind: "function", function: created,
  });
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

test("the B06 v3 recovery migration pins the deployed v2 supersession function", async () => {
  const { presenceDeclarationIn } = await import("../scripts/baseline-presence-core.mjs");
  const sql = readFileSync(
    join(MIGRATIONS, "20261005210000_prompt_refiner_one_shot_run_approved_recovery", "migration.sql"),
    "utf8",
  );
  const previousSql = readFileSync(
    join(MIGRATIONS, "20261005140000_prompt_refiner_one_shot_unrun_replacement", "migration.sql"),
    "utf8",
  );
  const previousBody = /CREATE FUNCTION "prompt_refiner_vnext_one_shot_supersession_guard"\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$/.exec(previousSql)?.[1];
  assert.ok(previousBody);
  assert.deepEqual(presenceDeclarationIn(sql), {
    kind: "function-replacement",
    function: "prompt_refiner_vnext_one_shot_supersession_guard",
    previousBodySha256: createHash("sha256").update(previousBody).digest("hex"),
  });
});

/**
 * Every migration whose only effect the diff cannot see, swept -- not one named
 * migration at a time.
 *
 * The tests above each name one migration by path, so each was written after a
 * staging deploy had already stopped on that migration. That happened three
 * times: 20261002120000 (a partial index, 2026-10-02), 20261003130000 (a
 * function, 2026-10-03) and 20261005030000 (a function and a constraint
 * trigger, 2026-10-07, PR #2116). Each time the merge was green, the pre-deploy
 * baseline guard refused, and the fix was one comment line. Nothing in the gate
 * asked the question before the merge, so the fourth one would have cost
 * another blocked deploy.
 *
 * What this sweep asks: a migration that creates a function, a trigger, or an
 * index `schema.prisma` cannot express, and nothing it can, must carry exactly
 * one valid presence declaration.
 *
 * **An index counts as described only when its key list is plain.** A partial
 * index (`WHERE`) and an expression index (`lower("c")`) are both invisible to
 * the diff, and `present-if-relation` can probe either, so both need a
 * declaration. The first draft of this sweep read any index without `WHERE` as
 * described, which let an expression-index-only migration through undeclared --
 * the exact class the sweep exists to catch. Anything the key-list test cannot
 * recognise is treated as not described, because a needless declaration costs a
 * comment line and a missing one costs a blocked deploy.
 *
 * **A comment, a string literal and a function body are not statements.** The
 * detector removes all three before reading, and statementsOf below records the
 * two drafts that got that wrong.
 *
 * A newly added CHECK cannot be proven absent safely, so it stays out of this
 * declaration sweep and keeps the guard's original refusal. A CHECK replaced
 * under the same table/name can prove the exact prior definition through the
 * checksum-bound sidecar, and the separate sweep below requires that proof for
 * every such check-only migration from the first supported one onward.
 */

/**
 * Migrations that were already applied before this sweep existed. Editing a
 * header changes the file Prisma recorded a checksum for, so they are exempt by
 * their history, not by their content. Five predate the declaration itself
 * (2026-10-02); 20261003060000 is later but was applied to staging before this
 * sweep, which is the same reason.
 *
 * The set only shrinks. A new migration is dated after the threshold below and
 * has been applied nowhere, so it can simply declare. Replacing one entry with
 * another past migration is caught by the sweep itself: the entry that left the
 * set is still undeclared, so the sweep then names it.
 */
const PRESENCE_SWEEP_EXEMPT = new Set([
  "20260814140000_attempt_terminal_states",
  "20260814160000_settlement_pointer_commit_check",
  "20260918090000_admin_audit_log_append_only",
  "20260920190000_prompt_refiner_shadow_execution_runner",
  "20260923120000_marketing_autonomous_scheduled_insert",
  "20261003060000_ops_observer_transaction_arm",
]);

/** No migration newer than the sweep may be exempted. */
const PRESENCE_SWEEP_EXEMPT_BEFORE = "20261003130000";

/**
 * The statements, with everything that only looks like one removed -- and a
 * verdict on whether the scan is trustworthy.
 *
 * Three drafts of this were wrong, each in a different place, and the third is
 * why it now reports uncertainty instead of only answering. The first handled
 * only standalone `--` lines, so DDL quoted in a block comment counted as a
 * statement. The second dropped `--` to end of line unconditionally, which
 * truncated `CREATE INDEX idx ON t ((replace(c, '--', '')));` at the literal
 * and took the `;` with it: no index was found, and an expression-index-only
 * migration passed undeclared. The third mishandled `E'it\'s --'` and read the
 * identifier `idx$tag$` as the start of a function body, each with the same
 * consequence.
 *
 * Reading SQL with one pass will keep having corners, so the pass says when it
 * has met one and `needsDeclaration` treats that as "declare it". Being wrong
 * in that direction costs a comment line; being wrong the other way costs a
 * blocked deploy.
 *
 * What it does know:
 *
 *  - Comments go, and block comments nest, as PostgreSQL allows.
 *  - A string literal keeps its quotes and loses its contents, so a literal
 *    naming described DDL cannot make a migration look described.
 *  - In `E'...'` a backslash escapes the next character; everywhere else it is
 *    ordinary, because standard_conforming_strings has been on by default since
 *    PostgreSQL 9.1 and these migrations run with the server's defaults. Real
 *    migrations here use `E'[^ \t\n\r\f\v]'`, so this is not a hypothetical.
 *  - A dollar-quoted body keeps its delimiters and loses its contents: DDL
 *    written inside a function body is not applied by the migration, so the
 *    diff cannot see it either.
 *  - A dollar-quote tag cannot follow an identifier character, which is how
 *    `idx$tag$` is told from a body: it is one identifier, and it is emitted
 *    as one.
 *  - A quoted identifier is kept verbatim, because the index key list test
 *    reads those.
 *  - Newlines survive everywhere, so a line-oriented reading of the result
 *    still lines up with the file.
 *
 * What makes it uncertain: a literal, a quoted identifier, a block comment or
 * a dollar-quoted body that never closes. Today no migration in the tree
 * reaches that branch.
 */
const SINGLE_QUOTE = String.fromCharCode(39);

const scanStatements = (sql) => {
  let out = "";
  let certain = true;
  let i = 0;
  const end = sql.length;

  while (i < end) {
    const char = sql[i];

    if (char === "-" && sql[i + 1] === "-") {
      while (i < end && sql[i] !== "\n") i += 1;
      out += " ";
      continue;
    }

    if (char === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < end && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
          continue;
        }
        if (sql[i] === "\n") out += "\n";
        i += 1;
      }
      if (depth > 0) certain = false;
      out += " ";
      continue;
    }

    if (char === SINGLE_QUOTE) {
      const escaping = /(?:^|[^A-Za-z0-9_$])[Ee]$/.test(
        " " + sql.slice(Math.max(0, i - 2), i),
      );
      i += 1;
      let closed = false;
      while (i < end) {
        if (escaping && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === SINGLE_QUOTE && sql[i + 1] === SINGLE_QUOTE) {
          i += 2;
          continue;
        }
        if (sql[i] === SINGLE_QUOTE) {
          i += 1;
          closed = true;
          break;
        }
        if (sql[i] === "\n") out += "\n";
        i += 1;
      }
      if (!closed) certain = false;
      out += SINGLE_QUOTE + SINGLE_QUOTE;
      continue;
    }

    if (char === '"') {
      out += char;
      i += 1;
      let closed = false;
      while (i < end) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          out += '""';
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          out += '"';
          i += 1;
          closed = true;
          break;
        }
        out += sql[i];
        i += 1;
      }
      if (!closed) certain = false;
      continue;
    }

    const dollarTag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollarTag) {
      const previous = sql[i - 1];
      if (previous !== undefined && /[A-Za-z0-9_$]/.test(previous)) {
        out += dollarTag[0];
        i += dollarTag[0].length;
        continue;
      }
      const tag = dollarTag[0];
      i += tag.length;
      const close = sql.indexOf(tag, i);
      if (close < 0) certain = false;
      const body = close < 0 ? sql.slice(i) : sql.slice(i, close);
      for (const bodyChar of body) if (bodyChar === "\n") out += "\n";
      i = close < 0 ? end : close + tag.length;
      out += tag + tag;
      continue;
    }

    out += char;
    i += 1;
  }
  return { statements: out, certain };
};

const indexStatementsIn = (statements) =>
  [...statements.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX[\s\S]*?;/gi)].map((m) => m[0]);

/** A comma-separated list of column names, optionally sorted. Nothing else. */
const PLAIN_KEY_LIST =
  /^\(\s*(?:"?[A-Za-z_][A-Za-z0-9_]*"?(?:\s+(?:ASC|DESC))?)(?:\s*,\s*"?[A-Za-z_][A-Za-z0-9_]*"?(?:\s+(?:ASC|DESC))?)*\s*\)$/i;

/** Whether schema.prisma can express this index, so the diff would compare it. */
const indexIsDescribed = (statement) => {
  const afterOn = /\bON\b[\s\S]*?(\([\s\S]*)/i.exec(statement);
  if (!afterOn) return false;
  const rest = afterOn[1];
  let depth = 0;
  let end = -1;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "(") depth += 1;
    else if (rest[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return false;
  const keys = rest.slice(0, end + 1).replace(/\s+/g, " ").trim();
  if (!PLAIN_KEY_LIST.test(keys)) return false;
  return !/\b(?:WHERE|INCLUDE)\b/i.test(rest.slice(end + 1));
};

/** The DDL `prisma migrate diff` compares, because schema.prisma expresses it. */
const DIFF_VISIBLE = [
  /CREATE\s+TABLE/i,
  /ADD\s+COLUMN/i,
  /DROP\s+COLUMN/i,
  /ALTER\s+COLUMN/i,
  /CREATE\s+TYPE/i,
  /ALTER\s+TYPE/i,
  /DROP\s+TABLE/i,
  /RENAME\s+TO/i,
  /CREATE\s+SEQUENCE/i,
  /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW/i,
];

/** The objects a declaration can name, looked for in the raw text. */
const PROBEABLE_MENTION =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|CREATE\s+(?:CONSTRAINT\s+)?TRIGGER|CREATE\s+(?:UNIQUE\s+)?INDEX/i;

/**
 * Whether this migration needs a declaration: it creates something a
 * declaration can probe, and nothing the diff would notice.
 *
 * A scan the reader could not trust answers "yes" whenever the file mentions an
 * object a probe could name. That reads the raw text, comments included, which
 * is the fail-closed side of both choices.
 */
const needsDeclaration = (sql) => {
  const { statements, certain } = scanStatements(sql);
  if (!certain) return PROBEABLE_MENTION.test(sql);
  const indexes = indexStatementsIn(statements);
  const visible =
    DIFF_VISIBLE.some((pattern) => pattern.test(statements)) ||
    indexes.some(indexIsDescribed);
  if (visible) return false;
  return (
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i.test(statements) ||
    /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER/i.test(statements) ||
    indexes.some((statement) => !indexIsDescribed(statement))
  );
};

test("every migration the diff cannot see declares a presence probe", async () => {
  const { presenceDeclarationIn } = await import("../scripts/baseline-presence-core.mjs");
  const missing = [];
  const swept = [];
  for (const name of migrationNames()) {
    const sql = readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8");
    if (!needsDeclaration(sql)) continue;
    if (PRESENCE_SWEEP_EXEMPT.has(name)) continue;
    swept.push(name);
    const declaration = presenceDeclarationIn(sql);
    if (declaration.kind === "none" || declaration.kind === "invalid") {
      missing.push(`${name} (${declaration.kind})`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `these migrations change nothing schema.prisma describes, so the pre-deploy ` +
      `baseline guard will refuse the deploy. Add one header line, e.g.\n` +
      `  -- baseline-check: present-if-function "the_function_it_creates"\n` +
      `See scripts/baseline-presence-core.mjs. Missing: ${missing.join(", ")}`,
  );
  // The sweep is worthless if the detector stops matching anything.
  assert.ok(
    swept.length >= 8,
    `expected the sweep to still reach the declared migrations, reached ${swept.length}`,
  );
});

test("every new CHECK-only replacement migration carries complete supplemental proof", async () => {
  const { replacedCheckTargetsIn, supplementalProofIn } = await import(
    "../scripts/baseline-presence-core.mjs"
  );
  const requiredFrom = "20261008130000_amux_v4_claim_owner_resolution";
  const missing = [];
  const swept = [];
  for (const name of migrationNames()) {
    if (name < requiredFrom) continue;
    const sql = readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8");
    const { statements, certain } = scanStatements(sql);
    if (!certain) {
      missing.push(`${name} (uncertain SQL)`);
      continue;
    }
    if (DIFF_VISIBLE.some((pattern) => pattern.test(statements))) continue;
    if (
      !/\bDROP\s+CONSTRAINT\b/i.test(statements) ||
      !/\bADD\s+CONSTRAINT\b[\s\S]*?\bCHECK\b/i.test(statements)
    ) {
      continue;
    }
    const remainder = statements
      .replace(
        /\bALTER\s+TABLE\s+(?:"public"\.)?"[A-Za-z_][A-Za-z0-9_]{0,62}"[\s\S]*?;/gi,
        "",
      )
      .replace(/\b(?:BEGIN|COMMIT)\s*;/gi, "")
      .trim();
    if (remainder !== "") continue;
    swept.push(name);
    const replacements = replacedCheckTargetsIn(sql);
    if (replacements.kind !== "check-replacement") {
      missing.push(`${name} (${replacements.kind})`);
      continue;
    }
    const proofPath = join(MIGRATIONS, name, "baseline-check.json");
    const proof = supplementalProofIn(
      sql,
      existsSync(proofPath) ? readFileSync(proofPath, "utf8") : undefined,
    );
    if (proof.kind !== "check-replacement") missing.push(`${name} (${proof.kind})`);
  }
  assert.deepEqual(
    missing,
    [],
    `these new CHECK-only replacements are invisible to migrate diff and lack a ` +
      `complete checksum-bound baseline-check.json: ${missing.join(", ")}`,
  );
  assert.ok(
    swept.includes(requiredFrom),
    `expected the CHECK-only sweep to reach ${requiredFrom}`,
  );
});

test("the sweep's exemptions only shrink, and none is newer than the sweep", () => {
  // Deleting an entry is the intended edit, so the count is a ceiling and not an
  // equality: an earlier draft pinned it at the current size and would have
  // failed the very shrink this set is supposed to allow.
  assert.ok(
    PRESENCE_SWEEP_EXEMPT.size <= 6,
    `the exemption set may only shrink, found ${PRESENCE_SWEEP_EXEMPT.size}`,
  );
  for (const name of PRESENCE_SWEEP_EXEMPT) {
    assert.ok(
      migrationNames().includes(name),
      `exempt migration ${name} no longer exists; remove it from the set`,
    );
    assert.ok(
      name < PRESENCE_SWEEP_EXEMPT_BEFORE,
      `${name} is not older than the sweep; it must declare instead`,
    );
  }
});

test("the detector reads statements, not the prose around them", () => {
  const fn = `CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;\n`;
  // A header that explains a CREATE TABLE elsewhere must not count as one.
  assert.equal(needsDeclaration(`-- This replaces the CREATE TABLE in the baseline.\n${fn}`), true);
  // Nor may a block comment or a trailing comment quoting the same DDL.
  assert.equal(needsDeclaration(`/* once a CREATE TABLE lived here */\n${fn}`), true);
  assert.equal(
    needsDeclaration(`/* outer /* nested CREATE TABLE */ still a comment */\n${fn}`),
    true,
  );
  // A string literal is not a statement, and neither is a function body.
  assert.equal(
    needsDeclaration(
      `CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE 'ADD COLUMN'; END $$;\n`,
    ),
    true,
  );
  assert.equal(needsDeclaration(`${fn.trimEnd()} -- replaces an ADD COLUMN\n`), true);
  // A migration that also adds a column is visible to the diff on its own.
  assert.equal(needsDeclaration(`ALTER TABLE "T" ADD COLUMN "c" text;\n${fn}`), false);
});

test("a comment marker inside a literal is not a comment", () => {
  // The case that made the previous draft blind. Dropping `--` to end of
  // line truncated the statement at the literal and took the `;` with it, so
  // no index was found and the migration was judged to need no declaration.
  assert.equal(
    needsDeclaration(`CREATE INDEX idx ON t ((replace(c, '--', '')));\n`),
    true,
  );
  // A doubled quote ends nothing, so the statement still reaches its semicolon.
  assert.equal(
    needsDeclaration(`CREATE INDEX idx ON t ((replace(c, 'it''s --', '')));\n`),
    true,
  );
  // A literal that merely names described DDL does not make it described.
  assert.equal(
    needsDeclaration(
      `CREATE TRIGGER t AFTER DELETE ON "T" EXECUTE FUNCTION f('CREATE TABLE "X"');\n`,
    ),
    true,
  );
});

test("only an index schema.prisma can express counts as described", () => {
  // Plain key lists are in schema.prisma, so the diff compares them.
  assert.equal(needsDeclaration(`CREATE UNIQUE INDEX "T_c_key" ON "T"("c");\n`), false);
  assert.equal(
    needsDeclaration(`CREATE INDEX "T_a_b_idx" ON "T"("a" ASC, "b" DESC);\n`),
    false,
  );
  // Partial and expression indexes are not, and a probe can answer for both.
  assert.equal(
    needsDeclaration(`CREATE UNIQUE INDEX "T_c_key" ON "T"("c") WHERE "k" = 'x';\n`),
    true,
  );
  assert.equal(
    needsDeclaration(`CREATE UNIQUE INDEX "T_c_key" ON "T"(lower("c"));\n`),
    true,
  );
  assert.equal(
    needsDeclaration(`CREATE INDEX "T_c_idx" ON "T"("c") INCLUDE ("d");\n`),
    true,
  );
});

test("the classes no declaration could answer for stay out of scope", () => {
  // Both are invisible to the diff and both would be refused, but nothing a
  // declaration can name proves either absent.
  assert.equal(needsDeclaration(`UPDATE "T" SET "c" = 'x';\n`), false);
  assert.equal(
    needsDeclaration(`ALTER TABLE "T" ADD CONSTRAINT "T_c_check" CHECK ("c" <> '');\n`),
    false,
  );
});

test("a backslash escape only escapes inside E'...'", () => {
  // Round 3's first case. The scanner read the backslash as ordinary, so the
  // escaped quote closed the literal, the `--` after it became a comment, and
  // the `;` went with it -- no index found, no declaration asked for.
  const escaped = `CREATE INDEX idx ON t ((replace(c, E'it\\'s --', '')));\n`;
  // The fixture is only the case if the backslash survived into it. Writing
  // these through a shell once collapsed it and quietly tested other SQL.
  assert.ok(escaped.includes("\\'"), "the fixture must contain a real backslash");
  assert.equal(needsDeclaration(escaped), true);
  // Without the E prefix the backslash is ordinary, which is what
  // standard_conforming_strings means, so the literal runs to the next quote.
  assert.equal(
    needsDeclaration(`CREATE INDEX idx ON t ((replace(c, '\\', '')));\n`),
    true,
  );
  // The form real migrations here use.
  assert.equal(
    needsDeclaration(
      `ALTER TABLE "T" ADD CONSTRAINT "T_c_check" CHECK ("c" ~ E'[^ \\t\\n]');\n`,
    ),
    false,
  );
});

test("a dollar-quote tag cannot follow an identifier character", () => {
  // Round 3's second case: `idx$tag$` is one identifier, and reading it as the
  // start of a body swallowed the rest of the statement.
  assert.equal(needsDeclaration(`CREATE INDEX idx$tag$ ON t ((lower(c)));\n`), true);
  // With the boundary present it is a body, and its contents are not statements.
  assert.equal(
    needsDeclaration(
      `CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $tag$ BEGIN RETURN NULL; END $tag$;\n`,
    ),
    true,
  );
});

test("a scan it cannot trust asks for the declaration", () => {
  // The valve that bounds this detector: three drafts were each wrong about
  // some corner of SQL, so an unclosed construct answers "declare it" rather
  // than guessing. Being wrong here costs a comment line.
  const unterminated = `CREATE INDEX idx ON t ((lower(c))); -- note\nSELECT 'oops\n`;
  assert.equal(scanStatements(unterminated).certain, false);
  assert.equal(needsDeclaration(unterminated), true);
  // An unclosed body is the same answer.
  assert.equal(
    needsDeclaration(`CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN RETURN NULL;\n`),
    true,
  );
  // But an untrustworthy scan of a file that names nothing a probe could
  // answer for is still out of scope, not a demand nobody can meet.
  assert.equal(needsDeclaration(`UPDATE "T" SET "c" = 'oops\n`), false);
});

test("no migration in the tree needs the untrusted-scan valve", () => {
  // The valve is for a corner nobody has written yet. If this starts failing,
  // the named migration is not wrong -- it just has to declare, and the sweep
  // will say so.
  const untrusted = migrationNames().filter(
    (name) =>
      !scanStatements(readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"))
        .certain,
  );
  assert.deepEqual(untrusted, []);
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

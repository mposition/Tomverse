import assert from "node:assert/strict";
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
  assert.ok(
    migrate.indexOf("baseline-existing-database.mjs") <
      migrate.indexOf("migrate deploy"),
    "the baseline guard must run before prisma migrate deploy"
  );
});

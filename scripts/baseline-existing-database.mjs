import { spawnSync } from "node:child_process";
import pg from "pg";

/**
 * Records the baseline migration as already applied on a database that predates
 * it, so `prisma migrate deploy` does not try to recreate the schema.
 *
 * ## Why this exists
 *
 * The migration history was replaced by a single baseline
 * (prisma/migrations/00000000000000_baseline), because the old history could
 * not build the schema from an empty database at all. Databases that were
 * migrated by that old history already hold every table, but their
 * `_prisma_migrations` table has no row for the baseline -- so the next
 * `migrate deploy` sees one unapplied migration, runs it, and fails on
 * `relation "User" already exists` (P3018). Worse, the failed row then blocks
 * every later deploy until someone resolves it by hand.
 *
 * This runs before `migrate deploy` and closes that gap without a manual step.
 * It is Prisma's documented `migrate resolve --applied` baselining, decided
 * from the database's own state rather than from a human remembering.
 *
 * ## What it will and will not do
 *
 * `migrate resolve --applied` writes one row to `_prisma_migrations`. It runs
 * no DDL and cannot alter or damage the schema. The only real hazard is
 * marking the baseline applied on a database that does *not* already have the
 * schema, which would skip the DDL it needs -- so the decision is gated on the
 * schema visibly being there:
 *
 *  - no `_prisma_migrations` table, or no finished migration in it: a fresh
 *    database. Do nothing; `migrate deploy` applies the baseline normally.
 *  - the baseline is already recorded as finished: do nothing.
 *  - `User` is missing: not a pre-baseline database whatever else is true.
 *    Do nothing, and let `migrate deploy` speak for itself.
 *  - otherwise -- finished migrations exist, the baseline is not among them,
 *    and the schema is present: resolve the baseline as applied.
 *
 * The last case also covers a database where an earlier deploy already failed
 * on the baseline: that leaves an unfinished row, which is not a finished one,
 * so it is resolved the same way.
 */

const BASELINE_MIGRATION = "00000000000000_baseline";
const { Client } = pg;

const directUrl = process.env.DIRECT_DATABASE_URL;

const log = (message, details = {}) =>
  console.log(
    JSON.stringify({ stage: "baseline-check", message, ...details })
  );

const fail = (message, details = {}) => {
  console.error(
    JSON.stringify({ stage: "baseline-check", ok: false, message, ...details })
  );
  process.exit(1);
};

if (!directUrl) {
  fail("DIRECT_DATABASE_URL is missing; run require-direct-database-url first.");
}

/**
 * Mirrors the normalisation in require-direct-database-url.mjs: node-postgres
 * needs the compatibility flag to honour libpq's sslmode values.
 */
const normalizeConnectionString = (value) => {
  try {
    const url = new URL(value);
    const sslMode = url.searchParams.get("sslmode");
    if (
      ["prefer", "require", "verify-ca"].includes(sslMode) &&
      !url.searchParams.has("uselibpqcompat")
    ) {
      url.searchParams.set("uselibpqcompat", "true");
      return url.toString();
    }
  } catch {
    return value;
  }
  return value;
};

const client = new Client({
  connectionString: normalizeConnectionString(directUrl),
  connectionTimeoutMillis: 10_000,
  query_timeout: 10_000,
  application_name: "tomverse-prisma-baseline-check",
});

let shouldResolve = false;

try {
  await client.connect();

  const { rows: historyRows } = await client.query(
    `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`
  );
  if (!historyRows[0]?.present) {
    log("No migration history table; treating this as a fresh database.");
    process.exit(0);
  }

  const { rows: countRows } = await client.query(`
    SELECT
      count(*) FILTER (WHERE finished_at IS NOT NULL) AS finished,
      count(*) FILTER (
        WHERE migration_name = $1 AND finished_at IS NOT NULL
      ) AS baseline_finished
    FROM "_prisma_migrations"
  `, [BASELINE_MIGRATION]);
  const finished = Number(countRows[0]?.finished || 0);
  const baselineFinished = Number(countRows[0]?.baseline_finished || 0);

  if (baselineFinished > 0) {
    log("Baseline is already recorded as applied; nothing to do.");
    process.exit(0);
  }
  if (finished === 0) {
    log("No finished migrations recorded; treating this as a fresh database.");
    process.exit(0);
  }

  const { rows: schemaRows } = await client.query(
    `SELECT to_regclass('public."User"') IS NOT NULL AS present`
  );
  if (!schemaRows[0]?.present) {
    fail(
      'This database records finished migrations but has no "User" table, so it is neither a fresh database nor a pre-baseline one. Refusing to guess; inspect it before deploying.',
      { finishedMigrations: finished }
    );
  }

  shouldResolve = true;
  log(
    "Pre-baseline database detected: the schema is present and the baseline is not recorded. Marking it applied.",
    { finishedMigrations: finished, baseline: BASELINE_MIGRATION }
  );
} catch (error) {
  const message =
    error && typeof error === "object" && typeof error.message === "string"
      ? error.message.replaceAll(directUrl, "[redacted]")
      : "Unknown PostgreSQL error.";
  fail("Could not read the migration history.", {
    errorMessage: message.slice(0, 500),
  });
} finally {
  await client.end().catch(() => undefined);
}

if (shouldResolve) {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",
      "migrate",
      "resolve",
      "--applied",
      BASELINE_MIGRATION,
    ],
    { stdio: "inherit" }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail("prisma migrate resolve --applied failed.", {
      exitCode: result.status,
    });
  }
  log("Baseline recorded as applied.");
}

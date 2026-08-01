import { spawnSync } from "node:child_process";
import pg from "pg";

/**
 * Compares a live database's schema against one built purely from
 * prisma/migrations, and reports every difference.
 *
 * ## Why this is not `prisma migrate diff`
 *
 * `migrate diff` compares against `schema.prisma`, and `schema.prisma` cannot
 * express two things this codebase relies on:
 *
 *  - **CHECK constraints** -- ten of them, including the one that pins the
 *    `ProductAnalyticsEvent` event-name allowlist and the one that stops a
 *    model registry row pointing at an arbitrary API base URL.
 *  - **partial and expression indexes** -- such as
 *    `PlanChangeRequest_userId_active_key`, the only thing stopping two racing
 *    confirms from both reserving a plan change.
 *
 * `migrate diff` neither creates them nor sees them drift. So after the
 * migration history was replaced by a baseline, "the baseline reproduces
 * production" could not be established from inside this repository. This
 * closes that: it reads both schemas out of the catalogue and compares what
 * actually exists.
 *
 * ## Safety
 *
 * The source database is only ever read -- the queries below are the entire
 * interaction with it, and every one is a SELECT. Only the scratch database is
 * written to, and it must carry a disposable-looking name and differ from the
 * source, or this refuses to run.
 *
 * ## Usage
 *
 *   COMPARE_SOURCE_DATABASE_URL=<the live database, read-only> \
 *   COMPARE_SCRATCH_DATABASE_URL=<an empty, disposable database> \
 *   npm run db:compare-schema
 *
 * Exits non-zero on any difference, so it can gate a release.
 */

const { Client } = pg;

const sourceUrl = process.env.COMPARE_SOURCE_DATABASE_URL?.trim();
const scratchUrl = process.env.COMPARE_SCRATCH_DATABASE_URL?.trim();

const fail = (message, details = {}) => {
  console.error(
    JSON.stringify({ stage: "compare-schema", ok: false, message, ...details })
  );
  process.exit(1);
};

if (!sourceUrl) {
  fail(
    "COMPARE_SOURCE_DATABASE_URL is required: the database to compare against, for example the production direct connection. It is only read."
  );
}
if (!scratchUrl) {
  fail(
    "COMPARE_SCRATCH_DATABASE_URL is required: an empty, disposable database this builds from migrations. Its contents are replaced."
  );
}
if (sourceUrl === scratchUrl) {
  fail("The scratch database must not be the source database.");
}

const scratchName = (() => {
  try {
    return decodeURIComponent(new URL(scratchUrl).pathname.replace(/^\//, ""));
  } catch {
    return fail("COMPARE_SCRATCH_DATABASE_URL is not a valid URL.");
  }
})();
if (!/(?:^|[_-])(?:test|testing|ci|scratch|tmp|compare)(?:[_-]|$)/i.test(scratchName)) {
  fail(
    `The scratch database name must carry a disposable marker such as tomverse_compare_scratch. Received "${scratchName}".`
  );
}

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

/**
 * Everything compared, read from the catalogue rather than from a text dump.
 *
 * A `pg_dump` diff is noisy across server versions and orders statements by
 * dependency, so a harmless reordering reads as a difference. These queries
 * return sorted, canonical strings instead: `pg_get_constraintdef()` and
 * `pg_indexes.indexdef` are the server's own normalised rendering, so two
 * databases that agree produce byte-identical output.
 *
 * `_prisma_migrations` is excluded throughout: it records how a database was
 * built, which is exactly what differs between these two by construction.
 */
const QUERIES = {
  columns: `
    SELECT c.table_name || '.' || c.column_name || ' :: ' || c.data_type
             || coalesce('(' || c.character_maximum_length || ')', '')
             || ' null=' || c.is_nullable
             || ' default=' || coalesce(c.column_default, '-') AS row
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name <> '_prisma_migrations'
    ORDER BY row
  `,
  indexes: `
    SELECT indexdef AS row
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    ORDER BY row
  `,
  constraints: `
    SELECT rel.relname || ' :: ' || con.conname || ' :: '
             || pg_get_constraintdef(con.oid) AS row
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname <> '_prisma_migrations'
    ORDER BY row
  `,
  enums: `
    SELECT t.typname || ' :: ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS row
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
    ORDER BY row
  `,
  routines: `
    SELECT p.proname || ' :: ' || pg_get_function_identity_arguments(p.oid) AS row
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
    ORDER BY row
  `,
  triggers: `
    SELECT tgname || ' :: ' || pg_get_triggerdef(t.oid) AS row
    FROM pg_trigger t
    JOIN pg_class rel ON rel.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ORDER BY row
  `,
};

const readSchema = async (url, label) => {
  const client = new Client({
    connectionString: normalizeConnectionString(url),
    connectionTimeoutMillis: 15_000,
    query_timeout: 60_000,
    application_name: "tomverse-schema-compare",
  });
  const schema = {};
  try {
    await client.connect();
    for (const [name, sql] of Object.entries(QUERIES)) {
      const { rows } = await client.query(sql);
      schema[name] = rows.map((row) => row.row);
    }
  } catch (error) {
    const message =
      error && typeof error === "object" && typeof error.message === "string"
        ? error.message.replaceAll(url, "[redacted]")
        : "Unknown PostgreSQL error.";
    fail(`Could not read the ${label} schema.`, {
      errorMessage: message.slice(0, 500),
    });
  } finally {
    await client.end().catch(() => undefined);
  }
  return schema;
};

const run = (args, label, env) => {
  console.log(`[compare-schema] ${label}`);
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${label} failed.`, { exitCode: result.status });
  }
};

// Build the scratch database from the migration history alone. This is the
// same command a deployment runs, so what it produces is what a new
// environment would get.
run(
  ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  "Building the scratch database from prisma/migrations",
  { DATABASE_URL: scratchUrl, DIRECT_DATABASE_URL: scratchUrl }
);

const [live, built] = await Promise.all([
  readSchema(sourceUrl, "source"),
  readSchema(scratchUrl, "scratch"),
]);

let differences = 0;
const report = [];
for (const section of Object.keys(QUERIES)) {
  const liveSet = new Set(live[section]);
  const builtSet = new Set(built[section]);
  const onlyLive = live[section].filter((row) => !builtSet.has(row));
  const onlyBuilt = built[section].filter((row) => !liveSet.has(row));
  if (onlyLive.length === 0 && onlyBuilt.length === 0) {
    report.push(`  ${section}: ${live[section].length} identical`);
    continue;
  }
  differences += onlyLive.length + onlyBuilt.length;
  report.push(`  ${section}: ${onlyLive.length + onlyBuilt.length} difference(s)`);
  for (const row of onlyLive) report.push(`    only in the source:  ${row}`);
  for (const row of onlyBuilt) report.push(`    only in migrations:  ${row}`);
}

console.log("\n[compare-schema] Result\n" + report.join("\n"));

if (differences > 0) {
  console.error(
    `\n[compare-schema] ${differences} difference(s). "only in the source" is SQL the migration history does not carry -- most likely applied by hand, and it will be missing from every new environment. "only in migrations" means the source is behind.`
  );
  process.exit(1);
}
console.log(
  "\n[compare-schema] The migration history reproduces this database exactly, including CHECK constraints and partial indexes."
);

import { spawnSync } from "node:child_process";
import pg from "pg";

import {
  compareSchemas,
  redactConnectionStrings,
} from "../lib/schemaComparisonCore.mjs";

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

/**
 * Every printed line goes through this. See lib/schemaComparisonCore.mjs --
 * the classification and the redaction live there so both can be tested
 * without a PostgreSQL server.
 */
const redact = redactConnectionStrings;

/** The commit the comparison ran at, so the result can be filed against it. */
const gitCommit = () => {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { stdio: "pipe" });
  return result.status === 0 ? String(result.stdout).trim() : "unknown";
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
/**
 * Everything compared, read from the catalogue rather than from a text dump.
 *
 * A `pg_dump` diff is noisy across server versions and orders statements by
 * dependency, so a harmless reordering reads as a difference. These queries
 * return the server's own normalised rendering instead --
 * `pg_get_constraintdef()` and `pg_indexes.indexdef` -- so two databases that
 * agree produce byte-identical output.
 *
 * Each row is split into an **identity** and a **definition**, which is what
 * lets a redefinition be reported as one drift rather than as an unrelated
 * addition and removal. An index kept under its own name with a changed
 * predicate is the most dangerous case this tool exists to find, and a plain
 * set difference describes it as "one object missing, one object added" --
 * true, but it buries the fact that the name still resolves and now means
 * something else.
 *
 * `_prisma_migrations` is excluded throughout: it records how a database was
 * built, which is exactly what differs between these two by construction.
 */
const QUERIES = {
  columns: `
    SELECT c.table_name || '.' || c.column_name AS key,
           c.data_type
             || coalesce('(' || c.character_maximum_length || ')', '')
             || ' null=' || c.is_nullable
             || ' default=' || coalesce(c.column_default, '-') AS definition
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name <> '_prisma_migrations'
    ORDER BY key
  `,
  indexes: `
    SELECT tablename || '.' || indexname AS key, indexdef AS definition
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    ORDER BY key
  `,
  constraints: `
    SELECT rel.relname || '.' || con.conname AS key,
           pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname <> '_prisma_migrations'
    ORDER BY key
  `,
  enums: `
    SELECT t.typname AS key,
           string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS definition
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
    ORDER BY key
  `,
  routines: `
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS key,
           pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
    ORDER BY key
  `,
  triggers: `
    SELECT rel.relname || '.' || t.tgname AS key,
           pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t
    JOIN pg_class rel ON rel.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ORDER BY key
  `,
  extensions: `
    SELECT e.extname AS key, e.extversion AS definition
    FROM pg_extension e
    ORDER BY key
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
  let serverVersion = "unknown";
  let databaseName = "unknown";
  try {
    await client.connect();
    // Recorded as evidence: a comparison run against a different major
    // version, or with different extensions available, is not the comparison
    // anyone intended to make.
    const meta = await client.query(
      "SELECT current_setting('server_version') AS version, current_database() AS db"
    );
    serverVersion = meta.rows[0]?.version || "unknown";
    databaseName = meta.rows[0]?.db || "unknown";
    for (const [name, sql] of Object.entries(QUERIES)) {
      const { rows } = await client.query(sql);
      schema[name] = new Map(rows.map((row) => [row.key, row.definition]));
    }
  } catch (error) {
    // Never let a connection string reach the output: the message from a
    // failed connect often contains it verbatim.
    const message =
      error && typeof error === "object" && typeof error.message === "string"
        ? error.message.replaceAll(url, "[redacted]")
        : "Unknown PostgreSQL error.";
    fail(`Could not read the ${label} schema.`, {
      errorMessage: redact(message).slice(0, 500),
    });
  } finally {
    await client.end().catch(() => undefined);
  }
  return { schema, serverVersion, databaseName };
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

const [source, built] = await Promise.all([
  readSchema(sourceUrl, "source"),
  readSchema(scratchUrl, "scratch"),
]);

// Evidence, printed before any verdict so it is captured even on failure.
// A comparison is only meaningful against a scratch database that matches the
// source's major version and extension set; recording both is what lets a
// reviewer tell a real drift from an artefact of comparing unlike servers.
const evidence = {
  comparedAt: new Date().toISOString(),
  commit: gitCommit(),
  sourceDatabase: source.databaseName,
  sourceServerVersion: source.serverVersion,
  scratchDatabase: built.databaseName,
  scratchServerVersion: built.serverVersion,
};
console.log("\n[compare-schema] Evidence\n" + JSON.stringify(evidence, null, 2));
if (
  source.serverVersion.split(".")[0] !== built.serverVersion.split(".")[0]
) {
  console.warn(
    `\n[compare-schema] WARNING: major version mismatch (source ${source.serverVersion}, scratch ${built.serverVersion}). Differences below may be rendering differences rather than drift.`
  );
}

/**
 * Three outcomes, deliberately kept apart -- they have different causes and
 * different corrections. The comparison itself is in
 * lib/schemaComparisonCore.mjs; what stays here is how it is presented.
 */
const { comparisons, totals, differenceCount: differences } = compareSchemas(
  source.schema,
  built.schema,
  Object.keys(QUERIES)
);

const report = [];
for (const comparison of comparisons) {
  if (comparison.differenceCount === 0) {
    report.push(`  ${comparison.section}: ${comparison.identicalCount} identical`);
    continue;
  }
  report.push(`  ${comparison.section}: ${comparison.differenceCount} difference(s)`);
  for (const row of comparison.onlyInSource) {
    report.push(`    only in the source:    ${row}`);
  }
  for (const row of comparison.onlyInDatabase) {
    report.push(`    only in migrations:    ${row}`);
  }
  for (const row of comparison.definitionMismatch) {
    report.push(`    definition mismatch:   ${row.key}`);
    report.push(`        source:     ${row.source}`);
    report.push(`        migrations: ${row.database}`);
  }
}

console.log("\n[compare-schema] Result\n" + report.join("\n"));

if (differences > 0) {
  console.error(
    [
      "",
      `[compare-schema] ${differences} difference(s).`,
      "",
      `  only_in_source       (${totals.only_in_source})  not created by the migration history -- missing from every new environment.`,
      `  only_in_database     (${totals.only_in_database})  the source is behind, or the object was dropped outside the history.`,
      `  definition_mismatch  (${totals.definition_mismatch})  same name, different meaning. Nothing is missing, so existence checks all pass.`,
      "",
      "Do NOT hand-edit the source database or the baseline to make this pass.",
      "Classify each difference first -- manual drift, extension-owned object,",
      "or a migration nobody wrote -- then correct it with a NEW migration and",
      "re-run this. Editing an applied migration changes its checksum, which",
      "`migrate deploy` will not notice but `migrate status` reports as",
      "`modified after it was applied` on every environment that already ran",
      "it -- and the release checklist requires a clean status.",
    ].join("\n")
  );
  process.exit(1);
}
console.log(
  "\n[compare-schema] The migration history reproduces this database exactly, including CHECK constraints, partial indexes and extensions."
);

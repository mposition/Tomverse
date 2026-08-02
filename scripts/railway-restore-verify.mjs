// Post-restore verification for an isolated Railway restore drill.
//
//   npm run drill:railway-restore-verify
//   npm run drill:railway-restore-verify -- --json
//
// Reads the restored database and reports whether it is a database anyone
// could actually recover onto. Read-only throughout: every statement it sends
// is a SELECT, and it neither applies migrations nor repairs anything it
// finds. A drill that fixes what it discovers has not measured a recovery.
//
// It re-runs the preflight first and refuses if that fails, because the one
// way this script could do harm is by being pointed at production.
//
// What it establishes:
//   * the migration history is fully applied and carries no failed row
//   * the tables, CHECK constraints and partial indexes exist
//   * row counts per table -- counts only, never a row, never a column value
//   * stable aggregates over key data, as hashes rather than contents
//   * RPO from the backup timestamp, RTO from the restore window
//
// Schema equivalence itself is `npm run db:compare-schema`, which this points
// at rather than reimplements.
//
// Configure with the DRILL_* variables from the preflight, plus:
//   DRILL_RESTORE_STARTED_AT / DRILL_RESTORE_FINISHED_AT   RFC3339, for RTO

import pg from "pg";

import {
  findRestoreDrillProblems,
  summariseRestoreDrillProblems,
} from "../lib/railwayRestorePreflightCore.mjs";
import { redactConnectionStrings } from "../lib/schemaComparisonCore.mjs";

const { Client } = pg;
const json = process.argv.includes("--json");
const env = process.env;

const list = (value) =>
  (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const targetUrl = env.DRILL_TARGET_DATABASE_URL?.trim() || "";

const preflightProblems = summariseRestoreDrillProblems(
  findRestoreDrillProblems({
    approvalTicket: env.DRILL_APPROVAL_TICKET?.trim() || null,
    drillOwner: env.DRILL_OWNER?.trim() || null,
    backupId: env.DRILL_BACKUP_ID?.trim() || null,
    backupTakenAt: env.DRILL_BACKUP_TAKEN_AT?.trim() || null,
    cleanupTargets: list(env.DRILL_CLEANUP_TARGETS),
    target: {
      projectId: env.DRILL_TARGET_PROJECT_ID?.trim() || null,
      environmentId: env.DRILL_TARGET_ENVIRONMENT_ID?.trim() || null,
      serviceId: env.DRILL_TARGET_SERVICE_ID?.trim() || null,
      databaseUrl: targetUrl || null,
      directDatabaseUrl: env.DRILL_TARGET_DIRECT_DATABASE_URL?.trim() || null,
    },
    production: {
      projectId: env.PRODUCTION_PROJECT_ID?.trim() || null,
      environmentId: env.PRODUCTION_ENVIRONMENT_ID?.trim() || null,
      serviceId: env.PRODUCTION_SERVICE_ID?.trim() || null,
      databaseUrl: env.PRODUCTION_DATABASE_URL?.trim() || null,
      directDatabaseUrl: env.PRODUCTION_DIRECT_DATABASE_URL?.trim() || null,
      privateNetworkHostSuffixes: list(
        env.PRODUCTION_PRIVATE_NETWORK_SUFFIXES || ".railway.internal"
      ),
    },
    env,
  })
);

if (preflightProblems.length > 0) {
  console.error(
    "Refusing to connect: the drill preflight does not pass, so this may not be an isolated restore target.\n"
  );
  for (const problem of preflightProblems) {
    console.error(`  - [${problem.code}] ${problem.message}`);
  }
  process.exit(1);
}

// Read-only, all of it.
const QUERIES = {
  migrations: `
    SELECT migration_name,
           finished_at IS NOT NULL AS finished,
           rolled_back_at IS NOT NULL AS rolled_back
    FROM _prisma_migrations
    ORDER BY migration_name
  `,
  tables: `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `,
  checkConstraints: `
    SELECT rel.relname || '.' || con.conname AS name,
           pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND con.contype = 'c'
    ORDER BY name
  `,
  foreignKeys: `
    SELECT count(*)::int AS count
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND con.contype = 'f'
  `,
  partialIndexes: `
    SELECT tablename || '.' || indexname AS name, indexdef AS definition
    FROM pg_indexes
    WHERE schemaname = 'public' AND indexdef ILIKE '%WHERE%'
    ORDER BY name
  `,
};

// Aggregates chosen so the drill can say "the data came back" without any
// value leaving the database. A count is a count; a hash of an ordered id list
// changes if a row is missing and reveals nothing about who the row is.
const AGGREGATE_CHECKS = [
  { label: "users", table: "User", idColumn: "id" },
  { label: "conversations", table: "Conversation", idColumn: "id" },
  { label: "messages", table: "Message", idColumn: "id" },
  { label: "creditLedger", table: "CreditLedgerEntry", idColumn: "id" },
  { label: "reservations", table: "ChatCreditReservation", idColumn: "id" },
  { label: "modelRegistry", table: "ModelRegistryEntry", idColumn: "id" },
];

const client = new Client({
  connectionString: targetUrl,
  connectionTimeoutMillis: 20_000,
  query_timeout: 120_000,
  application_name: "tomverse-restore-drill-verify",
});

const result = {
  verifiedAt: new Date().toISOString(),
  backupId: env.DRILL_BACKUP_ID?.trim() || null,
  backupTakenAt: env.DRILL_BACKUP_TAKEN_AT?.trim() || null,
  restoreStartedAt: env.DRILL_RESTORE_STARTED_AT?.trim() || null,
  restoreFinishedAt: env.DRILL_RESTORE_FINISHED_AT?.trim() || null,
  findings: [],
};

const minutesBetween = (from, to) => {
  const start = Date.parse(from || "");
  const end = Date.parse(to || "");
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Number(((end - start) / 60_000).toFixed(2));
};

try {
  await client.connect();

  const meta = await client.query(
    "SELECT current_database() AS db, current_setting('server_version') AS version"
  );
  result.database = meta.rows[0]?.db ?? "unknown";
  result.serverVersion = meta.rows[0]?.version ?? "unknown";

  const migrations = (await client.query(QUERIES.migrations)).rows;
  result.migrations = {
    total: migrations.length,
    unfinished: migrations
      .filter((row) => !row.finished)
      .map((row) => row.migration_name),
    rolledBack: migrations
      .filter((row) => row.rolled_back)
      .map((row) => row.migration_name),
  };
  if (result.migrations.unfinished.length > 0) {
    result.findings.push(
      `${result.migrations.unfinished.length} migration row(s) never finished. A failed row blocks every later deploy, so this database is not recoverable as it stands.`
    );
  }

  result.tables = (await client.query(QUERIES.tables)).rows.map(
    (row) => row.table_name
  );
  const checks = (await client.query(QUERIES.checkConstraints)).rows;
  result.checkConstraints = { count: checks.length, names: checks.map((r) => r.name) };
  const partial = (await client.query(QUERIES.partialIndexes)).rows;
  result.partialIndexes = { count: partial.length, names: partial.map((r) => r.name) };
  result.foreignKeyCount = (await client.query(QUERIES.foreignKeys)).rows[0]?.count ?? 0;

  // schema.prisma cannot express CHECK constraints at all, so `prisma migrate
  // diff` reports "no difference" when they are missing and a restore that
  // silently lost them looks complete. The baseline carries ten.
  if (result.checkConstraints.count === 0) {
    result.findings.push(
      "No CHECK constraints at all. The baseline carries ten, and nothing else in the toolchain would notice they were gone."
    );
  }
  // Partial and expression indexes are counted and reported rather than
  // asserted: how many there should be is a property of the migration
  // history at this commit, and the tool that knows it is
  // `npm run db:compare-schema`. A hardcoded expectation here would go stale
  // the first time one was replaced -- which has already happened once, when
  // PlanChangeRequest's partial unique index became a generated-column unique.

  result.rowCounts = {};
  result.aggregates = {};
  for (const check of AGGREGATE_CHECKS) {
    if (!result.tables.includes(check.table)) {
      result.rowCounts[check.label] = null;
      result.findings.push(`Table "${check.table}" is missing from the restore.`);
      continue;
    }
    const counted = await client.query(
      `SELECT count(*)::int AS count FROM "${check.table}"`
    );
    result.rowCounts[check.label] = counted.rows[0]?.count ?? 0;
    // md5 over the ordered id list: sensitive to a missing or extra row,
    // and it carries no identifier out of the database.
    const hashed = await client.query(
      `SELECT md5(coalesce(string_agg("${check.idColumn}"::text, ',' ORDER BY "${check.idColumn}"), '')) AS digest FROM "${check.table}"`
    );
    result.aggregates[check.label] = hashed.rows[0]?.digest ?? null;
  }

  result.rpoMinutes = minutesBetween(
    result.backupTakenAt,
    result.restoreStartedAt || result.verifiedAt
  );
  result.rtoMinutes = minutesBetween(
    result.restoreStartedAt,
    result.restoreFinishedAt
  );
  if (result.rpoMinutes === null) {
    result.findings.push(
      "RPO could not be computed: DRILL_BACKUP_TAKEN_AT is missing or unparseable."
    );
  }
  if (result.rtoMinutes === null) {
    result.findings.push(
      "RTO could not be computed: DRILL_RESTORE_STARTED_AT / DRILL_RESTORE_FINISHED_AT are missing or unparseable."
    );
  }
} catch (error) {
  const message = redactConnectionStrings(
    String(error?.message || error).replaceAll(targetUrl, "[redacted]")
  );
  console.error(`Verification could not complete: ${message.slice(0, 400)}`);
  process.exit(1);
} finally {
  await client.end().catch(() => undefined);
}

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Restore drill verification -- ${result.database} (PostgreSQL ${result.serverVersion})\n`);
  console.log(`  backup ${result.backupId} taken ${result.backupTakenAt}`);
  console.log(
    `  RPO ${result.rpoMinutes === null ? "unknown" : `${result.rpoMinutes} min`}   ` +
      `RTO ${result.rtoMinutes === null ? "unknown" : `${result.rtoMinutes} min`}`
  );
  console.log(
    `\n  migrations       ${result.migrations.total} applied, ` +
      `${result.migrations.unfinished.length} unfinished, ${result.migrations.rolledBack.length} rolled back`
  );
  console.log(`  tables           ${result.tables.length}`);
  console.log(`  CHECK            ${result.checkConstraints.count}`);
  console.log(`  partial indexes  ${result.partialIndexes.count}`);
  console.log(`  foreign keys     ${result.foreignKeyCount}`);
  console.log("\n  row counts (counts only -- no row is ever read):");
  for (const [label, count] of Object.entries(result.rowCounts)) {
    console.log(
      `    ${label.padEnd(16)} ${count === null ? "TABLE MISSING" : count}` +
        (result.aggregates[label] ? `   digest ${result.aggregates[label].slice(0, 12)}` : "")
    );
  }
  console.log(
    "\n  Schema equivalence is a separate step: run npm run db:compare-schema against this\n" +
      "  database with COMPARE_SOURCE_DATABASE_URL, and record all three classifications."
  );
}

if (result.findings.length > 0) {
  console.error(`\n${result.findings.length} finding(s):`);
  for (const finding of result.findings) console.error(`  - ${finding}`);
  console.error(
    "\nRecord these in the drill report as they are. Do not repair them here --\n" +
      "a drill that fixes what it finds has not measured a recovery."
  );
  process.exit(1);
}

console.log("\nVerification passed.");

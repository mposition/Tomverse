import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The AMUX commit deadline check, for a database built with `prisma db push`.
 *
 * `db push` creates what schema.prisma can express: the `AmuxCommitDeadline`
 * table, and neither the function nor the deferred constraint trigger that
 * make the table mean anything. Without them the fence in
 * lib/amux/dbBoundary.ts refuses every AMUX write with
 * AMUX_DB_COMMIT_CHECK_MISSING, which is the right answer for a database that
 * cannot check a late COMMIT, and the wrong one for a test database that
 * simply was not migrated.
 *
 * So the two harnesses that push -- the Admin E2E suite
 * (tests/e2e-admin/support/database.ts) and DB_INTEGRATION_SCHEMA_SOURCE=push
 * (scripts/run-db-integration-tests.mjs) -- apply the migration's own text,
 * read from the migration file between its install markers. There is no
 * second copy of the function to drift from the one production runs.
 *
 * The text runs inside one DO block that takes an advisory lock and creates
 * nothing when the trigger is already there, because a pushed database keeps
 * its triggers across pushes and Playwright workers may reach this at once.
 * No database connection is opened here.
 */

export const AMUX_COMMIT_DEADLINE_MIGRATION =
  "prisma/migrations/20260929200000_amux_commit_deadline_check/migration.sql";

const BEGIN_MARKER = "-- amux-commit-deadline-check:install:begin";
const END_MARKER = "-- amux-commit-deadline-check:install:end";
const TRIGGER_START = "CREATE CONSTRAINT TRIGGER ";
const FUNCTION_START = "CREATE OR REPLACE FUNCTION ";
const OUTER_TAG = "$amux_commit_deadline_install$";
const STATEMENT_TAGS = ["$amux_commit_deadline_fn$", "$amux_commit_deadline_trigger$"];

const once = (text, marker) => {
  const first = text.indexOf(marker);
  if (first < 0 || text.indexOf(marker, first + 1) >= 0) {
    throw new Error(`The AMUX commit deadline migration must hold "${marker}" exactly once.`);
  }
  return first;
};

/**
 * The function and trigger statements, in order, each without its final
 * semicolon, exactly as the migration writes them.
 */
export const amuxCommitDeadlineInstallStatements = (migrationSql) => {
  const text = migrationSql.replace(/\r\n/g, "\n");
  const begin = once(text, BEGIN_MARKER) + BEGIN_MARKER.length;
  const end = once(text, END_MARKER);
  if (end <= begin) {
    throw new Error("The AMUX commit deadline install markers are out of order.");
  }
  const block = text.slice(begin, end).trim();
  const triggerAt = once(block, TRIGGER_START);
  const statements = [block.slice(0, triggerAt), block.slice(triggerAt)].map((statement) =>
    statement.trim().replace(/;$/, "").trim(),
  );
  if (!statements[0].startsWith(FUNCTION_START) || !statements[1].startsWith(TRIGGER_START)) {
    throw new Error(
      "The AMUX commit deadline install block must be one function followed by one trigger.",
    );
  }
  for (const statement of statements) {
    for (const tag of [OUTER_TAG, ...STATEMENT_TAGS]) {
      if (statement.includes(tag)) {
        throw new Error(`The AMUX commit deadline install text must not contain ${tag}.`);
      }
    }
  }
  return statements;
};

/**
 * One idempotent statement that installs the function and the trigger when
 * the trigger is absent from the table the unqualified name resolves to.
 */
export const amuxCommitDeadlineInstallSql = (migrationSql) => {
  const [functionSql, triggerSql] = amuxCommitDeadlineInstallStatements(migrationSql);
  return [
    `DO ${OUTER_TAG}`,
    "BEGIN",
    "  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('amux_commit_deadline_check:install'));",
    "  IF NOT EXISTS (",
    "    SELECT 1 FROM pg_catalog.pg_trigger t",
    `    WHERE t.tgrelid = pg_catalog.to_regclass('"AmuxCommitDeadline"')`,
    "      AND t.tgname = 'amux_commit_deadline_check'",
    "  ) THEN",
    `    EXECUTE ${STATEMENT_TAGS[0]}\n${functionSql}\n${STATEMENT_TAGS[0]};`,
    `    EXECUTE ${STATEMENT_TAGS[1]}\n${triggerSql}\n${STATEMENT_TAGS[1]};`,
    "  END IF;",
    "END",
    `${OUTER_TAG};`,
  ].join("\n");
};

/** Reads the migration from a checkout and returns its install statement. */
export const readAmuxCommitDeadlineInstallSql = (repoRoot) =>
  amuxCommitDeadlineInstallSql(readFileSync(join(repoRoot, AMUX_COMMIT_DEADLINE_MIGRATION), "utf8"));

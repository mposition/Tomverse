import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";
import pg from "pg";

import {
  CONNECT_RETRY_COUNT,
  connectWithRetry,
} from "./direct-database-connect-core.mjs";
import {
  checkDefinitionQuery,
  checkReplacementAnswer,
  checkReplacementSetAnswer,
  pendingProbes,
  presenceAnswer,
  presenceQueryFor,
  presenceVerdict,
  replacementAnswer,
} from "./baseline-presence-core.mjs";

/**
 * Reconciles a database that already holds the schema with a migration history
 * that does not say so, before `prisma migrate deploy` runs.
 *
 * ## Why this exists
 *
 * The migration history was replaced by a single baseline
 * (prisma/migrations/00000000000000_baseline), because the old history could
 * not build the schema from an empty database at all. Databases built before
 * that -- and databases built with `prisma db push`, which records nothing --
 * already hold every table, but their `_prisma_migrations` has no row for the
 * baseline. `migrate deploy` then applies it and fails on `relation "User"
 * already exists` (P3018). Worse, the failed row blocks every later deploy
 * until someone resolves it by hand.
 *
 * This runs first and closes that gap. It is Prisma's documented
 * `migrate resolve --applied` baselining, decided from the database's own
 * state rather than from a human remembering.
 *
 * ## What it will and will not do
 *
 * `migrate resolve --applied` writes one row to `_prisma_migrations`. It runs
 * no DDL and cannot alter or damage a schema. The hazard is the opposite one:
 * marking something applied on a database that does *not* have it, which would
 * skip the DDL it needs. So the decision is gated on the schema visibly being
 * there.
 *
 *  - **No `User` table** -- nothing has been applied here. Do nothing;
 *    `migrate deploy` builds the database normally. This is the only fresh
 *    case, and it is decided by the schema, not by the history: a `db push`
 *    database has a complete schema and an empty history, and treating that as
 *    fresh is what made an earlier version of this script fail.
 *  - **`User` exists, baseline not recorded** -- resolve the baseline. Covers
 *    pre-baseline databases, `db push` databases, and a database where an
 *    earlier deploy already failed on the baseline (an unfinished row is not a
 *    finished one, so it takes the same path).
 *  - **`User` exists, baseline recorded, later migrations still pending** --
 *    the ordinary case. Do nothing and let them apply.
 *
 * ## The case this refuses
 *
 * A restore can leave a current schema beside an older `_prisma_migrations` --
 * for instance a database dump restored over a history snapshot from a
 * different moment. `migrate deploy` would then try to add columns that are
 * already there and fail with P3018, leaving the poisoned row behind.
 *
 * That state is ambiguous: the pending migrations might be genuinely needed,
 * or already reflected. Rather than guess, this detects it -- pending
 * migrations *and* a schema that already matches `schema.prisma` exactly --
 * and refuses with the commands to resolve it. Refusing leaves the database
 * untouched; proceeding would not.
 *
 * ## Migrations the diff cannot see
 *
 * "Matches `schema.prisma`" is evidence only about what `migrate diff`
 * compares. A migration that adds only a partial or expression index, a CHECK
 * constraint, a trigger or a function matches before it is applied as well as
 * after, so on its own it would always be refused. Such a migration names the
 * relation it creates (`-- baseline-check: present-if-relation "Name"`), or the
 * function (`present-if-function "name"`) when it creates only a function.
 * A function replacement may instead pin the exact prior body digest. A
 * checksum-bound `baseline-check.json` may pin every exact prior CHECK
 * definition for already-shipped SQL that cannot gain a header declaration.
 * Only a proven absent object or an exact prior replacement state permits the deploy.
 * See `scripts/baseline-presence-core.mjs`.
 */

const BASELINE_MIGRATION = "00000000000000_baseline";
const MIGRATIONS_DIR = resolvePath(import.meta.dirname, "..", "prisma", "migrations");
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

const localMigrations = () =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

/** True when the database already matches schema.prisma exactly. */
const schemaMatchesPrisma = () => {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",
      "migrate",
      "diff",
      "--from-schema",
      "prisma/schema.prisma",
      "--to-config-datasource",
      "prisma.config.ts",
      "--exit-code",
    ],
    { stdio: "pipe" }
  );
  // 0 = no difference, 2 = differences, 1 = error.
  return result.status === 0;
};

const newClient = () =>
  new Client({
    connectionString: normalizeConnectionString(directUrl),
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    application_name: "tomverse-prisma-baseline-check",
  });

let client;
let shouldResolve = false;

try {
  // The same bounded retry the probe before this one uses. This connect is the
  // second of the three `db:migrate` opens, and a momentary upstream blip here
  // fails a deploy exactly as it does there.
  client = await connectWithRetry(newClient, {
    onRetry: (attempt, delayMs) =>
      log(
        `Could not reach the database; retrying in ${
          delayMs / 1_000
        }s (${attempt}/${CONNECT_RETRY_COUNT}).`
      ),
  });

  // The schema decides, not the history. A `db push` database has every table
  // and an empty history; reading the history first would call it fresh.
  const { rows: schemaRows } = await client.query(
    `SELECT to_regclass('public."User"') IS NOT NULL AS present`
  );
  if (!schemaRows[0]?.present) {
    log("No schema present; treating this as a fresh database.");
    process.exit(0);
  }

  const { rows: historyRows } = await client.query(
    `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`
  );
  const recorded = historyRows[0]?.present
    ? (
        await client.query(
          `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`
        )
      ).rows.map((row) => row.migration_name)
    : [];
  const recordedSet = new Set(recorded);

  if (!recordedSet.has(BASELINE_MIGRATION)) {
    shouldResolve = true;
    log(
      "The schema is present but the baseline is not recorded. Marking it applied.",
      { recordedMigrations: recorded.length, baseline: BASELINE_MIGRATION }
    );
  }

  // Anything still pending after the baseline is resolved.
  const pending = localMigrations().filter(
    (name) => name !== BASELINE_MIGRATION && !recordedSet.has(name)
  );
  if (pending.length > 0 && schemaMatchesPrisma()) {
    // The match is no evidence about a migration the diff cannot see. Each one
    // may name the relation or function it creates; only proof that every one of them is
    // absent lets the deploy go on.
    const { probes, undeclared } = pendingProbes(pending, (name) =>
      readFileSync(joinPath(MIGRATIONS_DIR, name, "migration.sql"), "utf8"),
      (name) => {
        try {
          return readFileSync(joinPath(MIGRATIONS_DIR, name, "baseline-check.json"), "utf8");
        } catch (error) {
          if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
          throw error;
        }
      },
    );
    if (undeclared.length === 0) {
      const answers = new Map();
      for (const probe of probes) {
        const { name } = probe;
        // One fixed question with the declared name bound as a parameter: a
        // migration supplies a name, never SQL. Read-only and rolled back as
        // well, though the fixed query has nothing to write.
        await client.query(
          probe.replacedChecks !== undefined
            ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
            : "BEGIN READ ONLY",
        );
        try {
          if (probe.replacedChecks !== undefined) {
            const checkAnswers = [];
            for (const check of probe.replacedChecks) {
              const { rows } = await client.query(checkDefinitionQuery(check));
              checkAnswers.push(
                checkReplacementAnswer(rows, check.previousDefinitionSha256),
              );
            }
            answers.set(name, checkReplacementSetAnswer(checkAnswers));
          } else {
            const { rows } = await client.query(presenceQueryFor(probe));
            // A replacement must match the exact previous body. Other probes
            // answer one boolean. Unknown or malformed answers fail closed.
            answers.set(
              name,
              probe.previousBodySha256 !== undefined
                ? replacementAnswer(rows, probe.previousBodySha256)
                : presenceAnswer(rows)
            );
          }
        } catch {
          answers.set(name, undefined);
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
        }
      }
      const verdict = presenceVerdict(pending, answers);
      if (verdict.proceed) {
        log(
          "Pending migrations change nothing schema.prisma describes; every declared object is absent or every replacement has the exact prior function/CHECK definition. Letting migrate deploy apply them.",
          { pending }
        );
      } else {
        fail(
          "This database already matches schema.prisma, and at least one pending migration is neither proven absent nor in its exact prior function/CHECK state. Nothing has been changed.",
          { pending, notProvenAbsent: verdict.notProvenAbsent }
        );
      }
    } else {
      fail(
        "This database already matches schema.prisma, but migrations are recorded as unapplied. `migrate deploy` would try to re-apply them and fail with P3018, leaving a failed row that blocks every later deploy. This usually means a restore paired a database dump with an older _prisma_migrations. Nothing has been changed. If these migrations really are already in place, record them and re-run the deploy.",
        {
          pending,
          recordedMigrations: recorded.length,
          command: `prisma migrate resolve --applied ${pending.join(" --applied ")}`,
          undeclared,
        }
      );
    }
  }
} catch (error) {
  const message =
    error && typeof error === "object" && typeof error.message === "string"
      ? error.message.replaceAll(directUrl, "[redacted]")
      : "Unknown PostgreSQL error.";
  fail("Could not read the migration history.", {
    errorMessage: message.slice(0, 500),
  });
} finally {
  // `client` is unset when every connect attempt failed; those clients were
  // already closed inside the retry loop.
  await client?.end().catch(() => undefined);
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

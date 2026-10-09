import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { DriverAdapterError } from "@prisma/driver-adapter-utils";

import {
  AMUX_COMMIT_DEADLINE_TABLE,
  AMUX_COMMIT_DEADLINE_TRIGGER,
  AMUX_LATE_COMMIT_MESSAGE,
  AMUX_LATE_COMMIT_SQLSTATE,
  isAmuxLateCommitError,
} from "../lib/amux/commitDeadlineCore.ts";
import { autoTransactionFailure } from "../lib/amux/autoPromotionCore.ts";
import {
  AMUX_COMMIT_DEADLINE_MIGRATION,
  AMUX_COMMIT_DEADLINE_THIS_TRIGGER,
  AMUX_COMMIT_DEADLINE_TRIGGER_MATCHES,
  amuxCommitDeadlineInstallSql,
  amuxCommitDeadlineInstallStatements,
  readAmuxCommitDeadlineInstallSql,
} from "../scripts/amux-commit-deadline-install.mjs";

// Orchestration policy version 18, "활성화 증거": the database refuses an AMUX
// COMMIT that arrives after its deadline. These pin the structure the routing
// lane's database tests rely on (tests/integration/amux-orchestration.db.test.ts)
// and the classification tests/server-contract/amux-commit-deadline-boundary.test.ts
// drives through the real Prisma client.

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const between = (source, from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} .. ${to}`);
  return source.slice(start, end);
};
const filesUnder = (directory) =>
  readdirSync(join(root, directory), { recursive: true })
    .map((name) => `${directory}/${String(name).replaceAll("\\", "/")}`)
    .filter((path) => /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(path))
    .sort();

const migration = read(AMUX_COMMIT_DEADLINE_MIGRATION);
const boundary = read("lib/amux/dbBoundary.ts");

// Migrations written after this one, each named here on purpose, so a new
// migration cannot slip in ahead of it by a mistyped timestamp.
const MIGRATIONS_AFTER_COMMIT_DEADLINE = new Set([
  // Orchestration policy version 20: the orchestrator halt tables.
  "20260930120000_amux_orchestrator_halt",
  // Owner-approved AMUX intake v4 and orchestration v22: inert additive
  // schema. This set orders migrations; it does not exempt their own guards.
  "20261001102000_amux_v4_idea_schema",
  "20261001102100_amux_v4_portfolio_schema",
  // AMUX intake v4: additive request identity fence for dark idea submission.
  "20261001102200_amux_v4_idea_submission_request_id",
  // AMUX intake v7: separately purgeable normalized draft units, still dark.
  "20261001102300_amux_v4_draft_units",
  // AMUX intake v4: canonical references for cross-chunk draft units, still dark.
  "20261001102400_amux_v4_draft_local_ref",
  // AMUX intake v4 (policy v8): database-owned node archive clock, still dark.
  "20261001102500_amux_v4_node_retention_clock",
  // AMUX intake v4: owner decision receipt ledger, still dark.
  "20261001102600_amux_v4_unit_decisions",
  // AMUX intake v4: operator-controlled Frontier eligibility, still dark.
  "20261001111800_amux_v4_frontier_model_catalog",
  // AMUX intake v4: immutable source-plan revision and per-revision cursor.
  "20261002100000_amux_v4_source_plan_revision",
  // AMUX v4 worker CLI usage: additive invocation and aggregate evidence.
  "20261002150000_amux_cli_usage_invocation",
  "20261002160000_amux_cli_usage_aggregate_final",
  "20261002170000_amux_cli_usage_role_snapshot",
  "20261002180000_amux_cli_aggregate_role_vocabulary",
  "20261002190000_amux_cli_usage_year_insert_fence",
  // AMUX v4 idea-analysis budget ledger: additive and dark.
  "20261003100000_amux_v4_analysis_budget_ledger",
  "20261003110000_amux_v4_analysis_budget_total_check",
  "20261003120000_amux_v4_analysis_price_versions",
  "20261003130000_amux_v4_chunk_completion_deadline",
  "20261004190000_amux_v4_content_key_retirement",
  "20261004190100_amux_v4_retention_hold",
  "20261004190200_amux_v4_content_no_resurrection",
  "20261005010000_amux_v4_story_kind",
  // A09: immutable, non-body owner confirmation metadata.
  "20261005030000_amux_v4_unit_confirmation_snapshot",
  "20261005040000_amux_v4_registration_consistency",
  "20261005050000_amux_v4_task_cost_catalog_approval",
  "20261005060000_amux_v4_rejection_consistency",
  "20261005070000_amux_v4_node_link_consistency",
  "20261005080000_amux_v4_card_link_consistency",
  "20261005090000_amux_v4_unit_actor_scope",
  "20261005100000_amux_v4_derivation_groups",
  "20261005110000_amux_v4_portfolio_scoring",
  "20261005120000_amux_v4_task_dag_guard",
  // A12: v22-only receipt and a separate, still-dark promotion gate.
  "20261006100000_amux_v22_auto_promotion",
  "20261006110000_amux_v22_worker_assignment",
  "20261006130000_amux_cli_usage_event",
  "20261006140000_amux_v22_execution_binding",
  "20261006150000_amux_v22_task_result",
  "20261006234000_amux_v22_task_patch",
  "20261007180000_amux_v4_prless_review_evidence",
  // AMUX Decision Maker policy version 1, S1b: the append-only switch events.
  "20261008030000_amux_decision_maker_switch",
  // S1c: the switch guard's READ COMMITTED check, and the request ledger,
  // whose own deferred check uses this migration's SQLSTATE (AX001).
  "20261008090000_amux_decision_maker_switch_serialization",
  "20261008090100_amux_decision_maker_request_ledger",
  // S1d: the body store, its retention events and the digest-key registry.
  // It adds no commit deadline of its own; the closing trigger it adds to the
  // request event table fires on closing events, which have none.
  "20261008120000_amux_decision_maker_body_store",
  // S1e: the stale close counted in hours, and a person's judgment and the
  // delivery records. Neither adds a commit deadline: a judgment's closing
  // event and a delivery event are not among the kinds the ledger's deferred
  // check covers.
  "20261008130000_amux_decision_maker_stale_close_hours",
  "20261008130100_amux_decision_maker_judgment_delivery",
  // AMUX intake v13: owner-only terminal accounting for a claimed analysis.
  "20261008130000_amux_v4_claim_owner_resolution",
]);

test("the migration is additive, later than every other AMUX migration but the ones named after it, and holds one table, one function and one trigger", () => {
  const directory = AMUX_COMMIT_DEADLINE_MIGRATION.split("/")[2];
  // Ordered after the AMUX migrations whose tables its trigger guards. It was
  // written as "later than every other migration", which held only until the
  // next migration of any feature landed after it.
  const others = readdirSync(join(root, "prisma", "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== directory && /amux/i.test(entry.name))
    .map((entry) => entry.name);
  assert.ok(others.length > 0);
  for (const name of others) {
    if (MIGRATIONS_AFTER_COMMIT_DEADLINE.has(name)) {
      assert.ok(name > directory, `${name} was written after ${directory}`);
      continue;
    }
    assert.ok(name < directory, `${name} sorts after ${directory}`);
  }

  const statements = migration
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");
  assert.match(
    statements,
    /CREATE TABLE "AmuxCommitDeadline" \(\n {4}"txid" BIGINT NOT NULL,\n {4}"deadline" TIMESTAMPTZ\(3\) NOT NULL,\n {4}"operation" TEXT NOT NULL,\n\n {4}CONSTRAINT "AmuxCommitDeadline_pkey" PRIMARY KEY \("txid"\)\n\);/,
  );
  assert.doesNotMatch(statements, /\bDROP\b|\bALTER\b|\bTRUNCATE\b|\bUPDATE\b|\bVALIDATE\b/i);
  // The only DELETE is the trigger removing its own row.
  assert.equal((statements.match(/\bDELETE\b/g) ?? []).length, 1);
  assert.match(statements, /'DELETE FROM %I\.%I WHERE "txid" = \$1',\s*TG_TABLE_SCHEMA,\s*TG_TABLE_NAME\s*\) USING NEW\."txid";/);
  assert.equal((statements.match(/\bCREATE\b/g) ?? []).length, 3);
  assert.match(statements, /^BEGIN;$/m);
  assert.match(statements, /^COMMIT;$/m);
});

test("the trigger is deferred to COMMIT and raises AX001 at or after the stored deadline", () => {
  assert.equal(AMUX_COMMIT_DEADLINE_TABLE, "AmuxCommitDeadline");
  assert.equal(AMUX_COMMIT_DEADLINE_TRIGGER, "amux_commit_deadline_check");
  assert.equal(AMUX_LATE_COMMIT_SQLSTATE, "AX001");
  assert.equal(AMUX_LATE_COMMIT_MESSAGE, "AMUX_LATE_COMMIT");
  assert.match(
    migration,
    /CREATE CONSTRAINT TRIGGER "amux_commit_deadline_check"\n {4}AFTER INSERT ON "AmuxCommitDeadline"\n {4}DEFERRABLE INITIALLY DEFERRED\n {4}FOR EACH ROW EXECUTE FUNCTION "amux_commit_deadline_check"\(\);/,
  );
  const body = between(migration, 'CREATE OR REPLACE FUNCTION "amux_commit_deadline_check"()', "$$;");
  assert.match(body, /SET search_path = pg_catalog, pg_temp/);
  assert.match(
    body,
    /IF pg_catalog\.clock_timestamp\(\) >= NEW\."deadline" THEN\n\s*RAISE EXCEPTION 'AMUX_LATE_COMMIT' USING ERRCODE = 'AX001';\n\s*END IF;/,
  );
  assert.match(body, /RETURN NULL;/);
});

test("the Prisma model matches the migrated table, so migrate diff stays clean", () => {
  const schema = read("prisma/schema.prisma");
  const model = between(schema, "model AmuxCommitDeadline {", "\n}");
  const fields = model
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("///"))
    .map((line) => line.split(/\s+/).join(" "));
  assert.deepEqual(fields, [
    "txid BigInt @id",
    "deadline DateTime @db.Timestamptz(3)",
    "operation String",
  ]);
});

test("both fences insert the marker, check the trigger, and compare the clock with the stored deadline", () => {
  const code = withoutComments(boundary);
  const mutation = between(code, '} else {\n', "requireAmuxCommitFence(fence, boundary.operation);");
  const route = between(code, "export async function fenceAmuxRouteDeadline(", "requireAmuxCommitFence(fence, operation);");
  for (const [name, fence] of [
    ["withAmuxDbBoundary mutation fence", mutation],
    ["fenceAmuxRouteDeadline", route],
  ]) {
    assert.match(fence, /date_trunc\(\s*'milliseconds',/, name);
    assert.match(fence, /-\s+\$\{AMUX_DB_COMMIT_RESERVE_MS\} \* INTERVAL '1 millisecond'/, name);
    assert.match(fence, /INSERT INTO "AmuxCommitDeadline" \("txid", "deadline", "operation"\)/, name);
    assert.match(fence, /SELECT txid_current\(\), "deadline", \$\{/, name);
    assert.match(fence, /RETURNING "deadline"/, name);
    assert.match(fence, /JOIN pg_catalog\.pg_class c ON c\.oid = t\.tgrelid/, name);
    assert.match(fence, /c\.oid = to_regclass\('"AmuxCommitDeadline"'\)/, name);
    assert.match(fence, /t\.tgname = \$\{AMUX_COMMIT_DEADLINE_TRIGGER\}/, name);
    assert.match(fence, /t\.tgdeferrable\s+AND t\.tginitdeferred/, name);
    assert.match(fence, /clock_timestamp\(\) < marker\."deadline" AS "withinDeadline"/, name);
    assert.match(fence, /commit_check\."installed" AS "commitCheckInstalled"/, name);
  }
  // The mutation fence's D is the earliest of all three deadlines it compared before.
  assert.match(
    mutation,
    /LEAST\(\s*current_setting\('tomverse\.amux_deadline'\)::timestamptz,\s*\$\{routeDeadlineIso\}::timestamptz,\s*\$\{leaseDeadlineIso\}::timestamptz\s*\) - \$\{AMUX_DB_COMMIT_RESERVE_MS\}/,
  );
  // A read transaction keeps its plain fence and writes nothing.
  const read = between(code, 'if (boundary.isolation === "read") {\n', "} else {\n");
  assert.doesNotMatch(read, /AmuxCommitDeadline|INSERT|txid_current/);
  assert.match(read, /AS "withinDeadline"/);

  // A missing trigger is checked before the clock and refuses.
  const verdict = between(code, "const requireAmuxCommitFence = (", "export type AmuxDbBoundaryPhase");
  assert.ok(verdict.indexOf("commitCheckInstalled !== true") < verdict.indexOf("withinDeadline !== true"));
  assert.match(verdict, /"AMUX_DB_COMMIT_CHECK_MISSING"/);
  assert.match(verdict, /console\.warn\(/);
});

test("the committing phase starts only after the fence, and AX001 is read before it in both classifiers", () => {
  const code = withoutComments(boundary);
  const body = between(code, "export async function withAmuxDbBoundary<T>(", "\n}\n");
  // `starting` until Prisma runs the callback, then `running` as the
  // callback's first statement, then `committing` after the fence.
  assert.match(body, /let phase: AmuxDbBoundaryPhase = "starting";\s*const transaction = prisma\.\$transaction\(\s*async \(rawTx\) => \{\s*phase = "running";/);
  assert.match(body, /requireAmuxCommitFence\(fence, boundary\.operation\);\s*\}\s*phase = "committing";\s*return result;\s*\}/);
  assert.match(
    body,
    /return transaction\.catch\(\(error: unknown\): never => \{\s*const failure = amuxDbBoundaryFailure\(\s*boundary,\s*phase,\s*error,\s*amuxRouteWriteState\(routeDeadline\),?\s*\);/,
  );
  // A mutation marks its route when its callback begins -- after `running`
  // and before its first statement -- so a later failure of the route cannot
  // be answered as "nothing was written". A mutation that never got its
  // connection ran nothing and does not mark it.
  const marker = body.indexOf("routeDeadline.mutationStarted = true;");
  assert.ok(marker > body.indexOf('phase = "running";'));
  assert.ok(marker < body.indexOf("rawTx.$queryRaw"));
  assert.equal(body.indexOf("routeDeadline.mutationStarted = true;", marker + 1), -1);
  // The connection wait is the route-capped one.
  assert.match(body, /maxWait: connectionWaitMs,/);

  const failure = between(code, "export const amuxDbBoundaryFailure = (", "\n};\n");
  assert.ok(failure.indexOf("isAmuxLateCommitError(error)") > 0);
  assert.ok(failure.indexOf("isAmuxLateCommitError(error)") < failure.indexOf('phase === "committing"'));
  assert.match(failure, /isAmuxLateCommitError\(error\)\) \{\s*return new AmuxDbBoundaryError\(\s*"AMUX_DB_DEADLINE_EXCEEDED"/);
  assert.match(failure, /phase === "committing" && boundary\.isolation === "mutation"\) \{\s*return new AmuxDbBoundaryError\(\s*"AMUX_DB_OUTCOME_UNKNOWN"/);
  // The busy answers are decided after both, only in a route that started
  // nothing that can write: a start refusal only while `starting`, the read
  // rule only for a read.
  assert.ok(failure.indexOf('"AMUX_DB_OUTCOME_UNKNOWN"') < failure.indexOf('"AMUX_DB_NOT_STARTED"'));
  assert.ok(failure.indexOf('"AMUX_DB_NOT_STARTED"') < failure.indexOf('"AMUX_DB_READ_BUSY"'));
  assert.match(
    failure,
    /routeWrites !== "no_mutation_started" \|\|\s*error instanceof AmuxDbBoundaryError\s*\) \{\s*return error;\s*\}/,
  );
  assert.match(
    failure,
    /phase === "starting" && amuxTransactionNotStartedCode\(error\) !== null\) \{\s*return new AmuxDbBoundaryError\("AMUX_DB_NOT_STARTED"/,
  );
  assert.match(
    failure,
    /boundary\.isolation === "read" &&\s*amuxTransientDatabaseCode\(error\) !== null\s*\) \{\s*return new AmuxDbBoundaryError\("AMUX_DB_READ_BUSY"/,
  );

  const core = withoutComments(read("lib/amux/autoPromotionCore.ts"));
  const auto = between(core, "export const autoTransactionFailure = (", "\n};\n");
  assert.ok(auto.indexOf("isAmuxLateCommitError(error)") > 0);
  assert.ok(auto.indexOf("isAmuxLateCommitError(error)") < auto.indexOf('phase === "committing"'));

  // The internal route answers the boundary's unknown outcome as it answers P2028.
  const route = withoutComments(read("lib/amux/internalRoute.ts"));
  assert.match(
    route,
    /databaseCode === "P2028" \|\|\s*\(error instanceof AmuxDbBoundaryError &&\s*error\.code === "AMUX_DB_OUTCOME_UNKNOWN"\)\s*\) \{\s*const incident = reportAmuxOperationalIncident/,
  );
});

// Every shape AX001 can arrive in. The first is what the Prisma 7 transaction
// manager rethrows at COMMIT, built with the adapter's own class.
const adapterCause = {
  originalCode: "AX001",
  originalMessage: "AMUX_LATE_COMMIT",
  kind: "postgres",
  code: "AX001",
  severity: "ERROR",
  message: "AMUX_LATE_COMMIT",
};
const lateCommitShapes = [
  new DriverAdapterError(adapterCause),
  {
    name: "PrismaClientKnownRequestError",
    code: "P2010",
    message: "Raw query failed. Code: `AX001`. Message: `AMUX_LATE_COMMIT`",
    meta: { driverAdapterError: new DriverAdapterError(adapterCause) },
  },
  { name: "PrismaClientKnownRequestError", code: "P2010", meta: { code: "AX001", message: "AMUX_LATE_COMMIT" } },
  Object.assign(new Error("AMUX_LATE_COMMIT"), { code: "AX001", severity: "ERROR" }),
];

test("AX001 is recognised wherever Prisma or the adapter put it, and only by its code", () => {
  for (const error of lateCommitShapes) assert.equal(isAmuxLateCommitError(error), true);

  const cyclic = { code: "P2010", meta: {} };
  cyclic.meta.driverAdapterError = cyclic;
  for (const error of [
    null,
    undefined,
    "AX001",
    new Error("AMUX_LATE_COMMIT"),
    { message: "AMUX_LATE_COMMIT", meta: { message: "AMUX_LATE_COMMIT" } },
    new DriverAdapterError({ ...adapterCause, code: "57014", originalCode: "57014" }),
    { code: "P2028", message: "Transaction already closed" },
    cyclic,
  ]) {
    assert.equal(isAmuxLateCommitError(error), false, String(error?.message ?? error));
  }
});

test("the auto-promotion classifier reads AX001 before the committing shortcut", () => {
  for (const error of lateCommitShapes) {
    for (const phase of ["starting", "running", "committing"]) {
      assert.equal(autoTransactionFailure(phase, error), "deadline_exceeded", phase);
    }
  }
  const cancelled = new DriverAdapterError({ ...adapterCause, code: "57014", originalCode: "57014" });
  assert.equal(autoTransactionFailure("committing", cancelled), "outcome_unknown");
  assert.equal(autoTransactionFailure("committing", new Error("Connection terminated unexpectedly")), "outcome_unknown");
});

test("no AMUX code, nor code that attaches to an AMUX transaction, runs SET CONSTRAINTS", () => {
  const scanned = [
    ...filesUnder("lib/amux"),
    ...filesUnder("app/api/internal/amux"),
    ...filesUnder("app/api/admin/amux"),
    // Adapters run inside an AMUX writer's transaction (AmuxAttachment).
    ...["lib", "app"].flatMap((directory) =>
      filesUnder(directory).filter(
        (path) =>
          !path.startsWith("lib/amux/") &&
          !path.startsWith("app/api/internal/amux/") &&
          !path.startsWith("app/api/admin/amux/") &&
          read(path).includes("@/lib/amux/dbBoundary"),
      ),
    ),
  ];
  assert.ok(scanned.includes("lib/amux/dbBoundary.ts"));
  assert.ok(scanned.includes("lib/engineeringAgentAmuxAdapter.ts"));
  assert.ok(scanned.includes("app/api/internal/amux/tasks/route.ts"));
  const offenders = scanned.filter((path) => /SET\s+CONSTRAINTS/i.test(read(path)));
  assert.deepEqual(offenders, []);
});

test("only the named AMUX receipt and admission routes open direct transactions", () => {
  const routes = filesUnder("app/api/internal/amux");
  assert.ok(routes.length > 10);
  const direct = routes.filter((path) => /\$transaction\s*\(/.test(withoutComments(read(path))));
  // The analysis admission routes predate A09 and own their explicit
  // reconciliation contracts; the commit-deadline boundary still governs
  // orchestration task execution.
  assert.deepEqual(direct, [
    "app/api/internal/amux/cli-usage/route.ts",
    "app/api/internal/amux/tasks/route.ts",
    "app/api/internal/amux/v22/execution/result/route.ts",
    "app/api/internal/amux/v4/analysis-claim/route.ts",
    "app/api/internal/amux/v4/analysis-result/route.ts",
  ]);
  // Intake v15 opens only the code latches. The independent runtime write
  // and receipt-read switches still fail closed before a transaction opens.
  // Both transaction bounds remain independent of execution commit deadlines.
  const claim = "app/api/internal/amux/v4/analysis-claim/route.ts";
  const result = "app/api/internal/amux/v4/analysis-result/route.ts";
  for (const [path, latch] of [[claim, "CLAIM"], [result, "RESULT"]]) {
    const source = withoutComments(read(path));
    assert.match(source, new RegExp(`const ${latch}_CODE_LATCH = true;`));
    assert.match(source, new RegExp(`const ${latch}_WRITE_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_${latch}_WRITE";`));
    assert.match(source, new RegExp(`const ${latch}_RECEIPT_READ_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_${latch}_READ";`));
    const post = between(source, "export async function POST", "export async function GET");
    const writeGate = `process.env[${latch}_WRITE_ENV] !== "enabled"`;
    const readGate = `process.env[${latch}_RECEIPT_READ_ENV] !== "enabled"`;
    assert.ok(post.includes(`!${latch}_CODE_LATCH || ${writeGate}`));
    assert.ok(post.includes(`!${latch}_RECEIPT_READ_CODE_LATCH ||`));
    assert.ok(post.includes(readGate));
    assert.ok(post.indexOf(writeGate) < post.indexOf("prisma.$transaction"));
    assert.ok(post.indexOf(readGate) < post.indexOf("prisma.$transaction"));
    const receiptRead = source.slice(source.indexOf("export async function GET"));
    assert.ok(receiptRead.includes(readGate));
    assert.ok(!receiptRead.includes(`process.env[${latch}_WRITE_ENV]`));
    assert.match(source, /isAmuxV4AnalysisAgentAuthorized/);
    assert.match(source, /AMUX_V4_ANALYSIS_AGENT_SECRET_ENV/);
    assert.match(source, /maxWait: 5_000, timeout: 15_000/);
    assert.match(source, /maxWait: 5_000, timeout: 10_000/);
    assert.match(source, /callbackReturned = true/);
  }
});

test("the push harnesses install the migration's own function and trigger, idempotently", () => {
  const [functionSql, triggerSql] = amuxCommitDeadlineInstallStatements(migration);
  const beginMarker = "-- amux-commit-deadline-check:install:begin\n";
  const marked = between(migration, beginMarker, "-- amux-commit-deadline-check:install:end").slice(
    beginMarker.length,
  );
  assert.equal(`${functionSql};\n\n${triggerSql};\n`, marked);
  assert.ok(functionSql.startsWith('CREATE OR REPLACE FUNCTION "amux_commit_deadline_check"()'));
  assert.ok(triggerSql.startsWith('CREATE CONSTRAINT TRIGGER "amux_commit_deadline_check"'));

  const install = readAmuxCommitDeadlineInstallSql(root);
  assert.equal(install, amuxCommitDeadlineInstallSql(migration));
  assert.ok(install.includes(functionSql) && install.includes(triggerSql));

  // Under the lock, in this order: the function is always replaced, a
  // differing trigger is dropped, a missing one is created.
  const lock = install.indexOf("pg_advisory_xact_lock(");
  const replaceFunction = install.indexOf(functionSql);
  const dropIfDiffers = install.indexOf("  IF EXISTS (");
  const drop = install.indexOf(`EXECUTE 'DROP TRIGGER "amux_commit_deadline_check" ON "AmuxCommitDeadline"';`);
  const createIfMissing = install.indexOf("  IF NOT EXISTS (");
  const create = install.indexOf(triggerSql);
  assert.ok(lock > 0);
  assert.ok(lock < replaceFunction && replaceFunction < dropIfDiffers, "the function is replaced before any condition");
  assert.ok(dropIfDiffers < drop && drop < createIfMissing && createIfMissing < create);
  const aroundFunction =
    install.slice(lock, replaceFunction) + install.slice(replaceFunction + functionSql.length, dropIfDiffers);
  assert.doesNotMatch(aroundFunction, /\bIF\b/, "replacing the function is unconditional");
  assert.equal(install.split("IF EXISTS (").length, 2);
  assert.equal(install.split("IF NOT EXISTS (").length, 2);

  // "Differs" is every attribute the migration's statement fixes.
  const differs = install.slice(dropIfDiffers, drop);
  for (const attribute of AMUX_COMMIT_DEADLINE_THIS_TRIGGER) assert.ok(differs.includes(attribute), attribute);
  assert.match(differs, /AND NOT COALESCE\(/);
  for (const attribute of AMUX_COMMIT_DEADLINE_TRIGGER_MATCHES) assert.ok(differs.includes(attribute), attribute);
  assert.deepEqual(AMUX_COMMIT_DEADLINE_TRIGGER_MATCHES, [
    "t.tgdeferrable",
    "t.tginitdeferred",
    "t.tgenabled = 'O'",
    "t.tgtype::integer = 5",
    "t.tgconstraint <> 0",
    "t.tgqual IS NULL",
    "t.tgnargs = 0",
    "pg_catalog.array_length(t.tgattr::pg_catalog.int2[], 1) IS NULL",
    `t.tgfoid = pg_catalog.to_regprocedure('"amux_commit_deadline_check"()')`,
  ]);
  const createGuard = install.slice(createIfMissing, create);
  for (const attribute of AMUX_COMMIT_DEADLINE_THIS_TRIGGER) assert.ok(createGuard.includes(attribute), attribute);
  // Same input, same statement: nothing in it depends on when or where it runs.
  assert.equal(amuxCommitDeadlineInstallSql(migration), install);

  assert.throws(() => amuxCommitDeadlineInstallStatements("CREATE TABLE x ();"), /exactly once/);
  assert.throws(
    () => amuxCommitDeadlineInstallStatements(migration.replace("CREATE CONSTRAINT TRIGGER", "CREATE TRIGGER")),
    /exactly once/,
  );
  // A trigger the comparison above does not describe is refused, not installed.
  for (const changed of [
    migration.replace("AFTER INSERT ON", "AFTER INSERT OR UPDATE ON"),
    migration.replace("DEFERRABLE INITIALLY DEFERRED", "DEFERRABLE INITIALLY IMMEDIATE"),
    migration.replace("FOR EACH ROW EXECUTE", "FOR EACH ROW WHEN (NEW.\"txid\" > 0) EXECUTE"),
  ]) {
    assert.notEqual(changed, migration);
    assert.throws(() => amuxCommitDeadlineInstallSql(changed), /no longer has the shape this installer compares/);
  }

  // Admin E2E: installed once per process before the first reset, then proven.
  const database = withoutComments(read("tests/e2e-admin/support/database.ts"));
  assert.match(database, /from "\.\.\/\.\.\/\.\.\/scripts\/amux-commit-deadline-install\.mjs";/);
  const asserted = between(database, "const assertAdminSchemaPresent = async", "const ensureAmuxCommitDeadlineCheck");
  assert.match(asserted, /await ensureAmuxCommitDeadlineCheck\(\);\s*schemaAsserted = true;/);
  const ensure = between(database, "const ensureAmuxCommitDeadlineCheck = async", "\n};\n");
  assert.match(ensure, /\$executeRawUnsafe\(\s*readAmuxCommitDeadlineInstallSql\(process\.cwd\(\)\)\s*\)/);
  assert.match(ensure, /t\.tgdeferrable AS "deferrable", t\.tginitdeferred AS "initiallyDeferred"/);
  assert.match(ensure, /throw new Error\(/);

  // DB_INTEGRATION_SCHEMA_SOURCE=push, and only there: migrations create it.
  const runner = read("scripts/run-db-integration-tests.mjs");
  const push = between(runner, 'if (schemaSource === "push") {', "} else {");
  assert.match(push, /"db", "execute", "--stdin"/);
  assert.match(push, /input: readAmuxCommitDeadlineInstallSql\(/);
  assert.equal(runner.split('"db", "execute", "--stdin"').length, 2);
});

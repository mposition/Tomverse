import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { readAmuxCommitDeadlineInstallSql } from "./amux-commit-deadline-install.mjs";
import {
  DB_INTEGRATION_GROUPS,
  POSTGRES16_COMPAT_GROUP,
  POSTGRES16_COMPAT_SUITES,
  dbIntegrationGroupOf,
} from "./db-integration-groups.mjs";
import { isSamePostgresDatabaseTarget } from "../lib/postgresConnectionConfigCore.mjs";

const fail = (message) => {
  console.error(`DB integration test safety check failed: ${message}`);
  process.exit(1);
};

const rawTestDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawTestDatabaseUrl) {
  fail(
    "TEST_DATABASE_URL is required and must point to a dedicated PostgreSQL test database."
  );
}

let testDatabaseUrl;
try {
  testDatabaseUrl = new URL(rawTestDatabaseUrl);
} catch {
  fail("TEST_DATABASE_URL is not a valid URL.");
}

if (
  testDatabaseUrl.protocol !== "postgres:" &&
  testDatabaseUrl.protocol !== "postgresql:"
) {
  fail("TEST_DATABASE_URL must use the postgres or postgresql protocol.");
}

const databaseName = decodeURIComponent(testDatabaseUrl.pathname.replace(/^\//, ""));
const schemaName = testDatabaseUrl.searchParams.get("schema") || "";
const isolationMarker = `${databaseName}_${schemaName}`;
if (!/(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(isolationMarker)) {
  fail(
    "the database name or schema must contain a separate test marker such as tomverse_test."
  );
}

for (const [name, configuredUrl] of [
  ["DATABASE_URL", process.env.DATABASE_URL],
  ["DIRECT_DATABASE_URL", process.env.DIRECT_DATABASE_URL],
]) {
  if (
    configuredUrl?.trim() &&
    isSamePostgresDatabaseTarget(rawTestDatabaseUrl, configuredUrl.trim())
  ) {
    fail(
      `TEST_DATABASE_URL must not target the same PostgreSQL database as ${name}, even with different credentials or schema parameters.`
    );
  }
}

const testEnvironment = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: rawTestDatabaseUrl,
  DIRECT_DATABASE_URL: rawTestDatabaseUrl,
  NEXTAUTH_SECRET:
    process.env.NEXTAUTH_SECRET || "tomverse-db-integration-test-secret-2026",
  // The manifest digests have their own keyring rather than the session
  // secret, and lib/routingDispatchInstrumentation.ts refuses to digest
  // without one. Supplied here beside NEXTAUTH_SECRET because it is the same
  // kind of thing -- a secret the application needs to function at all -- and
  // because a suite that had to remember it would be a suite that eventually
  // forgot and reported the refusal as a product failure.
  MANIFEST_HASH_KEYS:
    process.env.MANIFEST_HASH_KEYS ||
    "db-integration-test:tomverse-db-integration-manifest-key-2026",
  MANIFEST_HASH_ACTIVE_KEY_ID:
    process.env.MANIFEST_HASH_ACTIVE_KEY_ID || "db-integration-test",
  CHAT_USER_CONCURRENT: "50",
  CHAT_USER_PER_MINUTE: "500",
  CHAT_IP_PER_MINUTE: "500",
  CHAT_FREE_COST_MICROUSD_PER_DAY: "100000000",
  CHAT_FREE_COST_MICROUSD_PER_MONTH: "100000000",
  CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY: "100000000",
  CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH: "100000000",
};

/**
 * Which lane this process runs. Unset runs everything, which is what a
 * developer wants locally and what `workflow_dispatch` gives an operator who
 * wants one answer rather than seven.
 */
const group = (process.env.DB_INTEGRATION_GROUP || "").trim();
if (group && group !== POSTGRES16_COMPAT_GROUP && !DB_INTEGRATION_GROUPS.includes(group)) {
  fail(
    `DB_INTEGRATION_GROUP must be one of ${[...DB_INTEGRATION_GROUPS, POSTGRES16_COMPAT_GROUP].join(", ")}; received "${group}".`
  );
}
if (group) {
  console.log(`[db-integration] Lane ${group}. Suites outside it run elsewhere.`);
}

/**
 * Runs a step, dropping the suites that belong to another lane.
 *
 * Filtering here rather than at each call site is what lets the list below
 * stay one ordered list with its reasoning attached: every `run()` keeps every
 * file it always named, and a lane simply skips the ones that are not its own.
 *
 * A step whose arguments name no suite at all -- the Prisma schema build -- is
 * never filtered. Each lane gets its own database and has to build it.
 */
const run = (args, label, environmentOverrides = {}) => {
  const suites = args.filter((arg) => arg.startsWith("tests/"));
  let selected = args;
  if (group && suites.length > 0) {
    const mine = suites.filter((suite) =>
      group === POSTGRES16_COMPAT_GROUP
        ? POSTGRES16_COMPAT_SUITES.includes(suite)
        : dbIntegrationGroupOf(suite) === group
    );
    if (mine.length === 0) return;
    selected = args.filter((arg) => !arg.startsWith("tests/") || mine.includes(arg));
  }
  console.log(`\n[db-integration] ${label}`);
  const result = spawnSync(process.execPath, selected, {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...testEnvironment, ...environmentOverrides },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};

console.log(
  `[db-integration] Using dedicated database ${databaseName} on ${testDatabaseUrl.hostname}.`
);

// How the test database gets its schema.
//
// `migrations` is the default because it is the only mode that proves anything
// about deployment: `db push` reads schema.prisma directly and would keep
// passing even if the migration history could not build the schema at all --
// which is exactly the state this repository was in until the baseline
// migration replaced it. Building from migrations and then asserting no drift
// also catches a schema.prisma change that nobody wrote a migration for.
//
// `push` stays available for local iteration on a schema whose migration is
// not written yet.
const schemaSource = (
  process.env.DB_INTEGRATION_SCHEMA_SOURCE || "migrations"
).trim();
if (!["migrations", "push"].includes(schemaSource)) {
  fail(
    `DB_INTEGRATION_SCHEMA_SOURCE must be "migrations" or "push"; received "${schemaSource}".`
  );
}

if (schemaSource === "push") {
  console.warn(
    "[db-integration] DB_INTEGRATION_SCHEMA_SOURCE=push: the migration history is NOT exercised by this run."
  );
  run(
    ["node_modules/prisma/build/index.js", "db", "push"],
    "Synchronizing the current Prisma schema"
  );
  // `db push` creates the AmuxCommitDeadline table and not the deferred
  // trigger that refuses a late COMMIT; without it every AMUX write is refused
  // with AMUX_DB_COMMIT_CHECK_MISSING. Applied from the migration's own text:
  // the function is always replaced, a trigger whose definition differs is
  // recreated, and a second run changes nothing.
  console.log(
    "\n[db-integration] Installing the AMUX commit deadline check from its migration"
  );
  const commitDeadlineCheck = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "db", "execute", "--stdin"],
    {
      cwd: resolve(import.meta.dirname, ".."),
      env: testEnvironment,
      input: readAmuxCommitDeadlineInstallSql(resolve(import.meta.dirname, "..")),
      stdio: ["pipe", "inherit", "inherit"],
    }
  );
  if (commitDeadlineCheck.error) throw commitDeadlineCheck.error;
  if (commitDeadlineCheck.status !== 0) {
    process.exit(commitDeadlineCheck.status || 1);
  }
} else {
  // `db push` regenerates the client as part of its work; `migrate deploy`
  // does not. Without this, a schema change that has been migrated but not
  // reinstalled fails as `Cannot read properties of undefined` on a model the
  // client has never heard of -- which says nothing about what is wrong.
  run(
    ["node_modules/prisma/build/index.js", "generate"],
    "Generating the Prisma client for the current schema"
  );
  run(
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    "Building the schema from the migration history"
  );
  run(
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
    "Checking the migrated schema for drift against schema.prisma"
  );
}
run(
  [
    "--conditions=react-server",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/credit-finance.db.test.ts",
    // An existing migration prefix through the actual pre-deploy db:migrate
    // path: CHECK-only changes are invisible to Prisma's structural diff.
    "tests/integration/migration-baseline-check-replacement.db.test.mjs",
    "tests/integration/chat-concurrency.db.test.ts",
    "tests/integration/chat-rate-limit.db.test.ts",
    "tests/integration/chat-token-quota.db.test.ts",
    "tests/integration/fallback-pricing-metrics.db.test.ts",
    "tests/integration/chat-attempt-usage.db.test.ts",
    "tests/integration/routing-attempt-sweep.db.test.ts",
    // AMUX scheduling ownership is a database CAS: two claimants must leave
    // exactly one owner and one append-only route decision, and a failed
    // decision write must roll the ownership change back.
    "tests/integration/amux-orchestration.db.test.ts",
    // Orchestration policy version 20: the orchestrator's write admission,
    // receipts written with the change under the admission's row lock, the
    // resolver that confirms a rollback only on that evidence, and the halt
    // that only a person clears -- each refused by the database, not only by
    // the application, when it is broken.
    "tests/integration/amux-orchestration-halt.db.test.ts",
    // AMUX v4/v22 receipts, retention and patch boundaries must execute in CI.
    "tests/integration/amuxCliUsageLedger.db.test.mjs",
    "tests/integration/amuxCliUsageRetention.db.test.mjs",
    "tests/integration/amuxCliUsageWriter.db.test.mjs",
    "tests/integration/amuxV22AutoPromotion.db.test.mjs",
    "tests/integration/amuxV22TaskPatchSchema.db.test.mjs",
    "tests/integration/amuxV22TaskResultSchema.db.test.mjs",
    "tests/integration/amuxV4DerivationService.db.test.mjs",
    "tests/integration/amuxV4PortfolioScore.db.test.mjs",
    "tests/integration/amuxV4TaskCostCatalog.db.test.mjs",
    "tests/integration/amuxV4UnitUnknownService.db.test.mjs",
    // The shared AgentDigestItem table: closed agent and kind lists, the
    // idempotency prefix, rows born with their body, and the expiry and purge
    // that are the only update and delete.
    "tests/integration/agent-digest-item.db.test.ts",
    // Its single writer: one row and one system audit entry in one transaction,
    // a replay or a conflict writes neither, and a refusal never opens one.
    "tests/integration/agent-digest-store.db.test.ts",
    // The billing-finance-ops stage W run: an enabled run records one digest
    // per environment and UTC day, a run past its deadline is refused by the
    // database and leaves nothing, and an unreadable switch is a fault.
    "tests/integration/billing-finance-ops-run.db.test.ts",
    // Its silence check (signal 2): today's digest, an incident when it is
    // missing, and an unreadable switch reported as itself, never as off.
    "tests/integration/billing-finance-ops-silence.db.test.ts",
    // Its two operator writes (W2): the switch and the monitor check, each with
    // its administrator audit entry in one transaction.
    "tests/integration/billing-finance-ops-control.db.test.ts",
    // The QA-release operator control record: consecutive revisions, each
    // audited by a person in its own transaction, and nothing ever changed.
    "tests/integration/qa-release-operator-control.db.test.ts",
    // The digest intake: secret, control revision and switch, closed schema,
    // then the single writer; one digest per UTC day.
    "tests/integration/qa-release-digest-intake.db.test.ts",
    // The Monitor silence check: its own secret, the control revision, then
    // the freshness verdict over the database clock.
    "tests/integration/qa-release-monitor.db.test.ts",
    // The merge lane's attempts: one open per lane, the core's lifecycle and
    // nothing else, every write audited by the right actor, no removal.
    "tests/integration/qa-release-merge-attempt.db.test.ts",
    // The merge lane's latch: consecutive events, set by the lane and
    // released by a person in the same transaction, nothing changed.
    "tests/integration/qa-release-merge-lane-latch.db.test.ts",
    // The merge lane's single writer: instruction issue under the app's own
    // judgement, one open attempt, a late round recorded as nothing.
    "tests/integration/qa-release-merge-lane-store.db.test.ts",
    // The merge lane service's three app calls: its own secret, the revision
    // it carries, a strict body, then the single writer.
    "tests/integration/qa-release-merge-lane-routes.db.test.ts",
    // The Admin Agent digest reader: counts and codes, expired and
    // unreadable bodies shown as such.
    "tests/integration/agent-digest-console.db.test.ts",
    // AMUX one-person review proposals and decisions must be DB-enforced,
    // append-only, and bound to the task, escalation and audit chain.
    "tests/integration/amux-agent-review-approval.db.test.ts",
    "tests/integration/amuxV4PrlessReviewGuard.db.test.mjs",
    // Explicit intake registration writes one backlog card, one body-free
    // draft, one consumed approval and one audit row, and leaves execution
    // and credit counts unchanged.
    "tests/integration/amux-intake-registration.db.test.ts",
    // Local intake writes one backlog card, one normalized row, one consumed
    // approval and one audit, and no dependency rows. apply returns before
    // the transaction while the code latch is false, so this test calls the
    // commit function directly.
    "tests/integration/amux-local-intake-registration.db.test.ts",
    // Source reconciliation appends one consumed run and per-card revisions.
    // Accept moves only the revision pointer. Reject leaves the pointer. The
    // public apply function returns before the transaction while the code
    // latch is false, so this test calls the commit function directly.
    "tests/integration/amux-reconciliation.db.test.ts",
    "tests/integration/amux-recommendation-pool.db.test.ts",
    "tests/integration/amux-auto-promotion.db.test.ts",
    // AMUX Decision Maker switches (docs/policy/amux-decision-maker.md §8,
    // §10): only off/proposal for an instance and on/off for the kill switch,
    // each event bound to its own transaction's audit by the right actor and
    // action, the newest event wins, and nothing is changed or removed.
    "tests/integration/amux-decision-maker-switch.db.test.ts",
    // AMUX Decision Maker request ledger (docs/policy/amux-decision-maker.md
    // §2, §6, §9, §10): one request per card revision, the transition graph
    // against the core's own, the deadlines by the database clock at the
    // insert and at COMMIT, one terminal result idempotent on its pair, each
    // event audited by the router or its instance, READ COMMITTED only.
    "tests/integration/amux-decision-maker-request.db.test.ts",
    // AMUX Decision Maker body store (docs/policy/amux-decision-maker.md
    // §10): the five fields within their caps, each bound to its own
    // transaction's audit and its request's registered key period, the
    // retention set at the close, holds, the expiry purge and the privacy
    // erase, the key destroyed only once nothing of its period remains, and
    // all of it allowed under the kill switch.
    "tests/integration/amux-decision-maker-body.db.test.ts",
    // AMUX Decision Maker judgment and delivery (docs/policy/amux-decision-maker.md
    // §2-6, §2-7, §4, §6, §9): one judgment per request closing it with its own
    // event and retention, a confirmation only on what Admin showed and never
    // under the kill switch, an edited answer stored with its judgment, the
    // delivery decision once and its outcome once, §4's report, and the stale
    // close at 720 hours across a daylight-saving change.
    "tests/integration/amux-decision-maker-judgment.db.test.ts",
    // Engineering adapter: the run is written in the AMUX writer's own
    // transaction after every AMUX lock, one fact or neither, and its
    // settlement meets delivery ack and expired recovery without a deadlock.
    // Mode off closes the whole gate, and a closed gate still records a
    // publisher's pull request on the engineering side only.
    "tests/integration/engineering-agent-amux-adapter.db.test.ts",
    // Engineering agent store: every change commits with its audit entry
    // under the right actor, and results go where the core says. It closes
    // what it opens, so it passes whichever engineering file runs first.
    "tests/integration/engineering-agent-store.db.test.ts",
    // Support-triage run record: the database owns the deadline, caps runs
    // at 52 per kind per UTC day under concurrency, downgrades a late success
    // and refuses deleting a row younger than 30 days.
    "tests/integration/support-triage-run.db.test.ts",
    // Support-triage timeouts: one call arms the lane timeouts, they survive
    // the call, a slow statement is cancelled, and on 17 a short inherited
    // transaction_timeout refuses the transaction before any write.
    "tests/integration/support-triage-timeouts.db.test.ts",
    // Support-triage run writer: a run row and its system audit entry commit
    // or roll back together, and a late finish is recorded as such.
    "tests/integration/support-triage-run-store.db.test.ts",
    // Support-triage retention: rows past their boundary go in audited
    // batches, a cancelling row is skipped and counted, and no progress is
    // reported as such.
    "tests/integration/support-triage-retention.db.test.ts",
    // Support-triage suggestions: the state machine, the lease and the
    // display stamp are the guard trigger's, and a report's deletion takes them.
    "tests/integration/support-triage-suggestion.db.test.ts",
    // Support-triage groups: one kind per group, members tied to its digest,
    // members then signals then the group when it ends, and the tombstone.
    "tests/integration/support-triage-group.db.test.ts",
    // Support-triage decision records: twelve months by CHECK, never updated,
    // at least one link at commit, and no record outlives any of its links.
    "tests/integration/support-triage-decision-record.db.test.ts",
    // Support-triage retention and heartbeat routes: own secrets, counts only,
    // non-2xx when retention makes no progress, a fail-closed heartbeat.
    "tests/integration/support-triage-routes.db.test.ts",
    // Support-triage worker pass: claim, fencing, lane and flags, reclaim,
    // supersede on a changed input, nothing for a closed or deleted report.
    "tests/integration/support-triage-worker.db.test.ts",
    // Support-triage new groups: one kind per group, the higher kind first, a
    // tombstoned key stops a second group, a member lost to a concurrent pass
    // empties and invalidates the group, and the pass membership budget.
    "tests/integration/support-triage-group-formation.db.test.ts",
    // Support-triage data in a real account deletion: the derived rows go in
    // that transaction, the reports stay anonymised, nothing is derived again.
    "tests/integration/support-triage-account-deletion.db.test.ts",
    // Engineering agent state: the triggers refuse a late success, a claim
    // without the next fencing token, a draft closed without its decision, a
    // second capability consumption and a rewritten snapshot, whoever writes.
    "tests/integration/engineering-agent-schema.db.test.ts",
    // sre-ops transaction bounds: the arming function refuses a short budget,
    // sets the statement and idle timers, and on PostgreSQL 17 replaces an
    // inherited transaction_timeout so the session ends at ours.
    "tests/integration/ops-observer-transaction-bounds.db.test.ts",
    // sre-ops genesis chain and state: chain shape, compare-and-set generation,
    // checkpoint order, trigger stamps, immutability, and no late COMMIT.
    "tests/integration/ops-observer-genesis-state.db.test.ts",
    // sre-ops transaction wrapper: READ COMMITTED, timers armed by statement 1,
    // the statement ceiling rolls back, assertNotLate refuses at the deadline.
    "tests/integration/ops-observer-transaction.db.test.ts",
    // sre-ops reservations: reserved then closed once by mode, one open at a
    // time, items only in their reservation's transaction and once per
    // incident kind, retention-only deletion, no late COMMIT.
    "tests/integration/ops-observer-delivery.db.test.ts",
    // AMUX v4 inert schema still has privacy ownership, hierarchy and source
    // integrity invariants. Exercise its database guards in the CI lane.
    "tests/integration/amuxV4Schema.db.test.mjs",
    // v22 Task edges must equal the owner receipt and remain acyclic;
    // pre-v4 cards retain their historical dependency behavior.
    "tests/integration/amuxV4TaskDag.db.test.mjs",
    // Keep A08's approved hierarchy/overlap catalog regression in the lane;
    // the DB coverage guard found this pre-existing suite was never listed.
    "tests/integration/amux-v4-resolution-catalog.db.test.ts",
    "tests/integration/amuxV4SourcePlan.db.test.mjs",
    "tests/integration/amux-v4-frontier-model.db.test.mjs",
    // Dark Frontier owner decisions must bind model eligibility, canonical
    // audit and versioned revocation without creating executable AMUX work.
    "tests/integration/amux-v4-frontier-catalog-write.db.test.ts",
    // Dark v4 submission must bind its owner, request idempotency and audit
    // atomically without opening collection, analysis or transfer.
    "tests/integration/amux-v4-idea-submission.db.test.ts",
    // The idea-only initial source plan is derived without a model call or
    // external excerpt, and its pointer, immutable row and audit are atomic.
    "tests/integration/amux-v4-initial-source-plan.db.test.ts",
    // The analysis-only USD 50 ledger migration must install its namespace,
    // one-preview hold and fail-closed lifecycle constraints in PostgreSQL.
    "tests/integration/amux-v4-analysis-budget.db.test.ts",
    // Retention must clear due bodies, preserve the audit trail and retire
    // external unit keys without silently extending a legal hold.
    "tests/integration/amux-v4-raw-retention.db.test.ts",
    "tests/integration/amux-v4-source-scope-preview.db.test.ts",
    // A08/A09 readback, derivation, cost-catalog and unknown-unit guards are
    // real DB contracts; they must run in the CI agent lane.
    "tests/integration/amux-v4-resolution-catalog.db.test.ts",
    "tests/integration/amuxV4DerivationService.db.test.mjs",
    "tests/integration/amuxV4TaskCostCatalog.db.test.mjs",
    "tests/integration/amuxV4UnitUnknownService.db.test.mjs",
    // sre-ops transition ledger: a row per advance in its own transaction, no
    // skipped generation, the signed audit entry's hash, append-only with
    // seven-year checkpoint-bound deletion, no late COMMIT.
    "tests/integration/ops-observer-transition.db.test.ts",
    // sre-ops trust check T3a: the migrations' catalogue is exactly the
    // expected one, and a dropped or re-deferred rule is seen.
    "tests/integration/ops-observer-catalog.db.test.ts",
    // sre-ops state read: the trust facts gathered in one bounded transaction,
    // trusted with the state or the reason only (own throwaway schema).
    "tests/integration/ops-observer-store-read.db.test.ts",
    // sre-ops advance: state, checkpoint, audit entry and ledger row in one
    // transaction; stale base, untrusted chain and unchanged keys write nothing.
    "tests/integration/ops-observer-store-advance.db.test.ts",
    // sre-ops advance with a reservation: owed items only, replay, channel
    // check, the daily cap counted in the store; refusals write nothing.
    "tests/integration/ops-observer-store-reserve.db.test.ts",
    // sre-ops confirm: the close decided by the genesis mode, replay, abandoned
    // and untrusted refusals.
    "tests/integration/ops-observer-store-confirm.db.test.ts",
    // sre-ops genesis: the owner's approval bound to the head, the transition
    // and seven-day rules, and a created chain the state read trusts.
    "tests/integration/ops-observer-store-genesis.db.test.ts",
    // sre-ops retention: closed reservations past ninety days deleted in
    // bounded batches with their items; reserved and recent rows stay.
    "tests/integration/ops-observer-store-retention.db.test.ts",
    // sre-ops run guard: born with its claimed deadline, immutable, kept 90 days,
    // and a late COMMIT rolls the whole transaction back.
    "tests/integration/ops-observer-run-guard.db.test.ts",
    // sre-ops digest item read: this agent's kept digest by id, bounded, and an
    // expired or malformed body shown as absent.
    "tests/integration/ops-observer-digest-item.db.test.ts",
    "tests/integration/model-registry.db.test.ts",
    // Prompt Refiner authority: stage-first locking, runtime price drift,
    // one-time consume and the permanent 100-slot/cost ceiling.
    "tests/integration/prompt-refiner-reservation.db.test.ts",
    // vNext one-shot storage remains dark but must commit exactly 80 fixed-
    // price slots and refuse consumption before run approval or any reuse.
    "tests/integration/prompt-refiner-vnext-one-shot-slots.db.test.ts",
    // The staging-only create-once writer: exact historical/current provenance,
    // audit atomicity, immutable approval and DB-clock expiry.
    "tests/integration/prompt-refiner-reservation-admission.db.test.ts",
    // One-run approval, atomic dispatch-intent/reservation consume, immutable
    // terminal receipts and stop-without-retry unknown recovery.
    "tests/integration/prompt-refiner-shadow-run.db.test.ts",
    "tests/integration/prompt-refiner-successor-migration.db.test.ts",
    "tests/integration/admin-security.db.test.ts",
    // The hash chain is walked in batches now, and a cursor that skips or
    // repeats a row is silent: a skipped row is reported as verified, and a
    // repeated one compares an entry against its own hash and invents a
    // linkage break in a sound chain.
    "tests/integration/admin-audit-integrity-walk.db.test.ts",
    "tests/integration/admin-users.db.test.ts",
    "tests/integration/login-methods.db.test.ts",
    "tests/integration/account-deletion.db.test.ts",
    "tests/integration/conversation-title.db.test.ts",
    "tests/integration/conversation-lock-migration.db.test.ts",
    // Durable Chat recovery is a database coordination contract: duplicate
    // claims, draft/checkpoint CAS, DB-clock leases and deletion cascades can
    // all look correct in one process while failing under PostgreSQL races.
    "tests/integration/chat-durable-recovery.db.test.ts",
    "tests/integration/provider-recovery.db.test.ts",
    "tests/integration/provider-failure-scope.db.test.ts",
    "tests/integration/provider-probe.db.test.ts",
    "tests/integration/subscription-sync-ordering.db.test.ts",
    "tests/integration/plan-change-reservation.db.test.ts",
    "tests/integration/image-generation.db.test.ts",
    // The constraints that make "a ready artifact always has a file" a fact
    // rather than a convention, and the tombstone ordering every deletion
    // path depends on. Neither can be checked without Postgres.
    "tests/integration/generated-artifacts.db.test.ts",
    // The unique index that turns a re-posted pre-save into a no-op, the
    // ownership-scoped resolution that makes another account's id "not found",
    // and the tombstone ordering every deletion path depends on -- including
    // the one that must NOT fire when a single model's answers are cleared.
    "tests/integration/message-attachments.db.test.ts",
    // The availability columns the expand migration added, and the rule that
    // makes them safe: only a confirmed 404 writes a verdict, so a rotated key
    // or a bucket outage cannot record an account as having lost its files.
    "tests/integration/message-attachment-availability.db.test.ts",
    "tests/integration/email-notification-schema.db.test.ts",
    // The permission ledger's constraints and triggers. Append-only, sealing and
    // verdict immutability are enforced in Postgres because a ledger the
    // application alone protects is one a migration or an admin script can
    // rewrite -- and the row it rewrites is the proof that a send was allowed.
    "tests/integration/email-permission-ledger.db.test.ts",
    // The ledger's first writers: the sealed cohort a risk_accepted approval
    // covers, and the one-time in-product notice. Here rather than in a unit
    // test because what is under test is whether the rows those writers build
    // survive the triggers -- a sealed approval refusing to change, and an
    // append-only table accepting a repeated render as one row rather than
    // raising on the second.
    "tests/integration/email-send-approval-cohort.db.test.ts",
    // The three ADR flags against the rows that hold them: the acceptance
    // criterion is about a delivery row *not* being created, which only the
    // table can confirm, and the fan-out gate needs a real event to expand.
    "tests/integration/email-feature-flags.db.test.ts",
    "tests/integration/credential-email-lane.db.test.ts",
    "tests/integration/standard-email-lane.db.test.ts",
    "tests/integration/email-webhook-suppression.db.test.ts",
    // Provider events applied in their own order, every permutation to one state,
    // and the sweep that records expired causes as released.
    "tests/integration/email-provider-event-order.db.test.ts",
    // The stored event state machine: leases, retries, waiting for a delivery,
    // and abandonment after ten attempts.
    "tests/integration/email-webhook-processing-lease.db.test.ts",
    // Recording the permanent bounces that were handled as soft ones.
    "tests/integration/email-permanent-bounce-recovery.db.test.ts",
    // The lock every customer-facing send takes: the suppression word read
    // inside it, the provider call made while it is held, and the row that
    // waits without counting an attempt when somebody else has the address.
    "tests/integration/email-send-address-lock.db.test.ts",
    "tests/integration/email-preferences-consent.db.test.ts",
    // A deletion request and a spam complaint: the suppression and the preference
    // withdrawal commit in one transaction, keyed so a retry records nothing new.
    "tests/integration/email-privacy-complaint-suppression.db.test.ts",
    // The double opt-in against the tables: request, history and queued mail
    // commit together, and only the click turns a marketing purpose on.
    "tests/integration/email-consent-confirmation.db.test.ts",
    "tests/integration/email-jurisdiction-policy.db.test.ts",
    // The recipient-authority rules: a version that is no longer a draft
    // cannot have its rules changed, and one (ruleKey, ruleVersion) names one
    // content -- both enforced by trigger, because a waiver is scoped to it.
    "tests/integration/release-notes-country-rule.db.test.ts",
    // The duty states: each one carries its own evidence and only its own, and a
    // waiver has to name a sealed approval of the waiver kind. All three are
    // constraints and a trigger, so only the database can answer for them.
    "tests/integration/release-notes-rule-obligation.db.test.ts",
    // The send verdict written down: the evidence it cited is rows the database
    // will not lose, the seal closes the set in the same transaction, and one
    // phase of one delivery is recorded once however many times it is evaluated.
    "tests/integration/release-notes-send-decision.db.test.ts",
    // The amendment notice's reach (S10): which owed accounts have no attempt at
    // all, counted as a set in one statement. The first version counted only
    // `sent` and compared sizes, and both mistakes are about rows.
    "tests/integration/email-policy-publication.db.test.ts",
    // The sign-up screen's consent choice (S4): only the database shows that an
    // existing account never consumes one, that consumption and its evidence
    // commit together, and that an estimate never replaces a declaration.
    "tests/integration/signup-consent.db.test.ts",
    // Sign-in and sign-up split (v25): a proven address with no account is
    // held for one sign-up, and only the database shows the hold is single use.
    "tests/integration/email-login-signup-hold.db.test.ts",
    // DOI section 14: a proven session consents at once; the database shows
    // the seal, the lock-time address check and the retired link.
    "tests/integration/email-verified-session-consent.db.test.ts",
    "tests/integration/au-relationship.db.test.ts",
    "tests/integration/in-product-consent-notice.db.test.ts",
    "tests/integration/processing-result-notice.db.test.ts",
    // The two statutory display checks, whose question is which (policy version,
    // profile) a message could still be composed under. Both earlier readings of
    // that were wrong in ways only rows show: the active version alone, and a
    // profile key assumed equal to a country code.
    "tests/integration/email-statutory-display-readiness.db.test.ts",
    // The snapshot purge: which rows lose their personalisation inputs, which
    // keep them, and what survives either way.
    "tests/integration/email-snapshot-retention.db.test.ts",
    // The two Founding Tester Pass sweeps, whose point is that the redemption's
    // bookkeeping column and the outbox row commit in one transaction -- which
    // is not observable from a single process.
    "tests/integration/founding-tester-pass-emails.db.test.ts",
    // Which profile a queued message is composed against, which only a database
    // can answer: the row pins a policy version and activating a later one must
    // not change what an already-queued message says.
    "tests/integration/email-jurisdiction-composition.db.test.ts",
    // One event fanning out to many deliveries, resumably. The acceptance
    // criterion is that expanding twice changes nothing, and the unique index
    // that guarantees it only exists in the database.
    "tests/integration/email-audience-expansion.db.test.ts",
    // What a campaign would actually reach. The classification is unit-tested
    // against invented counts; what needs a database is whether the queries
    // produce them -- a withdrawal after a grant has to beat the grant, and a
    // suppressed address has to match whatever case the provider reported it
    // in. Both are silent when wrong, and both overstate the audience.
    "tests/integration/email-marketing-reach.db.test.ts",
    // The campaign layer above it: approval pins the copy, and a copy change
    // after approval refuses the send (EM-06). Only a database holds the
    // TemplateVersion the pin points at.
    "tests/integration/email-campaign.db.test.ts",
    "tests/integration/campaign-audience.db.test.ts",
    "tests/integration/campaign-scheduling.db.test.ts",
    "tests/integration/campaign-attestations.db.test.ts",
    // The expansion ledger read back: who each wave reached and who it did not.
    // The counts come from grouped reads over rows no single process holds.
    "tests/integration/campaign-audience-readback.db.test.ts",
    // Measuring the audience rather than typing a number: the count is a scan
    // across accounts, settings and conversations, and the completeness CHECK
    // is the database's own statement that an estimate arrives whole.
    "tests/integration/campaign-audience-estimate.db.test.ts",
    // The people behind those counts, masked (D10). The masking has to happen
    // on the way out of the query rather than at the edge, and the only way to
    // show that is to write a row holding a real address and read it back
    // through the function a route calls.
    "tests/integration/campaign-ledger-people.db.test.ts",
    // Two callers ensuring the same template at the same moment. Both races it
    // covers are lost or won by the database's own unique indexes, so a single
    // process proves nothing about either.
    "tests/integration/email-template-registry-race.db.test.ts",
    // The send metadata on TemplateVersion: written once from the definition,
    // refused by a trigger when edited, and compared by the drain. The trigger
    // and the CHECKs exist only in the database.
    "tests/integration/email-template-version-metadata.db.test.ts",
    // Which unsubscribe requests the origin limit charges. The buckets are rows,
    // so whether sixty valid one-clicks from one NAT all get through is a
    // question only the table can answer.
    "tests/integration/email-unsubscribe-rate-limit.db.test.ts",
    // Which unsubscribe key versions recent mail still depends on: one canary
    // per version however many sends race to store it, and the newest sentAt
    // per version from rows only the table holds.
    "tests/integration/email-unsubscribe-key-retention.db.test.ts",
    // Suppression causes beside entries: this build's same-transaction cause,
    // the trigger carrying an unmarked build's writes, and append-only causes.
    // The trigger and the constraints exist only in the database.
    "tests/integration/email-suppression-causes.db.test.ts",
    // Lifting causes by the release matrix, the address lock a concurrent
    // writer contends for, and a retired setting row proving inert. The lock,
    // the leftover row and the audit row sharing a transaction with the
    // release are all database facts.
    "tests/integration/email-suppression-authority.db.test.ts",
    // The marketing branches of the standard lane, which no transactional
    // message can reach: the jurisdiction re-check, the one-click headers and
    // the marketing sending stream.
    "tests/integration/marketing-lane.db.test.ts",
    "tests/integration/admin-email-delivery.db.test.ts",
    // Opening one audit row by id. The property is the relationship between two
    // reads of the same table -- the newest-N window and the single-row read --
    // so a single process with no database proves neither.
    "tests/integration/admin-audit-row-by-id.db.test.ts",
    // The audit chain writer on real rows: the database clock, the previous
    // hash read and the verifier agree, inside and outside a caller's
    // transaction, and a rolled-back caller leaves no entry behind.
    "tests/integration/admin-audit-chain-writer.db.test.ts",
    // The marketing tables' triggers and CHECK constraints, exercised with
    // direct writes rather than through the store module: what they refuse is
    // exactly the write that did not go through it.
    "tests/integration/marketing-automation-schema.db.test.ts",
    // The staging webhook shadow: the partial unique index on an event's
    // digest refusing a second report inside the transaction that would have
    // audited it, and one winner among deliveries racing for an armed fault.
    "tests/integration/marketing-webhook-shadow.db.test.ts",
    // Proving a template: two human audit entries that still verify against
    // the chain, which is the only route to a post published without a person
    // looking at it. Needs real rows, because a fixture that inserted them
    // would prove the loader agrees with the fixture.
    "tests/integration/marketing-templates.db.test.ts",
    // Where a plan number came from, which decides whether a price claim may
    // rest on it. Needs rows, because the whole question is stored versus
    // compiled.
    "tests/integration/marketing-fact-sources.db.test.ts",
    // The daily model lifecycle report on the standard lane: that it enqueues
    // rather than sends, that the operator address is its own recipient
    // identity, and that a lane refusal costs the mail and not the scan.
    "tests/integration/model-lifecycle-daily-report.db.test.ts",
    // What an automatic disable leaves behind: the queue row, its notice
    // requirement, and the account count that decides it.
    "tests/integration/model-lifecycle-auto-disable.db.test.ts",
    // Excluding a discovered model and reviewing it again: the structured
    // decision record, a rescan that leaves the exclusion alone, and the
    // history constraints that refuse a decision without its record.
    "tests/integration/model-lifecycle-exclusion.db.test.ts",
    // The reconciliation script's preconditions, run through the real command:
    // the rules have unit coverage, but only this shows --apply actually
    // reaches them before it touches a row.
    "tests/integration/default-model-reconciliation.db.test.ts",
    // The import/memory program's suites were written alongside their slices
    // but never listed here, i.e. never actually run by CI — a guard nobody
    // runs is not a guard. Keep this list in step with tests/integration/.
    "tests/integration/external-import-schema.db.test.ts",
    "tests/integration/external-import-lifecycle.db.test.ts",
    "tests/integration/memory-schema.db.test.ts",
    "tests/integration/memory-extraction.db.test.ts",
    "tests/integration/memory-extraction-persistence.db.test.ts",
    "tests/integration/memory-extraction-worker.db.test.ts",
    "tests/integration/memory-extraction-credits.db.test.ts",
    "tests/integration/memory-extraction-provider-cost.db.test.ts",
    "tests/integration/memory-extraction-executor.db.test.ts",
    "tests/integration/memory-extraction-metrics.db.test.ts",
    "tests/integration/memory-extraction-revocation.db.test.ts",
    "tests/integration/retention-sweep.db.test.ts",
    "tests/integration/memory-review.db.test.ts",
    "tests/integration/memory-retrieval.db.test.ts",
    "tests/integration/memory-source-deletion.db.test.ts",
    "tests/integration/external-conversation-lock.db.test.ts",
    "tests/integration/memory-expiry.db.test.ts",
    "tests/integration/chat-context-bundle.db.test.ts",
    "tests/integration/routing-shadow.db.test.ts",
    "tests/integration/memory-metrics.db.test.ts",
    "tests/integration/conversation-memory-mode.db.test.ts",
    "tests/integration/conversation-selection-mode.db.test.ts",
    // AI Review's operational record: that a run round-trips content-free,
    // that a guest run lands at all (it produces no ComparisonReview row), and
    // that the 90-day purge reaches only what it should.
    "tests/integration/comparison-review-run-telemetry.db.test.ts",
    // The per-item feedback contract: the unique index really is the
    // idempotency key, a verdict is scoped to one person, and both cascades
    // are the deletion path the data-domain registry claims.
    "tests/integration/comparison-review-item-feedback.db.test.ts",
    // A pin is not activity: the sidebar groups its date headers by
    // `updatedAt`, so pinning may not touch it, and another account's pin
    // statement must match no row.
    "tests/integration/conversation-pin.db.test.ts",
    // v1.2 decision 2: what the database refuses about a conversation's
    // product, and that the three CHECKs are still NOT VALID.
    "tests/integration/conversation-product-key.db.test.ts",
    // v1.2 §6: the one writer writes the product, composes with the caller's
    // transaction, and refuses what the CHECKs refuse.
    "tests/integration/conversation-writer-product.db.test.ts",
    // v1.2 §5: the run keeps its product when the conversation it names is
    // deleted, and still goes when the account does.
    "tests/integration/routing-run-product-attribution.db.test.ts",
    // The provider set is written in TypeScript and in SQL, and only a
    // real database can say the two still agree.
    "tests/integration/external-import-provider-canon.db.test.ts",
    // Continuing an imported conversation: the two foreign keys behave
    // differently on delete, and that difference is the whole feature. Only a
    // database can show that removing the source leaves the conversation and
    // its messages standing while the bridge becomes a tombstone.
    "tests/integration/external-conversation-continuation.db.test.ts",
    // Message search over native turns and linked originals: that a locked
    // match cannot take an authorised hit's candidate slot is a property of
    // the SQL and the snapshot it runs in, not of the ranking function.
    "tests/integration/conversation-search.db.test.ts",
    // The TXT that carries the imported original: one snapshot of two halves,
    // and permission decided after the bytes exist.
    "tests/integration/continuation-source-export.db.test.ts",
    "tests/integration/context-manifest-retention.db.test.ts",
    // The only unauthenticated route that serves a customer's transcript.
    "tests/integration/public-share-route.db.test.ts",
    // N2: what the database refuses about mobile bearer authentication -- the
    // two-step cascade to a rotation row that has no user column of its own,
    // and the constraint stopping an audit row from naming somebody's device
    // without naming the account that cascade reaches.
    "tests/integration/mobile-auth-schema.db.test.ts",
    // The lifecycle on top of those tables: the conditional UPDATE that makes
    // strict single use true under a real race, and D8's contract that a
    // replay's revocation commits even though the caller is refused.
    "tests/integration/mobile-auth-service.db.test.ts",
    // Release C1: what the database refuses about a profile version snapshot.
    "tests/integration/assistant-profile-schema.db.test.ts",
    "tests/integration/assistant-profile-service.db.test.ts",
    // Release C2: the knowledge processing state machine, the DB-first
    // deletion order, and that the GIN term index is actually queryable.
    "tests/integration/assistant-knowledge-schema.db.test.ts",
    "tests/integration/assistant-knowledge-pipeline.db.test.ts",
    "tests/integration/assistant-package-import.db.test.ts",
    "tests/integration/assistant-package-import-flag.db.test.ts",
    "tests/integration/assistant-package-export.db.test.ts",
    // Release C3c: which row the runtime reads for a profile-backed turn --
    // Policy: docs/policy/external-conversation-import-and-memory.md.
    // owner boundary, superseded revisions, and the §10 identity the bundle
    // binds.
    "tests/integration/chat-profile-context.db.test.ts",
    // Release C4: §14's version pinning -- which rows the resolver reads, and
    // what a conversation reports once the owner has published past it.
    "tests/integration/conversation-profile-binding.db.test.ts",
    // PRIVACY-01/02. These settle what a source scan cannot: that no withheld
    // column reaches the export, that no identifier survives an account
    // deletion, and that a download ticket is spent exactly once under
    // concurrency.
    "tests/integration/account-data-export.db.test.ts",
    "tests/integration/account-data-export-ticket.db.test.ts",
    "tests/integration/account-anonymisation.db.test.ts",
    // §5's dispatch boundary: attempt-scoped manifests, and ROUTE-06.
    "tests/integration/routing-attempt-manifest.db.test.ts",
    "tests/integration/routing-dispatch-instrumentation.db.test.ts",
    // Whether an account an administrator put out of bounds is refused by
    // every paid AI path, not only by chat.
    "tests/integration/account-operational-restriction.db.test.ts",
  ],
  "Running financial, credit, chat-concurrency, chat-rate-limit, fallback-pricing, model-registry, admin-security, admin-users, login-methods, account-deletion, account export and anonymisation, conversation-title, conversation-lock-migration, provider-recovery, provider-failure-scope, provider-probe, subscription-sync-ordering, plan-change-reservation, image-generation, external-import, and memory transaction scenarios"
);
// This suite creates and drops only its own synthetic schema. Give its Prisma
// client that exact schema rather than letting it see the lane's public tables.
const oneShotAuditSuite =
  "tests/integration/prompt-refiner-vnext-v3-recovery.db.test.ts";
if ((!group || group === dbIntegrationGroupOf(oneShotAuditSuite)) &&
    !/(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(databaseName)) {
  fail("the isolated one-shot audit suite requires a dedicated test database name");
}
const oneShotTestUrl = new URL(rawTestDatabaseUrl);
oneShotTestUrl.searchParams.set("schema", `chat01_b06_test_${process.pid.toString(36)}`);
run(
  ["--conditions=react-server", "--import", "tsx", "--test", "--test-concurrency=1",
    oneShotAuditSuite],
  "Running the isolated one-shot v3 recovery/audit/80-slot transaction scenarios",
  { TEST_DATABASE_URL: oneShotTestUrl.toString(),
    DATABASE_URL: oneShotTestUrl.toString(),
    DIRECT_DATABASE_URL: oneShotTestUrl.toString() },
);
// The budget suite mocks Prisma and the audit writer while exercising real
// PostgreSQL constraints. Module mocks must be isolated from the batch above.
run(
  ["--conditions=react-server", "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning", "--import", "tsx", "--test",
    "--test-concurrency=1",
    "tests/integration/prompt-refiner-auto-budget-hold.db.test.ts",
    "tests/integration/prompt-refiner-chat-execution.db.test.ts",
    "tests/integration/prompt-refiner-chat-execution-full-schema.db.test.ts"],
  "Running the Prompt Refiner Auto budget hold transaction scenarios",
);
// Runs apart from the batch above: it drives the real route handlers, which
// needs mock.module (--experimental-test-module-mocks) to replace the session
// seam. Module mocks are process-global, so keeping this in its own process
// stops the next-auth stub from leaking into the suites above.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/perplexity-deep-research-route.db.test.ts",
  ],
  "Running the deep-research submit/poll credit and persistence scenarios"
);
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/provider-recovery-route.db.test.ts",
  ],
  "Running the administrator provider recovery route and its audit trail"
);
// Also its own process: it replaces the notification queue module to inject an
// outbox write failure, which every importer in the process would otherwise
// inherit.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/refund-decision-route.db.test.ts",
  ],
  "Running the administrator refund decision transaction and its outbox"
);
// Also its own process, and for the same reason: it replaces next-auth. What
// it pins is which requests reach the lift at all -- a stale cause set, a dead
// handle and an unknown handle are three different refusals, and every one of
// them used to answer "not found".
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/admin-suppression-lift-route.db.test.ts",
  ],
  "Running the administrator suppression lift route and its refusals"
);
// Also its own process: it replaces next-auth and the AI SDK's streamText to
// drive a real searching turn end to end. What it asserts is the wiring
// between the route and the cost ledger -- a claim no test calling
// settleChatUsage directly can make, and one that was false for as long as
// the handler had existed.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/chat-route-search-settlement.db.test.ts",
  ],
  "Running a native web search from the chat route through to the cost ledger"
);
// Its own process for the same reason: it replaces next-auth, the Stripe
// client and the webhook processor to drive the administrator replay route.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/webhook-reprocess-route.db.test.ts",
  ],
  "Running the administrator Stripe webhook replay and its mode boundary"
);
// Its own process for the same reason: it replaces the Stripe client and the
// webhook processor to drive the signed webhook endpoint.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/stripe-webhook-route.db.test.ts",
  ],
  "Running the Stripe webhook endpoint's at-least-once delivery rules"
);
// Its own process for the same reason: it replaces the Stripe client and the
// billing catalogue to capture what a confirmed upgrade sends.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/plan-change-upgrade-request.db.test.ts",
  ],
  "Running the plan-change upgrade's Stripe request parameters"
);
// Its own process for the same reason: it replaces the readiness inputs, the
// operational reporter and next/server's `after` to drive /api/ready.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/readiness-route.db.test.ts",
  ],
  "Running the readiness endpoint's dependency conjunction"
);
// The audio budget ledger: which bucket refused decides which boundary the
// caller is told to wait for, and only a database has two buckets to refuse in.
run(
  [
    "--conditions=react-server",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/voice-provider-budget-ledger.db.test.ts",
  ],
  "Running the voice provider budget ledger's refusal boundaries"
);
// Its own process for the same reason as the refund decision suite: it wraps
// the notification queue module to inject an enqueue failure, and it stubs the
// session and admin-auth seams for the feedback routes.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/feedback-lifecycle.db.test.ts",
  ],
  "Running the feedback lifecycle notification transaction scenarios"
);
// Its own process for the same reason: it replaces next-auth to drive the
// snapshot lock routes as a signed-in owner.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/external-conversation-lock-route.db.test.ts",
  ],
  "Running the imported snapshot lock, unlock and attempt-limit scenarios"
);
// Its own process for the same reason: it replaces next-auth to read a
// conversation back as its signed-in owner.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/memory-usage-disclosure-route.db.test.ts",
  ],
  "Running the §13.4 memory disclosure read scenarios"
);
// Its own process again: it replaces next-auth so the create route can be
// driven as a signed-in account. The provider set is written on both sides of
// this route, and only the route can say the two halves still agree.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/external-import-create-route.db.test.ts",
  ],
  "Running the external import create-route provider scenarios"
);
// Its own process again: it replaces both next-auth and the Auto readiness
// register, and a module mock is process-global. The register mock is why it
// cannot share a process with anything that reads the committed one.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/conversation-auto-selection-route.db.test.ts",
  ],
  "Running the Auto selection-mode route scenarios"
);
// Real row/transaction semantics with storage fully stubbed. Keep the R2 mock
// in its own process rather than changing another integration suite's client.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/message-attachment-resend.db.test.ts",
  ],
  "Running restored question attachment persistence scenarios"
);

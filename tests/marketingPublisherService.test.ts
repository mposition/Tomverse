// The marketing publisher's timing contract, its Railway service, and the
// supervisor that enforces the deadline (S2 plan, S2d1).
//
// TypeScript and the `@/` alias, for the reason the other marketing store tests
// give: modules reached by two specifier forms load twice.

import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MARKETING_PUBLISHER_CRON_PERIOD_MS,
  MARKETING_PUBLISHER_DERIVED_TRANSACTION_MAX_MS,
  MARKETING_PUBLISHER_JOB_KEY,
  MARKETING_PUBLISHER_RUN_DEADLINE_MS,
  MARKETING_PUBLISHER_TIMING,
  marketingPublisherDeadlineProblem,
  marketingPublisherHasRoomForBatch,
  marketingPublisherRequestSchema,
  marketingPublisherSilentRuns,
  marketingPublisherTimingProblems,
  type MarketingPublisherTiming,
} from "@/lib/marketingPublisherRunCore";
import {
  CRON_TRIGGERS,
  PENDING_SCHEDULED_JOB_KEYS,
  SCHEDULED_JOB_DEFINITIONS,
  cronTriggerIntervalMs,
  parseCronSchedule,
} from "@/lib/scheduledJobsCore";
import { AGENT_RUNNER_SERVICES } from "../.railway/agent-runners";
import { RAILWAY_CRON_SERVICES } from "../.railway/scheduled-jobs";
import {
  RUN_DEADLINE_MS,
  superviseMarketingPublisherRun,
} from "../scripts/run-marketing-publisher.mjs";

// ---------------------------------------------------------------------------
// The timing contract
// ---------------------------------------------------------------------------

test("the shipped limits are each strictly inside the one before", () => {
  assert.deepEqual(marketingPublisherTimingProblems(MARKETING_PUBLISHER_TIMING), []);
  // The figure the plan derives, by the plan's own arithmetic: eighteen
  // statements at five seconds and the seventeen gaps between them at five. It
  // was 115s at a budget of twelve; measuring the publisher's real operations
  // with an integrity key configured moved it; see MARKETING_PUBLISHER_MAX_STATEMENTS.
  assert.equal(MARKETING_PUBLISHER_DERIVED_TRANSACTION_MAX_MS, 18 * 5_000 + 17 * 5_000);
  assert.equal(MARKETING_PUBLISHER_DERIVED_TRANSACTION_MAX_MS, 175_000);
});

test("each broken ordering is named, not reported as 'wrong timing'", () => {
  const with_ = (change: Partial<MarketingPublisherTiming>) =>
    marketingPublisherTimingProblems({ ...MARKETING_PUBLISHER_TIMING, ...change });

  assert.ok(
    with_({ runDeadlineMs: MARKETING_PUBLISHER_CRON_PERIOD_MS }).some((problem) =>
      problem.includes("run deadline is not shorter than the cron period"),
    ),
  );
  assert.ok(
    with_({ derivedTransactionMaxMs: MARKETING_PUBLISHER_RUN_DEADLINE_MS }).some(
      (problem) => problem.includes("derived per-transaction maximum"),
    ),
  );
  // The ordering trap: at or above the transaction timeout, PostgreSQL stops
  // arming the ceiling, silently. These two are the reason this function exists.
  assert.ok(
    with_({ statementTimeoutMs: MARKETING_PUBLISHER_TIMING.transactionTimeoutMs }).some(
      (problem) => problem.includes("statement_timeout is not shorter than transaction_timeout"),
    ),
  );
  assert.ok(
    with_({ idleTimeoutMs: MARKETING_PUBLISHER_TIMING.transactionTimeoutMs }).some(
      (problem) =>
        problem.includes("idle_in_transaction_session_timeout is not shorter than transaction_timeout"),
    ),
  );
  assert.ok(
    with_({ silenceThresholdMs: MARKETING_PUBLISHER_RUN_DEADLINE_MS }).some((problem) =>
      problem.includes("silence threshold"),
    ),
  );
  assert.ok(with_({ statementTimeoutMs: 0 }).some((problem) => problem.includes("not positive")));
});

test("another batch starts only if a whole transaction still fits", () => {
  const now = new Date("2026-09-23T10:00:00.000Z");
  const just = new Date(now.getTime() + MARKETING_PUBLISHER_DERIVED_TRANSACTION_MAX_MS);
  const past = new Date(just.getTime() + 1);
  // Not "is the deadline ahead": with exactly the derived maximum left, a
  // transaction could be killed on its last statement and its COMMIT land late.
  assert.equal(marketingPublisherHasRoomForBatch(now, just), false);
  assert.equal(marketingPublisherHasRoomForBatch(now, past), true);
});

test("a start request's deadline must be ahead, readable, and within one period", () => {
  const now = new Date("2026-09-23T10:00:00.000Z");
  const ahead = (ms: number) => new Date(now.getTime() + ms);
  assert.equal(marketingPublisherDeadlineProblem(now, ahead(RUN_DEADLINE_MS)), null);
  assert.equal(marketingPublisherDeadlineProblem(now, now), "deadline_passed");
  assert.equal(marketingPublisherDeadlineProblem(now, ahead(-1)), "deadline_passed");
  // A deadline a year out would make every run punctual by the database's rule.
  assert.equal(
    marketingPublisherDeadlineProblem(now, ahead(MARKETING_PUBLISHER_CRON_PERIOD_MS + 1)),
    "deadline_too_far",
  );
  assert.equal(
    marketingPublisherDeadlineProblem(now, new Date("not a time")),
    "deadline_unreadable",
  );
});

test("a silent run is measured from its last heartbeat, or its start if it never beat", () => {
  const now = new Date("2026-09-23T10:00:00.000Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const silent = marketingPublisherSilentRuns(
    [
      { id: "fresh-beat", startedAt: ago(60), heartbeatAt: ago(1) },
      { id: "old-beat", startedAt: ago(60), heartbeatAt: ago(20) },
      { id: "never-beat", startedAt: ago(20), heartbeatAt: null },
      { id: "just-started", startedAt: ago(1), heartbeatAt: null },
    ],
    now,
  );
  assert.deepEqual(
    silent.map((run) => run.id),
    ["old-beat", "never-beat"],
  );
});

test("the request is exactly { runId, deadline }", () => {
  const good = {
    runId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    deadline: "2026-09-23T10:04:00.000Z",
  };
  assert.equal(marketingPublisherRequestSchema.safeParse(good).success, true);
  for (const bad of [
    { ...good, extra: true },
    { ...good, runId: "not-a-uuid" },
    { ...good, deadline: "2026-09-23T10:04:00+10:00" },
    { runId: good.runId },
    {},
  ]) {
    assert.equal(
      marketingPublisherRequestSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
  }
});

// ---------------------------------------------------------------------------
// The Railway service
// ---------------------------------------------------------------------------

test("the service is declared once, every five minutes, with exactly two variables", () => {
  // In the Agents project, which has no database service for a reference
  // variable to resolve to, and no longer in the shared project's cron table.
  assert.equal(
    RAILWAY_CRON_SERVICES.some((job) => job.service === "Marketing Publisher"),
    false,
    "the publisher is still in .railway/scheduled-jobs.ts",
  );
  const matches = AGENT_RUNNER_SERVICES.filter((runner) => runner.key === "marketing_publisher");
  assert.equal(matches.length, 1, "the publisher is not declared once in .railway/agent-runners.ts");
  const service = matches[0];
  assert.ok(service.cronSchedule);
  assert.equal(service.service, "Marketing Publisher");
  assert.equal(service.startCommand, "npm run maintenance:marketing-publisher");
  // The plan's exhaustive list. No database, platform, object-store, GitHub or
  // LLM credential; a third name here is a credential the service must not
  // hold.
  for (const environment of ["production", "staging"] as const) {
    assert.deepEqual(
      [...(service.environments[environment] ?? [])].sort(),
      ["MARKETING_PUBLISH_SECRET", "MARKETING_PUBLISH_URL"],
      environment,
    );
  }
  // dev runs every develop merge before anyone has verified it, so it never
  // holds the job that publishes to outside accounts.
  assert.equal(service.environments.dev, undefined);

  const trigger = parseCronSchedule(service.cronSchedule);
  assert.ok(trigger);
  // `run deadline < cron period`, against the schedule as deployed rather
  // than the constant that describes it.
  assert.equal(cronTriggerIntervalMs(trigger), MARKETING_PUBLISHER_CRON_PERIOD_MS);
  assert.deepEqual({ ...CRON_TRIGGERS.marketingPublisher.trigger }, trigger);
});

test("the job is recorded but not judged until an operator switches the service on", () => {
  // The service exists only after its variables are set and the catalogue is
  // applied, which is an operator's step. Judged before then, a job nobody has
  // switched on would light the delayed-jobs badge the day this merges.
  assert.ok(
    (PENDING_SCHEDULED_JOB_KEYS as readonly string[]).includes(MARKETING_PUBLISHER_JOB_KEY),
  );
  assert.ok(
    !SCHEDULED_JOB_DEFINITIONS.some((job) => (job.key as string) === MARKETING_PUBLISHER_JOB_KEY),
  );
});

test("the supervisor's deadline is the contract's deadline", () => {
  // The supervisor is a plain-node script and cannot import the TypeScript
  // core, so it states the number itself. This is what stops the two drifting.
  assert.equal(RUN_DEADLINE_MS, MARKETING_PUBLISHER_RUN_DEADLINE_MS);
});

test("the service reads no variable beyond its two and the two it hands its worker", () => {
  const read = new Set<string>();
  for (const file of [
    "../scripts/run-marketing-publisher.mjs",
    "../scripts/marketing-publisher-worker.mjs",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      read.add(match[1] as string);
    }
  }
  assert.deepEqual([...read].sort(), [
    "MARKETING_PUBLISHER_DEADLINE",
    "MARKETING_PUBLISHER_RUN_ID",
    "MARKETING_PUBLISH_SECRET",
    "MARKETING_PUBLISH_URL",
  ]);
});

// ---------------------------------------------------------------------------
// The kill
// ---------------------------------------------------------------------------

test("a worker that never finishes is killed at the deadline", async () => {
  // The one thing this service exists for, shown rather than described: a
  // worker blocked forever, a deadline measured in milliseconds, and a SIGKILL.
  // A timer inside the worker would be advice; this is the parent ending it.
  const directory = mkdtempSync(join(tmpdir(), "publisher-supervisor-"));
  const hanging = join(directory, "hang.mjs");
  writeFileSync(hanging, "setInterval(() => {}, 1_000);\n");

  const started = Date.now();
  const outcome = (await superviseMarketingPublisherRun({
    worker: hanging,
    deadlineMs: 300,
    stdio: "ignore",
  })) as { signal: string | null; killedAtDeadline: boolean; runId: string };
  const took = Date.now() - started;

  assert.equal(outcome.killedAtDeadline, true);
  assert.ok(outcome.signal !== null, "the worker exited on its own rather than being killed");
  assert.ok(took < 5_000, `the kill took ${took}ms`);
  assert.match(outcome.runId, /^[0-9a-f-]{36}$/);
});

test("a worker that finishes in time is not killed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "publisher-supervisor-"));
  const quick = join(directory, "quick.mjs");
  writeFileSync(quick, "process.exitCode = 0;\n");

  const outcome = (await superviseMarketingPublisherRun({
    worker: quick,
    deadlineMs: 10_000,
    stdio: "ignore",
  })) as { code: number | null; signal: string | null; killedAtDeadline: boolean };
  assert.equal(outcome.killedAtDeadline, false);
  assert.equal(outcome.signal, null);
  assert.equal(outcome.code, 0);
});

test("the worker refuses to run without its secret", async () => {
  const outcome = (await superviseMarketingPublisherRun({
    deadlineMs: 10_000,
    // Only PATH: no secret and no URL, as on a service whose variables were
    // never set. Cast because Node types a full environment as required keys.
    env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
    stdio: "ignore",
  })) as { code: number | null; killedAtDeadline: boolean };
  assert.equal(outcome.killedAtDeadline, false);
  assert.equal(outcome.code, 1);
});

test("the worker is handed its two variables, not the platform's whole environment", async () => {
  // Railway injects its own variables into every service. A worker that
  // inherited them all would hold whatever the platform chose to add; the
  // plan's list is two names.
  const directory = mkdtempSync(join(tmpdir(), "publisher-supervisor-"));
  const out = join(directory, "env.json");
  const probe = join(directory, "probe.mjs");
  writeFileSync(
    probe,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(process.env)));\n`,
  );

  await superviseMarketingPublisherRun({
    worker: probe,
    deadlineMs: 10_000,
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "",
      MARKETING_PUBLISH_SECRET: "x".repeat(40),
      MARKETING_PUBLISH_URL: "https://example.test",
      RAILWAY_SOMETHING_INJECTED: "platform value",
      DATABASE_URL: "postgres://must-never-reach-the-worker",
    } as unknown as NodeJS.ProcessEnv,
    stdio: "ignore",
  });

  const seen = new Set(JSON.parse(readFileSync(out, "utf8")) as string[]);
  assert.ok(seen.has("MARKETING_PUBLISH_SECRET"));
  assert.ok(seen.has("MARKETING_PUBLISH_URL"));
  assert.ok(seen.has("MARKETING_PUBLISHER_RUN_ID"));
  assert.ok(seen.has("MARKETING_PUBLISHER_DEADLINE"));
  assert.ok(!seen.has("RAILWAY_SOMETHING_INJECTED"), "a platform variable reached the worker");
  assert.ok(!seen.has("DATABASE_URL"), "a database credential reached the worker");
});

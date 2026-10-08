import assert from "node:assert/strict";
import test from "node:test";

import {
  DAILY_RUN_CAP,
  LANE_TIMEOUTS,
  PROMOTION_MOVES_PER_PASS_MAX,
  RETENTION_BATCHES_PER_RUN_MAX,
  allocatePromotionBudget,
  decideInheritedTransactionTimeout,
  guardedBudgetMs,
  laneTimeoutOrderHolds,
  maxGuardedBudgetMs,
  mayStartRetentionBatch,
  reducedRetentionBatchSize,
  retentionHeartbeat,
} from "../lib/supportTriageCore.ts";

test("largest guarded budgets match the policy: 138 s, 10.3 s, 110 s", () => {
  assert.equal(maxGuardedBudgetMs("worker"), 138_000);
  assert.equal(maxGuardedBudgetMs("retention"), 10_300);
  assert.equal(maxGuardedBudgetMs("admin"), 110_000);
});

test("guarded budget is A x statement + (A - 1) x idle and refuses out-of-range counts", () => {
  assert.equal(guardedBudgetMs("worker", 1), 5_000);
  assert.equal(guardedBudgetMs("retention", 2), 950);
  assert.throws(() => guardedBudgetMs("worker", 0), RangeError);
  assert.throws(() => guardedBudgetMs("worker", 21), RangeError);
  assert.throws(() => guardedBudgetMs("admin", 1.5), RangeError);
});

test("every lane keeps Prisma > transaction > C_guarded > statement > idle strictly", () => {
  for (const lane of ["worker", "retention", "admin"]) {
    assert.equal(laneTimeoutOrderHolds(lane), true, lane);
  }
});

test("the whole timeout table matches policy section 4, value by value", () => {
  assert.deepEqual(LANE_TIMEOUTS, {
    worker: {
      deadlineMs: 300_000,
      statementTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: 2_000,
      transactionTimeoutMs: 150_000,
      prismaTransactionTimeoutMs: 180_000,
      maxRoundTrips: 20,
    },
    retention: {
      deadlineMs: 100_000,
      statementTimeoutMs: 400,
      idleInTransactionTimeoutMs: 150,
      transactionTimeoutMs: 20_000,
      prismaTransactionTimeoutMs: 30_000,
      maxRoundTrips: 19,
    },
    admin: {
      deadlineMs: null,
      statementTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: 2_000,
      transactionTimeoutMs: 120_000,
      prismaTransactionTimeoutMs: 150_000,
      maxRoundTrips: 16,
    },
  });
});

test("inherited transaction_timeout: 0 or absent arms ours, short refuses, long proceeds", () => {
  assert.deepEqual(decideInheritedTransactionTimeout("worker", null), {
    action: "proceed",
    armedBy: "policy",
  });
  assert.deepEqual(decideInheritedTransactionTimeout("worker", 0), {
    action: "proceed",
    armedBy: "policy",
  });
  assert.equal(decideInheritedTransactionTimeout("worker", 138_000).action, "refuse");
  assert.deepEqual(decideInheritedTransactionTimeout("worker", 138_001), {
    action: "proceed",
    armedBy: "inherited",
  });
  assert.equal(decideInheritedTransactionTimeout("retention", 10_300).action, "refuse");
  assert.equal(decideInheritedTransactionTimeout("retention", 60_000).action, "proceed");
  assert.throws(() => decideInheritedTransactionTimeout("admin", -1), RangeError);
});

test("retention gate needs both budget above 10.3 s and fewer than 8 started batches", () => {
  assert.equal(mayStartRetentionBatch({ remainingMs: 10_301, batchesStarted: 0 }), true);
  assert.equal(mayStartRetentionBatch({ remainingMs: 10_300, batchesStarted: 0 }), false);
  assert.equal(mayStartRetentionBatch({ remainingMs: 99_000, batchesStarted: 7 }), true);
  assert.equal(mayStartRetentionBatch({ remainingMs: 99_000, batchesStarted: 8 }), false);
});

test("retention gate refuses a missing, negative or fractional counter instead of starting", () => {
  assert.throws(() => mayStartRetentionBatch({ remainingMs: 99_000, batchesStarted: null }), RangeError);
  assert.throws(() => mayStartRetentionBatch({ remainingMs: 99_000, batchesStarted: -1 }), RangeError);
  assert.throws(() => mayStartRetentionBatch({ remainingMs: 99_000, batchesStarted: 1.5 }), RangeError);
  assert.throws(() => mayStartRetentionBatch({ remainingMs: Number.NaN, batchesStarted: 0 }), RangeError);
});

test("worst case still starts eight batches inside the 100 s budget, never nine", () => {
  // T_run_start (5.35 s) and T_digest_item (5.9 s) spend their whole budgets first.
  let remaining = 100_000 - 5_350 - 5_900;
  let started = 0;
  while (mayStartRetentionBatch({ remainingMs: remaining, batchesStarted: started })) {
    started += 1;
    remaining -= maxGuardedBudgetMs("retention");
  }
  assert.equal(started, RETENTION_BATCHES_PER_RUN_MAX);
});

test("batch size halves to the floor and stops there", () => {
  assert.equal(reducedRetentionBatchSize(500), 250);
  assert.equal(reducedRetentionBatchSize(250), 125);
  assert.equal(reducedRetentionBatchSize(125), null);
  assert.throws(() => reducedRetentionBatchSize(100), RangeError);
});

test("daily capacity covers the floor-size demand of 250 batches", () => {
  const runsPerDay = 48;
  assert.ok(runsPerDay * RETENTION_BATCHES_PER_RUN_MAX >= 250);
  assert.equal(DAILY_RUN_CAP.retention, 52);
  assert.equal(DAILY_RUN_CAP.worker, 52);
});

test("retention heartbeat: each of the three conditions opens it on its own", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  const recent = new Date("2026-10-03T11:40:00Z");
  const finished = {
    finishedAt: recent,
    batchesCompleted: 3,
    overdueRemaining: 0,
    oldestOverdueAgeSeconds: 0,
  };
  const cases = [
    [null, null, { liveness: true, progressSingle: false, progressDeadline: false }],
    [recent, finished, { liveness: false, progressSingle: false, progressDeadline: false }],
    [new Date("2026-10-03T10:39:59Z"), finished, { liveness: true, progressSingle: false, progressDeadline: false }],
    [new Date("2026-10-03T10:40:00Z"), finished, { liveness: false, progressSingle: false, progressDeadline: false }],
    [recent, { ...finished, batchesCompleted: 0, overdueRemaining: 4 }, { liveness: false, progressSingle: true, progressDeadline: false }],
    [recent, { ...finished, batchesCompleted: 0, overdueRemaining: 0 }, { liveness: false, progressSingle: false, progressDeadline: false }],
    [recent, { ...finished, oldestOverdueAgeSeconds: 86_401 }, { liveness: false, progressSingle: false, progressDeadline: true }],
    [recent, { ...finished, oldestOverdueAgeSeconds: 86_400 }, { liveness: false, progressSingle: false, progressDeadline: false }],
  ];
  for (const [latestSuccessAt, latestFinished, expected] of cases) {
    assert.deepEqual(
      retentionHeartbeat({ now, latestSuccessAt, latestFinished }),
      { ...expected, stale: expected.liveness || expected.progressSingle || expected.progressDeadline },
      JSON.stringify({ latestSuccessAt, latestFinished })
    );
  }
});

test("progress conditions read the latest finished run even when it was not a success", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  // The last success is recent, but the newer finished run completed nothing.
  const result = retentionHeartbeat({
    now,
    latestSuccessAt: new Date("2026-10-03T11:20:00Z"),
    latestFinished: {
      finishedAt: new Date("2026-10-03T11:50:00Z"),
      batchesCompleted: 0,
      overdueRemaining: 12,
      oldestOverdueAgeSeconds: 600,
    },
  });
  assert.equal(result.progressSingle, true);
  assert.equal(result.stale, true);
});

test("a flat positive backlog no longer passes: age, not trend, opens it", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  const flat = {
    finishedAt: new Date("2026-10-03T11:50:00Z"),
    batchesCompleted: 8,
    overdueRemaining: 1_000,
    oldestOverdueAgeSeconds: 90_000,
  };
  assert.equal(retentionHeartbeat({ now, latestSuccessAt: flat.finishedAt, latestFinished: flat }).stale, true);
});

test("a corrupt timestamp or counter throws instead of reading as healthy", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  const ok = new Date("2026-10-03T11:50:00Z");
  const finished = { finishedAt: ok, batchesCompleted: 1, overdueRemaining: 0, oldestOverdueAgeSeconds: 0 };
  assert.throws(() => retentionHeartbeat({ now: new Date("x"), latestSuccessAt: ok, latestFinished: finished }), RangeError);
  assert.throws(() => retentionHeartbeat({ now, latestSuccessAt: new Date("x"), latestFinished: finished }), RangeError);
  assert.throws(() => retentionHeartbeat({ now, latestSuccessAt: ok, latestFinished: { ...finished, finishedAt: new Date("x") } }), RangeError);
  assert.throws(() => retentionHeartbeat({ now, latestSuccessAt: ok, latestFinished: { ...finished, overdueRemaining: -1 } }), RangeError);
});

test("promotion budget is a cumulative prefix: two 30-move candidates in a 50 budget admit one", () => {
  const result = allocatePromotionBudget(
    [
      { kind: "same_account", groupCandidateKey: "b", moves: 30 },
      { kind: "same_account", groupCandidateKey: "a", moves: 30 },
    ],
    PROMOTION_MOVES_PER_PASS_MAX
  );
  assert.deepEqual(result.admitted.map((c) => c.groupCandidateKey), ["a"]);
  assert.deepEqual(result.deferred.map((c) => c.groupCandidateKey), ["b"]);
  assert.equal(result.movesUsed, 30);
  assert.equal(result.remainingAfter, 20);
});

test("higher kind priority is admitted first, and the first candidate of a pass always fits", () => {
  const result = allocatePromotionBudget(
    [
      { kind: "autofix_fingerprint", groupCandidateKey: "a", moves: 1 },
      { kind: "server_evidence_match", groupCandidateKey: "z", moves: 49 },
    ],
    50
  );
  assert.deepEqual(result.admitted.map((c) => c.kind), ["server_evidence_match", "autofix_fingerprint"]);
  assert.equal(result.remainingAfter, 0);
});

test("once one candidate is deferred every later one is deferred, even if it would fit", () => {
  const result = allocatePromotionBudget(
    [
      { kind: "server_evidence_match", groupCandidateKey: "a", moves: 15 },
      { kind: "same_account", groupCandidateKey: "b", moves: 10 },
      { kind: "autofix_fingerprint", groupCandidateKey: "c", moves: 1 },
    ],
    20
  );
  assert.deepEqual(result.admitted.map((c) => c.groupCandidateKey), ["a"]);
  assert.deepEqual(result.deferred.map((c) => c.groupCandidateKey), ["b", "c"]);
});

test("a full 50-member move exactly uses a fresh pass budget", () => {
  const result = allocatePromotionBudget([{ kind: "same_account", groupCandidateKey: "a", moves: 50 }], 50);
  assert.equal(result.admitted.length, 1);
  assert.equal(result.remainingAfter, 0);
});

test("promotion budget refuses malformed input instead of guessing", () => {
  assert.throws(() => allocatePromotionBudget([], -1), RangeError);
  assert.throws(
    () => allocatePromotionBudget([{ kind: "same_account", groupCandidateKey: "a", moves: 51 }], 50),
    RangeError
  );
  assert.throws(
    () => allocatePromotionBudget([{ kind: "trace_id", groupCandidateKey: "a", moves: 1 }], 50),
    RangeError
  );
  assert.throws(
    () => allocatePromotionBudget([{ kind: "same_account", groupCandidateKey: "a", moves: 0 }], 50),
    RangeError
  );
});

test("the run-table migration's literals are the core constants", async () => {
  const { readFileSync } = await import("node:fs");
  const core = await import("../lib/supportTriageCore.ts");
  const sql = readFileSync(
    new URL("../prisma/migrations/20261003120000_support_triage_run/migration.sql", import.meta.url),
    "utf8"
  );
  assert.ok(sql.includes(`WHEN 'worker' THEN interval '${core.LANE_TIMEOUTS.worker.deadlineMs / 60_000} minutes'`));
  assert.ok(sql.includes(`WHEN 'retention' THEN interval '${core.LANE_TIMEOUTS.retention.deadlineMs / 1_000} seconds'`));
  assert.ok(sql.includes(`daily_cap CONSTANT INTEGER := ${core.DAILY_RUN_CAP.worker};`));
  assert.equal(core.DAILY_RUN_CAP.worker, core.DAILY_RUN_CAP.retention);
  assert.ok(sql.includes(`interval '${core.SUPPORT_TRIAGE_RUN_RETENTION_DAYS} days'`));
  assert.ok(sql.includes(`"batchesCompleted" <= ${core.RETENTION_BATCHES_PER_RUN_MAX})`));
  assert.ok(sql.includes(`CHECK ("kind" IN (${core.SUPPORT_TRIAGE_RUN_KINDS.map((k) => `'${k}'`).join(", ")}))`));
});

test("the suggestion migration's transitions and lists are the core's", async () => {
  const { readFileSync } = await import("node:fs");
  const core = await import("../lib/supportTriageCore.ts");
  const sql = readFileSync(
    new URL("../prisma/migrations/20261004010000_support_triage_suggestion/migration.sql", import.meta.url),
    "utf8"
  );
  const block = /-- transitions: SupportTriageSuggestion state\n([\s\S]*?)-- end transitions/.exec(sql);
  assert.ok(block, "the transitions block exists");
  const pairs = [...block[1].matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}->${m[2]}`).sort();
  assert.deepEqual(pairs, core.SUGGESTION_TRANSITIONS.map(([a, b]) => `${a}->${b}`).sort());
  const list = (values) => values.map((v) => `'${v}'`).join(", ");
  assert.ok(sql.includes(`CHECK ("state" IN (${list(core.SUGGESTION_STATES)}))`));
  assert.ok(sql.includes(`"failureCode" IN (${list(core.SUGGESTION_FAILURE_CODES)})`));
  assert.ok(sql.includes(`"lane" IN (${list(core.TRIAGE_LANES)})`));
  assert.ok(sql.includes(`CHECK ("ownerQueueState" IN (${list(core.OWNER_QUEUE_STATES)}))`));
  assert.ok(sql.includes(`ARRAY[${list(core.KEYWORD_FLAGS)}]::TEXT[]`));
  assert.ok(sql.includes(`CHECK ("attemptCount" BETWEEN 0 AND ${core.SUGGESTION_MAX_ATTEMPTS})`));
  assert.ok(sql.includes(`lease CONSTANT INTERVAL := interval '${core.SUGGESTION_LEASE_SECONDS / 60} minutes'`));
  assert.ok(sql.includes(`OLD."state" IN (${list(core.SUGGESTION_TERMINAL_STATES)})`));
});

test("no transition leaves a terminal suggestion state", async () => {
  const core = await import("../lib/supportTriageCore.ts");
  for (const [from] of core.SUGGESTION_TRANSITIONS) {
    assert.ok(!core.SUGGESTION_TERMINAL_STATES.includes(from), from);
  }
  assert.equal(core.isSuggestionTransitionAllowed("pending", "claimed"), true);
  assert.equal(core.isSuggestionTransitionAllowed("failed", "pending"), false);
  assert.ok(!core.TRIAGE_LANES.includes("account_privacy_human"));
});

test("the group migration's transitions, lists and limits are the core's", async () => {
  const { readFileSync } = await import("node:fs");
  const core = await import("../lib/supportTriageCore.ts");
  const sql = readFileSync(
    new URL("../prisma/migrations/20261004020000_support_triage_group/migration.sql", import.meta.url),
    "utf8"
  );
  const block = /-- transitions: SupportTriageGroup state\n([\s\S]*?)-- end transitions/.exec(sql);
  assert.ok(block, "the transitions block exists");
  const pairs = [...block[1].matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}->${m[2]}`).sort();
  assert.deepEqual(pairs, core.GROUP_TRANSITIONS.map(([a, b]) => `${a}->${b}`).sort());
  const list = (values) => values.map((v) => `'${v}'`).join(", ");
  assert.ok(sql.includes(`CHECK ("state" IN (${list(core.GROUP_STATES)}))`));
  assert.ok(sql.includes(`CHECK ("primaryKind" IN (${list(core.GROUP_KIND_PRIORITY)}))`));
  assert.ok(sql.includes(`CHECK ("kind" IN (${list(core.GROUP_KIND_PRIORITY)}))`));
  assert.ok(sql.includes(`"decision" IN (${list(core.GROUP_DECISIONS)})`));
  assert.ok(sql.includes(`CHECK ("provenanceClass" IN (${list(core.SIGNAL_PROVENANCE_CLASSES)}))`));
  for (const [kind, provenance] of Object.entries(core.SIGNAL_PROVENANCE)) {
    assert.ok(sql.includes(`WHEN '${kind}' THEN '${provenance}'`), kind);
  }
  assert.ok(sql.includes(`("state" IN (${list(core.GROUP_OPEN_STATES)})) = ("primarySnapshotDigest" IS NOT NULL)`));
  assert.ok(sql.includes(`OLD."state" IN (${list(core.GROUP_TERMINAL_STATES)})`));
  assert.ok(sql.includes(`cardinality("retiredMemberIds") <= ${core.GROUP_RETIRED_MEMBER_IDS_MAX}`));
  assert.ok(sql.includes(`member_cap CONSTANT INTEGER := ${core.GROUP_MEMBER_CAP};`));
  assert.ok(sql.includes(`BETWEEN 0 AND ${core.GROUP_KEY_RECHECK_DEFERRAL_LIMIT})`));
  assert.ok(sql.includes(`cooldown CONSTANT INTERVAL := interval '${core.GROUP_KEY_TOMBSTONE_DAYS} days'`));
});

test("no transition leaves a terminal group state, and every kind has one provenance", async () => {
  const core = await import("../lib/supportTriageCore.ts");
  for (const [from] of core.GROUP_TRANSITIONS) assert.ok(!core.GROUP_TERMINAL_STATES.includes(from), from);
  assert.deepEqual(
    [...core.GROUP_OPEN_STATES, ...core.GROUP_TERMINAL_STATES].sort(),
    [...core.GROUP_STATES].sort()
  );
  assert.deepEqual(Object.keys(core.SIGNAL_PROVENANCE).sort(), [...core.GROUP_KIND_PRIORITY].sort());
  assert.deepEqual(
    [...new Set(Object.values(core.SIGNAL_PROVENANCE))].sort(),
    [...core.SIGNAL_PROVENANCE_CLASSES].sort()
  );
  assert.equal(core.isGroupTransitionAllowed("candidate", "confirmed"), true);
  assert.equal(core.isGroupTransitionAllowed("dismissed", "candidate"), false);
});

test("a retention batch over every class stays inside the lane's round-trip budget", async () => {
  const core = await import("../lib/supportTriageCore.ts");
  // BEGIN, arm, two per class (window read, delete), the closed-report
  // invalidation, the system audit entry (chain lock, clock, chain head,
  // insert), the deadline check, COMMIT. Measured at 17 on PostgreSQL 17.
  const AUDIT_ROUND_TRIPS = 4;
  const roundTrips = 1 + 1 + 2 * core.RETENTION_CLASSES.length + 1 + AUDIT_ROUND_TRIPS + 1 + 1;
  assert.equal(roundTrips, 17);
  assert.ok(roundTrips <= core.RETENTION_BATCH_ROUND_TRIPS, String(roundTrips));
  assert.equal(core.LANE_TIMEOUTS.retention.maxRoundTrips, core.RETENTION_BATCH_ROUND_TRIPS);
});

test("the heartbeat bit: retention always, the worker only while triage is enabled, no success is stale", async () => {
  const core = await import("../lib/supportTriageCore.ts");
  const now = new Date("2026-10-07T12:00:00.000Z");
  const minutesAgo = (m) => new Date(now.getTime() - m * 60_000);
  const healthy = {
    latestSuccessAt: minutesAgo(10),
    latestFinished: { finishedAt: minutesAgo(10), batchesCompleted: 1, overdueRemaining: 0, oldestOverdueAgeSeconds: 0 },
  };
  const stale = (enabled, retention, worker) =>
    core.supportTriageHeartbeatStale({ now, enabled, retention, workerLatestSuccessAt: worker });
  // flag off + retention late -> stale
  assert.equal(stale(false, { ...healthy, latestSuccessAt: minutesAgo(81) }, null), true);
  // retention never succeeded -> stale whatever the flag
  assert.equal(stale(false, { latestSuccessAt: null, latestFinished: null }, null), true);
  // flag on + worker never succeeded -> stale
  assert.equal(stale(true, healthy, null), true);
  // flag off + no worker record -> not stale
  assert.equal(stale(false, healthy, null), false);
  // flag on: the worker threshold is 80 minutes
  assert.equal(stale(true, healthy, minutesAgo(80)), false);
  assert.equal(stale(true, healthy, minutesAgo(81)), true);
});

test("the worker's claim and result transactions stay inside the worker lane's round-trip budget", async () => {
  const core = await import("../lib/supportTriageCore.ts");
  const AUDIT_ROUND_TRIPS = 4;
  // BEGIN, arm, lock reports, supersede, insert, claim, audit, deadline check, COMMIT.
  const claim = 1 + 1 + 1 + 1 + 1 + 1 + AUDIT_ROUND_TRIPS + 1 + 1;
  // BEGIN, arm, lock reports, ready CAS, audit, deadline check, COMMIT.
  const result = 1 + 1 + 1 + 1 + AUDIT_ROUND_TRIPS + 1 + 1;
  assert.equal(claim, 12);
  assert.equal(result, 10);
  assert.ok(Math.max(claim, result) <= core.LANE_TIMEOUTS.worker.maxRoundTrips);
  // A batch of 10 and a pass of 50 (design section 5.2).
  assert.equal(core.WORKER_CLAIM_BATCH_SIZE, 10);
  assert.equal(core.WORKER_PASS_MAX, 50);
});

test("the core's deleted-account marker is the one account deletion writes", async () => {
  const { readFileSync } = await import("node:fs");
  const core = await import("../lib/supportTriageCore.ts");
  const deletion = readFileSync(new URL("../lib/accountDeletion.ts", import.meta.url), "utf8");
  assert.ok(deletion.includes(`message: "${core.DELETED_ACCOUNT_MARKER}"`));
});

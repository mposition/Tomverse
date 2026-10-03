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

test("retention run deadline is one value of 100 s and admin has none", () => {
  assert.equal(LANE_TIMEOUTS.retention.deadlineMs, 100_000);
  assert.equal(LANE_TIMEOUTS.worker.deadlineMs, 300_000);
  assert.equal(LANE_TIMEOUTS.admin.deadlineMs, null);
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
  const healthy = {
    finishedAt: new Date("2026-10-03T11:40:00Z"),
    batchesCompleted: 3,
    overdueRemaining: 0,
    oldestOverdueAgeSeconds: 0,
  };
  const cases = [
    [null, { liveness: true, progressSingle: false, progressDeadline: false }],
    [healthy, { liveness: false, progressSingle: false, progressDeadline: false }],
    [{ ...healthy, finishedAt: new Date("2026-10-03T10:39:59Z") }, { liveness: true, progressSingle: false, progressDeadline: false }],
    [{ ...healthy, finishedAt: new Date("2026-10-03T10:40:00Z") }, { liveness: false, progressSingle: false, progressDeadline: false }],
    [{ ...healthy, batchesCompleted: 0, overdueRemaining: 4 }, { liveness: false, progressSingle: true, progressDeadline: false }],
    [{ ...healthy, batchesCompleted: 0, overdueRemaining: 0 }, { liveness: false, progressSingle: false, progressDeadline: false }],
    [{ ...healthy, oldestOverdueAgeSeconds: 86_401 }, { liveness: false, progressSingle: false, progressDeadline: true }],
    [{ ...healthy, oldestOverdueAgeSeconds: 86_400 }, { liveness: false, progressSingle: false, progressDeadline: false }],
  ];
  for (const [latestSuccess, expected] of cases) {
    const result = retentionHeartbeat({ now, latestSuccess });
    assert.deepEqual(
      result,
      { ...expected, stale: expected.liveness || expected.progressSingle || expected.progressDeadline },
      JSON.stringify(latestSuccess)
    );
  }
});

test("a flat positive backlog no longer passes: age, not trend, opens it", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  const flat = {
    finishedAt: new Date("2026-10-03T11:50:00Z"),
    batchesCompleted: 8,
    overdueRemaining: 1_000,
    oldestOverdueAgeSeconds: 90_000,
  };
  assert.equal(retentionHeartbeat({ now, latestSuccess: flat }).stale, true);
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

test("promotion budget refuses malformed input instead of guessing", () => {
  assert.throws(() => allocatePromotionBudget([], -1), RangeError);
  assert.throws(
    () => allocatePromotionBudget([{ kind: "same_account", groupCandidateKey: "a", moves: 50 }], 50),
    RangeError
  );
  assert.throws(
    () => allocatePromotionBudget([{ kind: "same_account", groupCandidateKey: "a", moves: 0 }], 50),
    RangeError
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_INFRA_FAILURE_REASONS,
  AMUX_MAX_INFRA_FAILURES_PER_TASK,
  amuxInfraFailureKindOfReason,
  amuxInfraFailureReason,
  amuxInfraFailureRoutingEnabled,
  amuxV22InfraFailureKind,
  classifyAmuxSidecarFailure,
} from "../lib/amux/infraFailureCore.ts";
import {
  AMUX_LEGACY_MAX_EXECUTION_ATTEMPTS,
  AMUX_MAX_EXECUTION_ATTEMPTS,
  AMUX_REPEATED_FAILURE_RUNS,
  amuxDefaultMaxAttempts,
  amuxRepeatedResultFailure,
  amuxResultFailureSignature,
  decideAmuxAttemptBudget,
  settlementDestinationForBudget,
} from "../lib/amux/executionBudgetCore.ts";
import {
  AMUX_WORKER_CIRCUIT_BASE_MS,
  AMUX_WORKER_CIRCUIT_MAX_MS,
  AMUX_WORKER_CIRCUIT_THRESHOLD,
  amuxWorkerCircuit,
  amuxWorkerCircuitAdmits,
  amuxWorkerCircuitWaitMs,
} from "../lib/amux/workerCircuitCore.ts";

const withRouting = (value, run) => {
  const prior = process.env.TOMVERSE_AMUX_INFRA_FAILURE_ROUTING;
  if (value === undefined) delete process.env.TOMVERSE_AMUX_INFRA_FAILURE_ROUTING;
  else process.env.TOMVERSE_AMUX_INFRA_FAILURE_ROUTING = value;
  try { return run(); } finally {
    if (prior === undefined) delete process.env.TOMVERSE_AMUX_INFRA_FAILURE_ROUTING;
    else process.env.TOMVERSE_AMUX_INFRA_FAILURE_ROUTING = prior;
  }
};

test("the review proposal guard counts attempts as the app does", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL(
    "../prisma/migrations/20261115140100_amux_review_retry_no_fixed_count/migration.sql", import.meta.url), "utf8");
  const listed = sql.match(/"reason" IN \(([^)]*)\)/)?.[1] ?? "";
  assert.deepEqual([...listed.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort(),
    [...AMUX_INFRA_FAILURE_REASONS].sort());
  assert.match(sql, new RegExp(`IF attempts_used >= ${AMUX_MAX_EXECUTION_ATTEMPTS} THEN`));
  // The attempt-number bounds hold every number the app can reach: the
  // runaway guard plus the infrastructure bound.
  for (const [file, pattern] of [
    ["20261115140200_amux_v22_attempt_number_bound", /NEW\."attemptNumber" NOT BETWEEN 1 AND (\d+) THEN/],
    ["20261115140300_amux_v22_recovery_attempt_bound", /recovery\."nextAttemptNumber" NOT BETWEEN 1 AND (\d+) OR/],
    ["20261115140400_amux_v22_recovery_approval_attempt_bound", /"nextAttemptNumber" BETWEEN 1 AND (\d+) AND/],
  ]) {
    const text = await readFile(new URL(`../prisma/migrations/${file}/migration.sql`, import.meta.url), "utf8");
    const bound = Number(text.match(pattern)?.[1]);
    assert.ok(bound >= AMUX_MAX_EXECUTION_ATTEMPTS + AMUX_MAX_INFRA_FAILURES_PER_TASK, file);
  }
});

test("the switch is on unless exactly disabled", () => {
  assert.equal(amuxInfraFailureRoutingEnabled(undefined), true);
  assert.equal(amuxInfraFailureRoutingEnabled("enabled"), true);
  assert.equal(amuxInfraFailureRoutingEnabled(" disabled "), false);
});

test("each sidecar failure is the platform's, unless the worker did the work", () => {
  // The production case (2026-11-15): Cursor exited 1 right after start, no result.
  assert.equal(classifyAmuxSidecarFailure({ code: "invalid_result", exitCode: 1, elapsedMs: 4_200 }), "early_exit");
  assert.equal(classifyAmuxSidecarFailure({ code: "invalid_result", elapsedMs: 9 * 60_000 }), "no_result");
  assert.equal(classifyAmuxSidecarFailure({ code: "invalid_result" }), "no_result");
  assert.equal(classifyAmuxSidecarFailure({ code: "channel_auth_refused" }), "auth_refused");
  assert.equal(classifyAmuxSidecarFailure({ code: "base_sync_develop_unavailable" }), "network");
  assert.equal(classifyAmuxSidecarFailure({ code: "usage_receipt_missing" }), "usage_unreported");
  for (const code of ["spawn", "child_io", "signal", "run_home_unavailable", "shell_jail_unavailable",
    "patch_baseline_worktree_dirty", "sidecar_unreachable", "something_new"])
    assert.equal(classifyAmuxSidecarFailure({ code }), "sidecar_error", code);
  // A run that worked past its deadline or its output bound did the work.
  assert.equal(classifyAmuxSidecarFailure({ code: "deadline" }), "result");
  assert.equal(classifyAmuxSidecarFailure({ code: "output_limit" }), "result");
});

test("only an unverified, unpaid settlement with nothing stored can be an infrastructure failure", () => {
  const base = { enabled: true, outcome: "blocked", budgetBound: false, apiReceipt: false,
    receiptsComplete: false, knownCliFailure: false, resultStored: false, patchStored: false,
    usageEventCount: 0 };
  assert.equal(amuxV22InfraFailureKind(base), "no_result", "an old bridge, nothing reported");
  assert.equal(amuxV22InfraFailureKind({ ...base, usageEventCount: 1 }), "usage_unreported");
  assert.equal(amuxV22InfraFailureKind({ ...base, failure: { code: "invalid_result", elapsedMs: 1_000 } }),
    "early_exit");
  assert.equal(amuxV22InfraFailureKind({ ...base, failure: { code: "deadline" } }), null);
  for (const change of [{ enabled: false }, { outcome: "failed" }, { outcome: "succeeded" },
    { budgetBound: true }, { apiReceipt: true }, { receiptsComplete: true },
    { knownCliFailure: true }, { resultStored: true }, { patchStored: true }])
    assert.equal(amuxV22InfraFailureKind({ ...base, ...change }), null, JSON.stringify(change));
});

test("infrastructure reasons round-trip and nothing else is one", () => {
  for (const reason of AMUX_INFRA_FAILURE_REASONS) assert.ok(amuxInfraFailureKindOfReason(reason));
  assert.equal(amuxInfraFailureReason("early_exit"), "infra_early_exit");
  for (const reason of [null, "", "cli_usage_unreported", "reported_result", "infra_attempts_exhausted"])
    assert.equal(amuxInfraFailureKindOfReason(reason), null);
});

test("infrastructure failures keep their number but use none of the card's attempts", () => withRouting(undefined, () => {
  // AMUX-SCHEDJOBS-003: five Cursor exits in twenty minutes.
  const five = decideAmuxAttemptBudget({ historical_rows: 5, greatest_attempt_number: 5, infra_rows: 5 });
  assert.deepEqual(five, { allowed: true, next_attempt_number: 6, max_attempts: AMUX_MAX_EXECUTION_ATTEMPTS });
  const capped = decideAmuxAttemptBudget({ historical_rows: AMUX_MAX_INFRA_FAILURES_PER_TASK,
    greatest_attempt_number: AMUX_MAX_INFRA_FAILURES_PER_TASK, infra_rows: AMUX_MAX_INFRA_FAILURES_PER_TASK });
  assert.equal(capped.allowed, false);
  assert.equal(capped.exhausted_limit, "infra_attempts");
  // No fixed count of five stops an ordinary card any more.
  assert.equal(decideAmuxAttemptBudget({ historical_rows: 5, greatest_attempt_number: 5 }).allowed, true);
  assert.equal(decideAmuxAttemptBudget({ historical_rows: AMUX_MAX_EXECUTION_ATTEMPTS,
    greatest_attempt_number: AMUX_MAX_EXECUTION_ATTEMPTS }).allowed, false, "the runaway guard");
  // A paid retry still names its own exact bound.
  assert.equal(decideAmuxAttemptBudget({ historical_rows: 2, greatest_attempt_number: 2, max_attempts: 2 }).allowed, false);
  // A person's retry starts the infrastructure bound over: only the failures
  // since it count, and none of them use the card's attempts.
  const afterRetry = decideAmuxAttemptBudget({ historical_rows: 14, greatest_attempt_number: 14,
    infra_rows: 13, infra_window_rows: 1 });
  assert.deepEqual(afterRetry, { allowed: true, next_attempt_number: 15, max_attempts: AMUX_MAX_EXECUTION_ATTEMPTS });
  assert.equal(decideAmuxAttemptBudget({ historical_rows: 25, greatest_attempt_number: 25,
    infra_rows: 24, infra_window_rows: AMUX_MAX_INFRA_FAILURES_PER_TASK }).exhausted_limit, "infra_attempts");
  // The window is never larger than the total.
  assert.equal(decideAmuxAttemptBudget({ historical_rows: 3, greatest_attempt_number: 3,
    infra_rows: 2, infra_window_rows: 50 }).allowed, true);
  assert.equal(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 15,
    infra_attempts_before: 13, infra_window_before: 2, infra_failure: true }).to_status, "todo");
  assert.equal(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 25,
    infra_attempts_before: 23, infra_window_before: AMUX_MAX_INFRA_FAILURES_PER_TASK - 1,
    infra_failure: true }).exhausted_limit, "infra_attempts");
}));

test("the kill switch restores the five-attempt count", () => withRouting("disabled", () => {
  assert.equal(amuxDefaultMaxAttempts(), AMUX_LEGACY_MAX_EXECUTION_ATTEMPTS);
  assert.equal(decideAmuxAttemptBudget({ historical_rows: 5, greatest_attempt_number: 5 }).allowed, false);
  assert.equal(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 5 }).to_status, "blocked");
}));

test("settlement hands a repeated failure to a person; an infrastructure failure goes back to todo", () => withRouting(undefined, () => {
  assert.deepEqual(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 9,
    infra_attempts_before: 8, infra_failure: true }),
  { to_status: "todo", exhausted_limit: null, max_attempts: AMUX_MAX_EXECUTION_ATTEMPTS });
  assert.equal(settlementDestinationForBudget({ requested_status: "todo",
    attempt_number: AMUX_MAX_INFRA_FAILURES_PER_TASK,
    infra_attempts_before: AMUX_MAX_INFRA_FAILURES_PER_TASK - 1, infra_failure: true }).exhausted_limit,
  "infra_attempts");
  assert.deepEqual(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 3,
    repeated_failure: true }),
  { to_status: "blocked", exhausted_limit: "repeated_failure", max_attempts: AMUX_MAX_EXECUTION_ATTEMPTS });
  // Earlier infrastructure failures do not move a result failure toward the bound.
  assert.equal(settlementDestinationForBudget({ requested_status: "todo",
    attempt_number: AMUX_MAX_EXECUTION_ATTEMPTS, infra_attempts_before: 3 }).to_status, "todo");
  assert.equal(settlementDestinationForBudget({ requested_status: "review", attempt_number: 40,
    repeated_failure: true }).to_status, "review");
}));

test("the infrastructure failure that reaches the bound keeps its own attempt reason", async () => {
  // Review r-20261115-120153-60193b: the twelfth failure was stored as
  // infra_attempts_exhausted, so the budget read eleven and the worker's
  // quarantine streak reset. The bound is named by the escalation only.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../lib/amux/execution.ts", import.meta.url), "utf8");
  const settle = source.slice(source.indexOf("await tx.amuxExecutionAttempt.update({ where: { id: attempt.id },\n        data: { endedAt: now, leaseExpiresAt: null, heartbeatAt: now,"));
  assert.match(settle.slice(0, 900), /reason: gradeEscalated \? "contract_path_touched" :\s+infraKind \? amuxInfraFailureReason\(infraKind\) :\s+next === "blocked" \? blockedReason :/);
  assert.match(source, /const blockedReason = [\s\S]{0,400}exhaustedReason \?\? reviewDisposition\?\.reason/,
    "the escalation still names the bound");
  const reaper = source.slice(source.indexOf("endedBy: \"system:amux-v22-execution-reaper\","));
  assert.match(reaper.slice(0, 500), /reason: retry \|\| infraExhausted \? \(infraRetry \? amuxInfraFailureReason\("lease_expired"\) :/);
  assert.match(reaper.slice(0, 1600), /reason: infraExhausted \?\s+AMUX_INFRA_ATTEMPTS_EXHAUSTED_REASON : "execution_lease_expired"/);
  assert.ok(!AMUX_INFRA_FAILURE_REASONS.includes("infra_attempts_exhausted"),
    "the bound's name is not itself a counted failure");
});

test("only the same result failure three runs in a row is a repeat", () => {
  const failed = amuxResultFailureSignature("failed", "reported_result");
  assert.equal(AMUX_REPEATED_FAILURE_RUNS, 3);
  assert.equal(amuxRepeatedResultFailure([failed, failed]), false);
  assert.equal(amuxRepeatedResultFailure([failed, failed, failed]), true);
  assert.equal(amuxRepeatedResultFailure([failed, failed, amuxResultFailureSignature("failed", "cli_turn_limit")]), false);
  assert.equal(amuxRepeatedResultFailure([failed, failed, failed, "older:anything"]), true);
});

test("a worker is quarantined after three platform failures in a row and tried again later", () => {
  const now = 10_000_000;
  const infra = (minutesAgo, reason = "infra_early_exit") => ({ reason, endedAtMs: now - minutesAgo * 60_000 });
  const run = (recent, usageObservedAtMs = null, nowMs = now) =>
    amuxWorkerCircuit({ enabled: true, recent, usageObservedAtMs, nowMs });
  assert.equal(run([infra(1), infra(2)]).state, "closed");
  assert.equal(run([infra(1), infra(2), { reason: "reported_result", endedAtMs: now - 180_000 }, infra(4)]).state, "closed");
  const open = run([infra(1), infra(2), infra(3)]);
  assert.equal(open.state, "open");
  assert.equal(open.retryAtMs, now - 60_000 + AMUX_WORKER_CIRCUIT_BASE_MS);
  assert.equal(amuxWorkerCircuitAdmits(open), false);
  // The wait is over: one card may try it.
  assert.equal(run([infra(6), infra(7), infra(8)]).state, "probing");
  // Its usage was read again after the last failure: its sign-in works again.
  const observed = run([infra(1), infra(2), infra(3)], now - 10_000);
  assert.deepEqual([observed.state, observed.why], ["probing", "usage_observed"]);
  assert.equal(amuxWorkerCircuitAdmits(observed), true);
  // A reading only buys early tries twice; then the timer alone.
  assert.equal(run([infra(1), infra(2), infra(3), infra(4), infra(5)], now - 10_000).state, "open");
  // The wait doubles, up to an hour.
  assert.equal(amuxWorkerCircuitWaitMs(AMUX_WORKER_CIRCUIT_THRESHOLD), AMUX_WORKER_CIRCUIT_BASE_MS);
  assert.equal(amuxWorkerCircuitWaitMs(AMUX_WORKER_CIRCUIT_THRESHOLD + 1), 2 * AMUX_WORKER_CIRCUIT_BASE_MS);
  assert.equal(amuxWorkerCircuitWaitMs(40), AMUX_WORKER_CIRCUIT_MAX_MS);
  // The kill switch closes every circuit.
  assert.equal(amuxWorkerCircuit({ enabled: false, recent: [infra(1), infra(2), infra(3)],
    usageObservedAtMs: null, nowMs: now }).state, "closed");
});

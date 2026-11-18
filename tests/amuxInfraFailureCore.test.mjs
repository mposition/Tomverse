import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_INFRA_FAILURE_REASONS,
  amuxInfraRetryDelayMs,
  amuxInfraFailureKindOfReason,
  amuxInfraFailureReason,
  amuxV22InfraFailureKind,
  classifyAmuxSidecarFailure,
} from "../lib/amux/infraFailureCore.ts";
import {
  AMUX_REPEATED_FAILURE_RUNS,
  amuxResultFailureSignature,
  amuxResultFailureStreak,
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

test("the review proposal guard counts no attempts, as the app does", async () => {
  const { readFile } = await import("node:fs/promises");
  // Owner direction 2026-11-18: an ordinary card has no attempt bound, and
  // the guard's thirty is gone with it (20261118100000_amux_review_retry_no_attempt_bound).
  const sql = await readFile(new URL(
    "../prisma/migrations/20261118100000_amux_review_retry_no_attempt_bound/migration.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE OR REPLACE FUNCTION amux_review_proposal_issue_guard\(\)/);
  const body = sql.slice(sql.indexOf("$$"), sql.lastIndexOf("$$"));
  assert.ok(body.length > 100);
  assert.doesNotMatch(body, /attempts_used|attempt budget exhausted/);
  // The reasons it counted before are still the app's infrastructure reasons.
  const before = await readFile(new URL(
    "../prisma/migrations/20261116011400_amux_review_retry_no_fixed_count/migration.sql", import.meta.url), "utf8");
  const listed = before.match(/"reason" IN \(([^)]*)\)/)?.[1] ?? "";
  assert.deepEqual([...listed.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort(),
    [...AMUX_INFRA_FAILURE_REASONS].sort());
  // Platform failures have no count, so the attempt-number guards hold no
  // upper bound either (20261116130200, 20261116130300, 20261116130400).
  for (const [file, pattern] of [
    ["20261116130200_amux_v22_attempt_number_unbounded", /NEW\."attemptNumber" < 1 THEN/],
    ["20261116130300_amux_v22_recovery_attempt_unbounded", /recovery\."nextAttemptNumber" < 1 OR/],
    ["20261116130400_amux_v22_recovery_approval_attempt_unbounded", /\("nextAttemptNumber" >= 1\)/],
  ]) {
    const text = await readFile(new URL(`../prisma/migrations/${file}/migration.sql`, import.meta.url), "utf8");
    assert.match(text, pattern, file);
    assert.doesNotMatch(text, /AND 64|<= 64/, file);
  }
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
  // The local CLI flow's stops (#4004): `stalled` is no longer produced (owner
  // decision 2026-11-18) but earlier attempts keep it, and it is still the
  // worker's own run; a person's stop and the sidecar's failed transcript
  // write are not, and use none of the card's attempts.
  assert.equal(classifyAmuxSidecarFailure({ code: "stalled", cliStarted: true }), "result");
  assert.equal(classifyAmuxSidecarFailure({ code: "operator_stop", cliStarted: true }), "sidecar_error");
  assert.equal(classifyAmuxSidecarFailure({ code: "transcript_write_failed", cliStarted: true }), "sidecar_error");
  assert.equal(classifyAmuxSidecarFailure({ code: "leftover_preserve_unavailable", cliStarted: false }), "sidecar_error");
});

test("only an unverified, unpaid settlement with nothing stored can be an infrastructure failure", () => {
  const base = { outcome: "blocked", budgetBound: false, apiReceipt: false,
    receiptsComplete: false, knownCliFailure: false, resultStored: false, patchStored: false,
    usageEventCount: 0 };
  assert.equal(amuxV22InfraFailureKind(base), "no_result", "an old bridge, nothing reported");
  assert.equal(amuxV22InfraFailureKind({ ...base, usageEventCount: 1 }), "usage_unreported");
  assert.equal(amuxV22InfraFailureKind({ ...base, failure: { code: "invalid_result", elapsedMs: 1_000 } }),
    "early_exit");
  assert.equal(amuxV22InfraFailureKind({ ...base, failure: { code: "deadline" } }), null);
  for (const change of [{ outcome: "failed" }, { outcome: "succeeded" },
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

test("infrastructure failures keep their number but use none of the card's attempts", () => {
  // AMUX-SCHEDJOBS-003: five Cursor exits in twenty minutes.
  const five = decideAmuxAttemptBudget({ historical_rows: 5, greatest_attempt_number: 5, infra_rows: 5 });
  assert.deepEqual(five, { allowed: true, next_attempt_number: 6, max_attempts: null });
  // No count of platform failures stops a card either (2026-11-16: twelve did).
  const many = decideAmuxAttemptBudget({ historical_rows: 200, greatest_attempt_number: 200, infra_rows: 200 });
  assert.deepEqual(many, { allowed: true, next_attempt_number: 201, max_attempts: null });
  // No fixed count of five stops an ordinary card any more.
  assert.equal(decideAmuxAttemptBudget({ historical_rows: 5, greatest_attempt_number: 5 }).allowed, true);
  assert.equal(decideAmuxAttemptBudget({ historical_rows: 30, greatest_attempt_number: 30 }).allowed, true,
    "no runaway guard of thirty any more (2026-11-18)");
  // A paid retry still names its own exact bound.
  assert.equal(decideAmuxAttemptBudget({ historical_rows: 2, greatest_attempt_number: 2, max_attempts: 2 }).allowed, false);
  // The platform failures only delay the next try: none for two, then a minute
  // that doubles up to an hour.
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9, 10, 12, 100].map(amuxInfraRetryDelayMs),
    [0, 0, 0, 60_000, 120_000, 240_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000]);
  assert.equal(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 150,
    infra_attempts_before: 149, infra_failure: true }).to_status, "todo");
});

test("settlement never hands a repeated failure to a person; an infrastructure failure goes back to todo", () => {
  assert.deepEqual(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 9,
    infra_attempts_before: 8, infra_failure: true }),
  { to_status: "todo", exhausted_limit: null, max_attempts: null });
  assert.equal(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 40,
    infra_attempts_before: 39, infra_failure: true }).to_status, "todo",
  "no count of platform failures hands a card over");
  // A result failure goes back to todo however many runs failed the same way
  // before it; the claim waits longer instead (amuxResultRetryDelayMs).
  assert.deepEqual(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 3 }),
  { to_status: "todo", exhausted_limit: null, max_attempts: null });
  assert.equal(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 400,
    infra_attempts_before: 3 }).to_status, "todo");
  assert.equal(settlementDestinationForBudget({ requested_status: "review", attempt_number: 40 }).to_status, "review");
});

test("an infrastructure failure keeps its own attempt reason and never names a bound", async () => {
  // Review r-20261115-120153-60193b: a failure stored under the bound's name
  // read as one fewer and reset the worker's quarantine streak. There is no
  // bound now (2026-11-16), so nothing opens that escalation.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../lib/amux/execution.ts", import.meta.url), "utf8");
  const settle = source.slice(source.indexOf("await tx.amuxExecutionAttempt.update({ where: { id: attempt.id },\n        data: { endedAt: now, leaseExpiresAt: null, heartbeatAt: now,"));
  assert.match(settle.slice(0, 900), /reason: gradeEscalated \? "contract_path_touched" :\s+infraKind \? amuxInfraFailureReason\(infraKind\) :\s+next === "blocked" \? blockedReason :/);
  const reaper = source.slice(source.indexOf("endedBy: \"system:amux-v22-execution-reaper\","));
  assert.match(reaper.slice(0, 500), /reason: retry \? amuxInfraFailureReason\("lease_expired"\) : "outcome_unknown"/);
  assert.doesNotMatch(source, /AMUX_INFRA_ATTEMPTS_EXHAUSTED_REASON/);
  assert.ok(!AMUX_INFRA_FAILURE_REASONS.includes("infra_attempts_exhausted"),
    "the bound's name is not itself a counted failure");
});

test("a streak is the newest runs that failed the same way in a row", () => {
  const failed = amuxResultFailureSignature("failed", "reported_result");
  assert.equal(AMUX_REPEATED_FAILURE_RUNS, 3);
  assert.equal(amuxResultFailureStreak([]), 0);
  assert.equal(amuxResultFailureStreak([failed]), 1);
  assert.equal(amuxResultFailureStreak([failed, failed]), 2);
  assert.equal(amuxResultFailureStreak([failed, failed, failed]), 3);
  assert.equal(amuxResultFailureStreak([failed, failed, amuxResultFailureSignature("failed", "cli_turn_limit")]), 2);
  assert.equal(amuxResultFailureStreak([failed, failed, failed, "older:anything"]), 3);
  assert.equal(amuxResultFailureStreak([amuxResultFailureSignature("failed", "cli_turn_limit"), failed, failed]), 1);
});

test("a worker is quarantined after three platform failures in a row and tried again later", () => {
  const now = 10_000_000;
  const infra = (minutesAgo, reason = "infra_early_exit") => ({ reason, endedAtMs: now - minutesAgo * 60_000 });
  const run = (recent, usageObservedAtMs = null, nowMs = now) =>
    amuxWorkerCircuit({ recent, usageObservedAtMs, nowMs });
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
});

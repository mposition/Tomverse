import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAttempt,
  classifyChatRefusal,
  decideDueOccurrence,
  failureStreakAfter,
  nextOccurrence,
  planRunsScheduledTasks,
  scheduleProblem,
  scheduledTasksHostProblem,
  scheduledTasksEntryVisible,
  SCHEDULED_TASK_CREDIT_CAP_CODE,
  SCHEDULED_TASK_FREQUENCIES,
  SCHEDULED_TASK_LIMITS,
  zonedWallTimeToInstant,
} from "../lib/scheduledTaskCore.ts";
import {
  scheduledTasksAvailable,
  scheduledTasksEnabledFromValue,
} from "../lib/scheduledTaskAccess.ts";

const schedule = (overrides) => ({
  frequency: "daily",
  timeOfDay: "08:00",
  dayOfWeek: null,
  dayOfMonth: null,
  runOnDate: null,
  timeZone: "Asia/Seoul",
  ...overrides,
});

test("the switch is on only for the literal true, and the kill switch beats it", () => {
  for (const value of [undefined, null, "", "TRUE", "1", "yes", " true", "false"]) {
    assert.equal(scheduledTasksEnabledFromValue(value), false, String(value));
  }
  assert.equal(scheduledTasksEnabledFromValue("true"), true);
  assert.equal(scheduledTasksAvailable({ storedFlagValue: "true", env: {} }), true);
  assert.equal(scheduledTasksAvailable({ storedFlagValue: "true", env: { SCHEDULED_TASKS_KILL_SWITCH: "1" } }), false);
  assert.equal(scheduledTasksAvailable({ storedFlagValue: "true", env: { SCHEDULED_TASKS_KILL_SWITCH: "  " } }), true);
});

test("nothing runs more often than daily: there is no faster frequency and the interval guard is under a day", () => {
  assert.deepEqual([...SCHEDULED_TASK_FREQUENCIES], ["once", "daily", "weekly", "monthly"]);
  assert.ok(SCHEDULED_TASK_LIMITS.minRunIntervalMs >= 20 * 60 * 60 * 1_000);
  assert.ok(SCHEDULED_TASK_LIMITS.minRunIntervalMs < 24 * 60 * 60 * 1_000);
  assert.equal(SCHEDULED_TASK_LIMITS.maxActiveTasks, 5);
  assert.equal(SCHEDULED_TASK_LIMITS.maxConsecutiveFailures, 3);
});

test("only Pro and Max run scheduled tasks", () => {
  assert.equal(planRunsScheduledTasks("Pro"), true);
  assert.equal(planRunsScheduledTasks("Max"), true);
  for (const plan of ["Free", "pro", "", null, undefined]) assert.equal(planRunsScheduledTasks(plan), false);
});

test("the settings row is hidden while the switch is off and nothing was saved", () => {
  assert.equal(scheduledTasksEntryVisible(null), false);
  assert.equal(scheduledTasksEntryVisible({ enabled: false, planAllowed: true, tasks: [] }), false);
  assert.equal(scheduledTasksEntryVisible({ enabled: true, planAllowed: false, tasks: [] }), false);
  assert.equal(scheduledTasksEntryVisible({ enabled: true, planAllowed: true, tasks: [] }), true);
  // Tasks saved before the switch went off stay reachable, to be seen and deleted.
  assert.equal(scheduledTasksEntryVisible({ enabled: false, planAllowed: false, tasks: [{}] }), true);
});

test("a schedule carries exactly the field its frequency is read with", () => {
  assert.equal(scheduleProblem(schedule({})), null);
  assert.equal(scheduleProblem(schedule({ timeOfDay: "24:00" })), "time_invalid");
  assert.equal(scheduleProblem(schedule({ timeOfDay: "8:00" })), "time_invalid");
  assert.equal(scheduleProblem(schedule({ timeZone: "Mars/Olympus" })), "time_zone_invalid");
  assert.equal(scheduleProblem(schedule({ dayOfWeek: 1 })), "fields_mismatch");
  assert.equal(scheduleProblem(schedule({ frequency: "weekly" })), "fields_mismatch");
  assert.equal(scheduleProblem(schedule({ frequency: "weekly", dayOfWeek: 7 })), "day_of_week_invalid");
  assert.equal(scheduleProblem(schedule({ frequency: "monthly", dayOfMonth: 0 })), "day_of_month_invalid");
  assert.equal(scheduleProblem(schedule({ frequency: "once", runOnDate: "2026-02-30" })), "date_invalid");
  assert.equal(scheduleProblem(schedule({ frequency: "once", runOnDate: "2026-12-01" })), null);
});

test("daily runs at the next local time in the task's own zone", () => {
  // 2026-11-27 07:00 in Seoul is 2026-11-26T22:00Z.
  const before = new Date("2026-11-26T22:00:00Z");
  assert.equal(nextOccurrence(schedule({}), before)?.toISOString(), "2026-11-26T23:00:00.000Z");
  // Exactly at the time is not "after" it: the next one is tomorrow.
  assert.equal(nextOccurrence(schedule({}), new Date("2026-11-26T23:00:00Z"))?.toISOString(), "2026-11-27T23:00:00.000Z");
});

test("a daily time stays at its wall-clock time across a DST change", () => {
  const newYork = schedule({ timeZone: "America/New_York" });
  // US DST ends 2026-11-01: 08:00 EDT is 12:00Z, 08:00 EST is 13:00Z.
  assert.equal(nextOccurrence(newYork, new Date("2026-10-31T13:00:00Z"))?.toISOString(), "2026-11-01T13:00:00.000Z");
  assert.equal(nextOccurrence(newYork, new Date("2026-10-30T13:00:00Z"))?.toISOString(), "2026-10-31T12:00:00.000Z");
  // DST starts 2026-03-08 at 02:00, so 02:30 does not exist that day; the run
  // lands on a real instant that day rather than vanishing.
  const skipped = nextOccurrence(schedule({ timeZone: "America/New_York", timeOfDay: "02:30" }), new Date("2026-03-08T05:00:00Z"));
  assert.ok(skipped && skipped.toISOString().startsWith("2026-03-08T"), skipped?.toISOString());
});

test("weekly runs on the chosen weekday", () => {
  // 2026-11-27 is a Friday. Monday 2026-11-30 08:00 Seoul is 2026-11-29T23:00Z.
  const weekly = schedule({ frequency: "weekly", dayOfWeek: 1 });
  assert.equal(nextOccurrence(weekly, new Date("2026-11-27T00:00:00Z"))?.toISOString(), "2026-11-29T23:00:00.000Z");
});

test("monthly runs on the last day of a month that lacks the date", () => {
  const monthly = schedule({ frequency: "monthly", dayOfMonth: 31, timeZone: "UTC" });
  assert.equal(nextOccurrence(monthly, new Date("2027-02-01T00:00:00Z"))?.toISOString(), "2027-02-28T08:00:00.000Z");
  assert.equal(nextOccurrence(monthly, new Date("2028-02-01T00:00:00Z"))?.toISOString(), "2028-02-29T08:00:00.000Z");
  assert.equal(nextOccurrence(monthly, new Date("2027-02-28T09:00:00Z"))?.toISOString(), "2027-03-31T08:00:00.000Z");
});

test("a one-off has one occurrence and none once it has passed", () => {
  const once = schedule({ frequency: "once", runOnDate: "2026-12-01", timeZone: "UTC" });
  assert.equal(nextOccurrence(once, new Date("2026-11-30T00:00:00Z"))?.toISOString(), "2026-12-01T08:00:00.000Z");
  assert.equal(nextOccurrence(once, new Date("2026-12-01T08:00:00Z")), null);
});

test("wall time to instant handles a zone ahead of and behind UTC", () => {
  assert.equal(zonedWallTimeToInstant({ year: 2026, month: 11, day: 27, hour: 8, minute: 0 }, "Australia/Brisbane").toISOString(), "2026-11-26T22:00:00.000Z");
  assert.equal(zonedWallTimeToInstant({ year: 2026, month: 11, day: 27, hour: 8, minute: 0 }, "America/Los_Angeles").toISOString(), "2026-11-27T16:00:00.000Z");
});

test("a late occurrence is skipped rather than fired, and two runs are never closer than the interval", () => {
  const daily = schedule({ timeZone: "UTC" });
  const dueAt = new Date("2026-11-27T08:00:00Z");
  assert.deepEqual(decideDueOccurrence({ schedule: daily, dueAt, now: new Date("2026-11-27T08:10:00Z"), previousScheduledFor: null }),
    { kind: "run", scheduledFor: dueAt });
  const late = decideDueOccurrence({ schedule: daily, dueAt, now: new Date("2026-11-27T11:30:00Z"), previousScheduledFor: null });
  assert.equal(late.kind, "skip_late");
  assert.equal(late.next?.toISOString(), "2026-11-28T08:00:00.000Z");
  // An edit that moved today's time later must not run twice in one day.
  const tooSoon = decideDueOccurrence({ schedule: daily, dueAt, now: new Date("2026-11-27T08:01:00Z"),
    previousScheduledFor: new Date("2026-11-27T06:00:00Z") });
  assert.equal(tooSoon.kind, "skip_too_soon");
  assert.equal(decideDueOccurrence({ schedule: daily, dueAt, now: new Date("2026-11-27T08:01:00Z"),
    previousScheduledFor: new Date("2026-11-26T08:00:00Z") }).kind, "run");
});

test("a Chat refusal names why and pauses only for what the person must fix", () => {
  for (const code of ["PLAN_ENTITLEMENT_EXHAUSTED", "CREDIT_BALANCE_INSUFFICIENT", "CREDIT_COST_ALLOWANCE_INSUFFICIENT", "PLAN_DAILY_CREDIT_LIMIT_REACHED"]) {
    assert.deepEqual(classifyChatRefusal(402, code), { status: "skipped", outcome: code, pause: "insufficient_credits" });
  }
  assert.deepEqual(classifyChatRefusal(402, SCHEDULED_TASK_CREDIT_CAP_CODE), { status: "skipped", outcome: SCHEDULED_TASK_CREDIT_CAP_CODE, pause: "cost_changed" });
  assert.equal(classifyChatRefusal(400, "MODEL_NOT_AVAILABLE").pause, "model_unavailable");
  assert.equal(classifyChatRefusal(423, "CONVERSATION_LOCKED").pause, "conversation_locked");
  for (const code of ["CHAT_CONCURRENCY_EXCEEDED", "PROVIDER_BUDGET_EXHAUSTED", "AI_CHAT_DISABLED_BY_ADMIN"]) {
    assert.deepEqual(classifyChatRefusal(503, code), { status: "skipped", outcome: code, pause: null }, code);
  }
  assert.deepEqual(classifyChatRefusal(500, "SOMETHING_ELSE"), { status: "failed", outcome: "SOMETHING_ELSE", pause: null });
  // Provider or exception text never becomes an outcome.
  assert.equal(classifyChatRefusal(500, "boom: <html>").outcome, "http_500");
  assert.equal(classifyChatRefusal(502, undefined).outcome, "http_502");
});

test("a drained run is judged by its attempt, and a lapsed one is unknown, not retried", () => {
  const now = new Date("2026-11-27T08:00:00Z");
  const live = new Date("2026-11-27T08:03:00Z");
  const lapsed = new Date("2026-11-27T07:59:00Z");
  assert.deepEqual(classifyAttempt(null, now), { status: "failed", outcome: "no_answer", pause: null });
  assert.equal(classifyAttempt({ status: "completed", failureCode: null, leaseExpiresAt: lapsed }, now).status, "succeeded");
  assert.deepEqual(classifyAttempt({ status: "failed", failureCode: "provider_error", leaseExpiresAt: lapsed }, now),
    { status: "failed", outcome: "provider_error", pause: null });
  assert.equal(classifyAttempt({ status: "streaming", failureCode: null, leaseExpiresAt: live }, now), null);
  assert.deepEqual(classifyAttempt({ status: "streaming", failureCode: null, leaseExpiresAt: lapsed }, now),
    { status: "unknown", outcome: "outcome_unknown", pause: null });
});

test("three failures in a row pause the task; a skip spends nothing and counts nothing", () => {
  const failed = { status: "failed", outcome: "provider_error", pause: null };
  const unknown = { status: "unknown", outcome: "outcome_unknown", pause: null };
  assert.deepEqual(failureStreakAfter(0, failed), { consecutiveFailures: 1, pause: null });
  assert.deepEqual(failureStreakAfter(1, unknown), { consecutiveFailures: 2, pause: null });
  assert.deepEqual(failureStreakAfter(2, failed), { consecutiveFailures: 3, pause: "repeated_failures" });
  assert.deepEqual(failureStreakAfter(2, { status: "skipped", outcome: "x", pause: null }), { consecutiveFailures: 2, pause: null });
  assert.deepEqual(failureStreakAfter(2, { status: "skipped", outcome: "x", pause: "insufficient_credits" }),
    { consecutiveFailures: 2, pause: "insufficient_credits" });
  assert.deepEqual(failureStreakAfter(2, { status: "succeeded", outcome: "completed", pause: null }), { consecutiveFailures: 0, pause: null });
});

test("unattended runs start only on a long-lived server, never on a serverless host", () => {
  assert.equal(scheduledTasksHostProblem({}), null);
  assert.equal(scheduledTasksHostProblem({ RAILWAY_ENVIRONMENT_NAME: "production", NODE_ENV: "production" }), null);
  for (const name of ["VERCEL", "AWS_LAMBDA_FUNCTION_NAME", "NETLIFY", "FUNCTIONS_WORKER_RUNTIME"]) {
    assert.equal(scheduledTasksHostProblem({ [name]: "1" }), "serverless_host", name);
  }
  assert.equal(scheduledTasksHostProblem({ VERCEL: "  " }), null);
});

test("the minimum interval holds between real start times, not only between occurrences", () => {
  // Yesterday's 08:00 run started late at 10:59; the schedule was then moved to 04:00.
  const early = schedule({ timeZone: "UTC", timeOfDay: "04:00" });
  const dueAt = new Date("2026-11-28T04:00:00Z");
  const input = {
    schedule: early, dueAt, now: new Date("2026-11-28T04:01:00Z"),
    previousScheduledFor: new Date("2026-11-27T08:00:00Z"),
  };
  // Twenty hours between the two occurrences: allowed by the occurrence check alone.
  assert.equal(decideDueOccurrence(input).kind, "run");
  const decision = decideDueOccurrence({ ...input, previousStartedAt: new Date("2026-11-27T10:59:00Z") });
  assert.equal(decision.kind, "skip_too_soon");
  assert.equal(decision.next?.toISOString(), "2026-11-29T04:00:00.000Z");
  assert.equal(decideDueOccurrence({ ...input, now: new Date("2026-11-28T07:00:00Z"), previousStartedAt: new Date("2026-11-27T10:59:00Z") }).kind,
    "run");
});

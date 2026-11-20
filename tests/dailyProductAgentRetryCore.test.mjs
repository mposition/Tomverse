import assert from "node:assert/strict";
import test from "node:test";
import { automaticDailyRetry } from "../lib/dailyProductAgentRetryCore.ts";

const DAY = 86_400_000;
const now = Date.parse("2026-11-15T00:00:00Z");
const failed = { status: "failed", reason: "tests", at: new Date(now - DAY).toISOString(),
  claimId: "11111111-2222-4333-8444-555555555555" };

test("automatic retries require opt-in, a later Brisbane date and fewer than three attempts", () => {
  assert.equal(automaticDailyRetry(failed, now, false), false);
  assert.equal(automaticDailyRetry(failed, now, true), true);
  assert.equal(automaticDailyRetry(failed, now - 1, true), true);
  assert.equal(automaticDailyRetry({ ...failed, attempts: 2 }, now, true), true);
  for (const attempts of [0, -1, 1.5, 3, 4, NaN]) assert.equal(automaticDailyRetry({ ...failed, attempts }, now, true), false);
  assert.equal(automaticDailyRetry({ ...failed, finishedAt: new Date(now - DAY + 1).toISOString() }, now, true), true);
  assert.equal(automaticDailyRetry({ ...failed, leaseUntil: new Date(now - DAY + 1).toISOString() }, now, true), true);
});

test("a failure after 09:00 retries at the next 09:00 without waiting another full day", () => {
  const at = Date.parse("2026-11-16T23:15:00Z"); // Nov 17 09:15 AEST
  const entry = { ...failed, finishedAt: new Date(at).toISOString() };
  assert.equal(automaticDailyRetry(entry, Date.parse("2026-11-17T23:00:00Z"), true), true);
  assert.equal(automaticDailyRetry(entry, Date.parse("2026-11-17T13:59:59Z"), true), false);
  assert.equal(automaticDailyRetry(entry, Date.parse("2026-11-17T14:00:00Z"), true), true);
  assert.equal(automaticDailyRetry(entry, at - 1, true), false);
  assert.equal(automaticDailyRetry(entry, NaN, true), false);
  assert.equal(automaticDailyRetry({ ...entry, finishedAt: "invalid" }, now, true), false);
  // Missing completion time never bypasses an outstanding legacy lease.
  assert.equal(automaticDailyRetry({ ...failed, leaseUntil: "2026-11-18T01:00:00Z" }, Date.parse("2026-11-17T23:00:00Z"), true), false);
});

test("only known test/no-change failures qualify; publication and ownership remain fenced", () => {
  assert.equal(automaticDailyRetry({ ...failed, reason: "no_change" }, now, true), true);
  for (const reason of ["already_satisfied", "covered_by_pr", "review_unknown", "push_failed", "pr_failed", "out_of_scope", "review_reject", "timeout", "agent_error"]) {
    assert.equal(automaticDailyRetry({ ...failed, reason }, now, true), false);
  }
  for (const status of ["claimed", "pr_opened", "done", "dismissed", "sent_to_amux"]) {
    assert.equal(automaticDailyRetry({ ...failed, status }, now, true), false);
  }
  for (const patch of [{ at: "invalid" }, { claimId: "bad" }, { prUrl: "https://github.com/mposition/Tomverse/pull/1" }, { amuxIdeaId: "one" }]) {
    assert.equal(automaticDailyRetry({ ...failed, ...patch }, now, true), false);
  }
  assert.equal(automaticDailyRetry(null, now, true), false);
});

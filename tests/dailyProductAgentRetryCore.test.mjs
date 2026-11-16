import assert from "node:assert/strict";
import test from "node:test";
import { automaticDailyRetry, DAILY_PRODUCT_AGENT_RETRY_DELAY_MS as DAY } from "../lib/dailyProductAgentRetryCore.ts";

const now = Date.parse("2026-11-15T00:00:00Z");
const failed = { status: "failed", reason: "tests", at: new Date(now - DAY).toISOString(),
  claimId: "11111111-2222-4333-8444-555555555555" };

test("automatic retries require opt-in, cooldown and fewer than three attempts", () => {
  assert.equal(automaticDailyRetry(failed, now, false), false);
  assert.equal(automaticDailyRetry(failed, now, true), true);
  assert.equal(automaticDailyRetry(failed, now - 1, true), false);
  assert.equal(automaticDailyRetry({ ...failed, attempts: 2 }, now, true), true);
  for (const attempts of [0, -1, 1.5, 3, 4, NaN]) assert.equal(automaticDailyRetry({ ...failed, attempts }, now, true), false);
  assert.equal(automaticDailyRetry({ ...failed, finishedAt: new Date(now - DAY + 1).toISOString() }, now, true), false);
  assert.equal(automaticDailyRetry({ ...failed, leaseUntil: new Date(now - DAY + 1).toISOString() }, now, true), false);
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

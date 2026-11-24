// The reviewer CLIs' own usage-limit messages, read into a hold that outranks
// the quota probe (2026-11-23: the Claude probe read "available 80%" while
// every Claude review failed on its weekly limit).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  USAGE_LIMIT_FALLBACK_MS,
  resetTimeFrom,
  usageLimitFrom,
} from "../tools/review-orchestrator/lib/usage-limit.mjs";

const NOW = Date.parse("2026-11-23T10:30:00Z");

test("Claude's weekly limit message holds until the reset it names", () => {
  const limit = usageLimitFrom({ stdout: "You've hit your weekly limit · resets Nov 26, 1am (UTC)\n" }, NOW);
  assert.equal(new Date(limit.until).toISOString(), "2026-11-26T01:00:00.000Z");
  assert.match(limit.message, /^You've hit your weekly limit/);
});

test("a reset in a named time zone is converted to UTC", () => {
  // Brisbane is UTC+10 all year.
  assert.equal(new Date(resetTimeFrom("resets 3:30pm (Australia/Brisbane)", NOW)).toISOString(), "2026-11-24T05:30:00.000Z");
  assert.equal(new Date(resetTimeFrom("resets 9pm (Australia/Brisbane)", NOW)).toISOString(), "2026-11-23T11:00:00.000Z");
});

test("a date already past this year is next year's", () => {
  const late = Date.parse("2026-12-30T00:00:00Z");
  assert.equal(new Date(resetTimeFrom("resets Jan 2, 1am (UTC)", late)).toISOString(), "2027-01-02T01:00:00.000Z");
});

test("the older epoch form is read", () => {
  const limit = usageLimitFrom({ stdout: "Claude AI usage limit reached|1795660800" }, NOW);
  assert.equal(limit.until, 1795660800 * 1000);
});

test("a limit with no readable reset, or one too far off, holds for the fallback", () => {
  assert.equal(usageLimitFrom({ stderr: "Error: You have reached your usage limit." }, NOW).until, NOW + USAGE_LIMIT_FALLBACK_MS);
  assert.equal(usageLimitFrom({ stdout: "You've hit your weekly limit · resets Mar 3, 1am (UTC)" }, NOW).until,
    NOW + USAGE_LIMIT_FALLBACK_MS);
  assert.equal(usageLimitFrom({ stdout: "You've hit your limit · resets 1am (Not/AZone)" }, NOW).until, NOW + USAGE_LIMIT_FALLBACK_MS);
});

test("an ordinary failure is not a usage limit", () => {
  assert.equal(usageLimitFrom({ stdout: "", stderr: "Error: ENOENT spawn git" }, NOW), null);
  assert.equal(usageLimitFrom({ stdout: "API Error: 529 overloaded" }, NOW), null);
  // A review's text far up the output is not read.
  assert.equal(usageLimitFrom({ stdout: `The rate limiter: you've hit your limit check.${"x".repeat(5000)}` }, NOW), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  auditErrorDetailCostFields,
  chatAccessErrorArguments,
} from "../scripts/check-error-detail-cost-core.mjs";

const audit = (source) =>
  auditErrorDetailCostFields([{ path: "lib/example.ts", source }]).failures;

test("a prefixed cost field passes", () => {
  assert.deepEqual(
    audit(`
      throw new ChatAccessError(429, "X", "message", undefined, {
        scope: "day",
        internalUsedCostMicroUsd: used,
      });
    `),
    []
  );
});

test("an unprefixed cost field is reported with its name and file", () => {
  // The actual leak: CREDIT_COST_ALLOWANCE_INSUFFICIENT sent these to the
  // browser because the stripper matches on the key's spelling and nothing
  // checked the spelling.
  const failures = audit(`
    throw new ChatAccessError(402, "X", "message", undefined, {
      requiredCostMicroUsd: required,
      availableCostMicroUsd: available,
    });
  `);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /requiredCostMicroUsd/);
  assert.match(failures[0], /lib\/example\.ts/);
  assert.match(failures[1], /availableCostMicroUsd/);
});

test("an apostrophe in a comment does not run the scan past the call", () => {
  // The false positive this check produced on its first run. Without comment
  // handling the `'` in "caller's" was read as a string delimiter, the scan
  // continued past the closing paren, and a correctly prefixed details bag was
  // reported as a leak. A check that cries wolf is the one that gets silenced.
  const failures = audit(`
    throw new ChatAccessError(429, "X", "message", undefined, {
      // Carried for the caller's structured log only.
      internalUsedCostMicroUsd: used,
    });
    const unrelated = { estimatedCostMicroUsd: 1 };
  `);
  assert.deepEqual(failures, []);
});

test("a block comment is skipped the same way", () => {
  assert.deepEqual(
    audit(`
      throw new ChatAccessError(429, "X", "message", undefined, {
        /* what it isn't: a user's money */
        internalLimitCostMicroUsd: limit,
      });
      const unrelated = { totalCostMicroUsd: 2 };
    `),
    []
  );
});

test("cost fields outside a ChatAccessError are not this check's business", () => {
  // Structured events and admin payloads carry micro-USD on purpose.
  assert.deepEqual(
    audit(`
      recordDecision({ estimatedCostMicroUsd: cost, limitMicroUsd: limit });
      console.info(JSON.stringify({ usedMicroUsd: used }));
    `),
    []
  );
});

test("credits are not micro-USD and are left alone", () => {
  assert.deepEqual(
    audit(`
      throw new ChatAccessError(402, "X", "message", undefined, {
        requiredCredits: 12,
        availableCredits: 3,
        shortfallCredits: 9,
      });
    `),
    []
  );
});

test("every call is scanned, not just the first", () => {
  const failures = audit(`
    throw new ChatAccessError(1, "A", "m", undefined, { aCostMicroUsd: 1 });
    throw new ChatAccessError(2, "B", "m", undefined, { bCostMicroUsd: 2 });
  `);
  assert.equal(failures.length, 2);
});

test("the extractor reports the line each call starts on", () => {
  const calls = chatAccessErrorArguments(
    ["", "", "new ChatAccessError(1, 2, 3);"].join("\n")
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].line, 3);
});

test("a nested call inside the details bag does not end the scan early", () => {
  const failures = audit(`
    throw new ChatAccessError(429, "X", "m", retryAfterFor("day", now), {
      resetAt: safeDailyResetAt(windowEnd, now).toISOString(),
      leakedCostMicroUsd: cost,
    });
  `);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /leakedCostMicroUsd/);
});

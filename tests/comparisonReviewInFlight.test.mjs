import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPARISON_REVIEW_IN_FLIGHT_POLL_DELAYS_MS,
  COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS,
  isComparisonReviewAlreadyRunning,
  storedComparisonReviewPath,
  waitForStoredComparisonReview,
} from "../lib/comparisonReviewInFlight.ts";

/**
 * The client half of the account AI Review in-flight claim: what a dialog or
 * Studio session does after the server answers "this review is already
 * running". It must only ever read, must stop, and must not outlive the claim
 * it is waiting on. Time is injected, so nothing here sleeps.
 */

const clock = () => {
  let now = 0;
  const slept = [];
  return {
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    slept,
  };
};

test("the 409 the route sends for a run in flight is recognised, and nothing else is", () => {
  assert.equal(isComparisonReviewAlreadyRunning(409, { code: "DUPLICATE_REQUEST" }), true);
  assert.equal(isComparisonReviewAlreadyRunning(409, { code: "CONVERSATION_LOCKED" }), false);
  assert.equal(isComparisonReviewAlreadyRunning(429, { code: "DUPLICATE_REQUEST" }), false);
  assert.equal(isComparisonReviewAlreadyRunning(409, null), false);
  assert.equal(isComparisonReviewAlreadyRunning(409, "DUPLICATE_REQUEST"), false);
});

test("the lookup names the exact turn being waited on, not just the latest one", () => {
  const path = storedComparisonReviewPath("conversation-1", {
    reviewMode: "evidence",
    includeSynthesis: true,
    promptMessageId: "prompt-1",
    assistantMessageIds: ["answer-a", "answer-b"],
  });
  const url = new URL(path, "http://localhost");
  assert.equal(url.pathname, "/api/conversations/conversation-1/comparison-reviews");
  assert.equal(url.searchParams.get("reviewMode"), "evidence");
  assert.equal(url.searchParams.get("includeSynthesis"), "true");
  assert.equal(url.searchParams.get("promptMessageId"), "prompt-1");
  assert.equal(url.searchParams.get("assistantMessageIds"), "answer-a,answer-b");
});

test("waiting resolves with the saved review as soon as it appears", async () => {
  const time = clock();
  let lookups = 0;
  const review = await waitForStoredComparisonReview({
    lookup: async () => (++lookups === 3 ? { id: "review-1" } : undefined),
    now: time.now,
    sleep: time.sleep,
  });
  assert.deepEqual(review, { id: "review-1" });
  assert.equal(lookups, 3);
  assert.deepEqual(time.slept, COMPARISON_REVIEW_IN_FLIGHT_POLL_DELAYS_MS.slice(0, 3));
});

test("waiting gives up at the claim's TTL and stays inside the GET rate limit", async () => {
  const time = clock();
  let lookups = 0;
  const review = await waitForStoredComparisonReview({
    lookup: async () => {
      lookups += 1;
      return undefined;
    },
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(review, null);
  const waited = time.slept.reduce((sum, ms) => sum + ms, 0);
  assert.ok(waited <= COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS * 1000, "waited past the claim's own expiry");
  assert.ok(waited >= COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS * 1000 - 10_000, "gave up long before the claim could expire");
  // The GET allows 20 a minute and 300 a day per account.
  const perMinute = Math.max(...Array.from({ length: Math.ceil(waited / 60_000) }, (_, minute) => {
    let elapsed = 0;
    return time.slept.filter((ms) => {
      elapsed += ms;
      return elapsed > minute * 60_000 && elapsed <= (minute + 1) * 60_000;
    }).length;
  }));
  assert.ok(perMinute <= 10, `${perMinute} lookups in one minute`);
  assert.ok(lookups <= 100, `${lookups} lookups over one wait`);
});

test("an aborted wait stops without another lookup", async () => {
  const controller = new AbortController();
  let lookups = 0;
  const review = await waitForStoredComparisonReview({
    signal: controller.signal,
    lookup: async () => {
      lookups += 1;
      controller.abort();
      return undefined;
    },
    sleep: async () => {},
  });
  assert.equal(review, null);
  assert.equal(lookups, 1);
});

test("a lookup that throws ends the wait with its error", async () => {
  await assert.rejects(
    waitForStoredComparisonReview({
      lookup: async () => {
        throw new Error("conversation locked");
      },
      sleep: async () => {},
    }),
    /conversation locked/
  );
});

test("the default pause really waits and wakes on abort", async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 20);
  const review = await waitForStoredComparisonReview({
    signal: controller.signal,
    lookup: async () => ({ id: "never" }),
    delaysMs: [60_000],
  });
  assert.equal(review, null);
  assert.ok(Date.now() - started < 5_000, "the abort did not wake the pause");
});

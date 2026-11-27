import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_RATE_LIMIT,
  COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_SCOPE,
  COMPARISON_REVIEW_IN_FLIGHT_MAX_LOOKUPS,
  COMPARISON_REVIEW_IN_FLIGHT_POLL_DELAYS_MS,
  COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS,
  COMPARISON_REVIEW_TURN_NOT_FOUND,
  ComparisonReviewLookupError,
  isComparisonReviewAlreadyRunning,
  lookupStoredComparisonReview,
  storedComparisonReviewPath,
  waitForStoredComparisonReview,
} from "../lib/comparisonReviewInFlight.ts";

/**
 * The client half of the account AI Review in-flight claim: what a dialog or
 * Studio session does after the server answers "this review is already
 * running". It must only ever read, must stop, must not outlive the claim it
 * waits on, and must not spend more than a fixed number of lookups -- a rate
 * limit included. Time is injected, so nothing here sleeps.
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
const pending = async () => ({ status: "pending" });

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
  const wait = await waitForStoredComparisonReview({
    lookup: async () => (++lookups === 3 ? { status: "saved", review: { id: "review-1" } } : { status: "pending" }),
    now: time.now,
    sleep: time.sleep,
  });
  assert.deepEqual(wait, { outcome: "saved", review: { id: "review-1" } });
  assert.equal(lookups, 3);
  assert.deepEqual(time.slept, COMPARISON_REVIEW_IN_FLIGHT_POLL_DELAYS_MS.slice(0, 3));
});

test("a full wait stays within its fixed lookup budget and the claim's TTL", async () => {
  // The budget is a constant, not an accident of the schedule.
  assert.equal(COMPARISON_REVIEW_IN_FLIGHT_MAX_LOOKUPS, 18);
  const time = clock();
  let lookups = 0;
  const wait = await waitForStoredComparisonReview({
    lookup: async () => {
      lookups += 1;
      return { status: "pending" };
    },
    now: time.now,
    sleep: time.sleep,
  });
  assert.deepEqual(wait, { outcome: "expired" });
  assert.ok(lookups <= COMPARISON_REVIEW_IN_FLIGHT_MAX_LOOKUPS, `${lookups} lookups over one wait`);
  const waited = time.slept.reduce((sum, ms) => sum + ms, 0);
  assert.ok(waited <= COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS * 1000, "waited past the claim's own expiry");
  // Backed off: after the first five, at most one lookup a minute.
  const late = time.slept.slice(5);
  assert.ok(late.length > 0 && late.every((ms) => ms >= 60_000), `late delays ${late}`);
});

test("the lookup budget holds even when the deadline would allow more", async () => {
  const time = clock();
  let lookups = 0;
  const wait = await waitForStoredComparisonReview({
    lookup: async () => {
      lookups += 1;
      return { status: "pending" };
    },
    deadlineMs: 24 * 60 * 60 * 1000,
    now: time.now,
    sleep: time.sleep,
  });
  assert.deepEqual(wait, { outcome: "expired" });
  assert.equal(lookups, COMPARISON_REVIEW_IN_FLIGHT_MAX_LOOKUPS);
});

test("a rate limit backs the wait off instead of retrying sooner", async () => {
  const time = clock();
  let lookups = 0;
  const wait = await waitForStoredComparisonReview({
    lookup: async () => {
      lookups += 1;
      return lookups === 1 ? { status: "pending", retryAfterMs: 45_000 } : { status: "saved", review: { id: "r" } };
    },
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(wait.outcome, "saved");
  // The second pause honours Retry-After rather than the 5 s schedule.
  assert.deepEqual(time.slept, [COMPARISON_REVIEW_IN_FLIGHT_POLL_DELAYS_MS[0], 45_000]);
});

test("a Retry-After past the deadline ends the wait without another lookup", async () => {
  const time = clock();
  let lookups = 0;
  const wait = await waitForStoredComparisonReview({
    lookup: async () => {
      lookups += 1;
      // The day bucket is spent: Retry-After points at tomorrow.
      return { status: "pending", retryAfterMs: 10 * 60 * 60 * 1000 };
    },
    now: time.now,
    sleep: time.sleep,
  });
  assert.deepEqual(wait, { outcome: "expired" });
  assert.equal(lookups, 1);
});

test("rate limits on every lookup still cannot exceed the budget", async () => {
  const time = clock();
  let lookups = 0;
  await waitForStoredComparisonReview({
    lookup: async () => {
      lookups += 1;
      return { status: "pending", retryAfterMs: 1_000 };
    },
    deadlineMs: 24 * 60 * 60 * 1000,
    now: time.now,
    sleep: time.sleep,
  });
  assert.equal(lookups, COMPARISON_REVIEW_IN_FLIGHT_MAX_LOOKUPS);
});

test("a turn that is gone ends the wait at once and is never substituted", async () => {
  let lookups = 0;
  const wait = await waitForStoredComparisonReview({
    lookup: async () => {
      lookups += 1;
      return { status: "gone" };
    },
    sleep: async () => {},
  });
  assert.deepEqual(wait, { outcome: "gone" });
  assert.equal(lookups, 1);
});

test("an aborted wait stops without another lookup", async () => {
  const controller = new AbortController();
  let lookups = 0;
  const wait = await waitForStoredComparisonReview({
    signal: controller.signal,
    lookup: async () => {
      lookups += 1;
      controller.abort();
      return { status: "pending" };
    },
    sleep: async () => {},
  });
  assert.deepEqual(wait, { outcome: "aborted" });
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
  const wait = await waitForStoredComparisonReview({
    signal: controller.signal,
    lookup: pending,
    delaysMs: [60_000],
  });
  assert.deepEqual(wait, { outcome: "aborted" });
  assert.ok(Date.now() - started < 5_000, "the abort did not wake the pause");
});

/** A fetch stand-in that records the response it handed out. */
const respond = (body, init = {}) => {
  const handed = [];
  const fetchImpl = async () => {
    const response = new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    handed.push(response);
    return response;
  };
  return { fetchImpl, handed };
};

test("one lookup classifies every answer the GET can give, reading every body", async () => {
  const cases = [
    [{ available: true, storedReview: { id: "r1" } }, {}, { status: "saved", review: { id: "r1" } }],
    [{ available: true, storedReview: null }, {}, { status: "pending" }],
    [{ code: COMPARISON_REVIEW_TURN_NOT_FOUND }, { status: 404 }, { status: "gone" }],
    [{ code: "API_RATE_LIMITED" }, { status: 429, headers: { "Retry-After": "30" } }, { status: "pending", retryAfterMs: 30_000 }],
    [{ code: "API_RATE_LIMITED" }, { status: 429 }, { status: "pending", retryAfterMs: undefined }],
    [{ code: "COMPARISON_REVIEW_PREVIEW_FAILED" }, { status: 503 }, { status: "pending" }],
  ];
  for (const [body, init, expected] of cases) {
    const { fetchImpl, handed } = respond(body, init);
    assert.deepEqual(await lookupStoredComparisonReview("/x", { fetchImpl }), expected);
    assert.equal(handed[0].bodyUsed, true, `the ${init.status ?? 200} body was left unread`);
  }
});

test("a refusal that will not change stops the wait with its code", async () => {
  for (const [code, status] of [["NOT_FOUND", 404], ["CONVERSATION_LOCKED", 423], ["INVALID_COMPARISON_REVIEW_LOOKUP", 400]]) {
    const { fetchImpl, handed } = respond({ code }, { status });
    await assert.rejects(
      lookupStoredComparisonReview("/x", { fetchImpl }),
      (error) => error instanceof ComparisonReviewLookupError && error.code === code && error.status === status
    );
    assert.equal(handed[0].bodyUsed, true);
  }
});

test("a lookup that never got an answer is pending, not a failure", async () => {
  const lookup = await lookupStoredComparisonReview("/x", {
    fetchImpl: async () => {
      throw new TypeError("network down");
    },
  });
  assert.deepEqual(lookup, { status: "pending" });
});

test("exact-turn lookups have their own rate-limit bucket, sized for the budget", () => {
  assert.notEqual(COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_SCOPE, "comparison-review-preview");
  const { minute, day } = COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_RATE_LIMIT;
  // The busiest minute of one wait, doubled for Studio and Classic waiting
  // on the same run at once.
  let elapsed = 0;
  let firstMinute = 0;
  for (let attempt = 0; attempt < COMPARISON_REVIEW_IN_FLIGHT_MAX_LOOKUPS; attempt += 1) {
    elapsed += COMPARISON_REVIEW_IN_FLIGHT_POLL_DELAYS_MS[Math.min(attempt, COMPARISON_REVIEW_IN_FLIGHT_POLL_DELAYS_MS.length - 1)];
    if (elapsed <= 60_000) firstMinute += 1;
  }
  assert.ok(minute >= firstMinute * 2, `minute limit ${minute} < ${firstMinute * 2}`);
  assert.ok(day >= COMPARISON_REVIEW_IN_FLIGHT_MAX_LOOKUPS * 5, `day limit ${day} allows fewer than five full waits`);
});

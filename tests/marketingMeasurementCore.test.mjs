// The marketing measurement both reports read (owner request 2026-11-03):
// the week's window, what is counted in it, and what is held.

import assert from "node:assert/strict";
import test from "node:test";

import {
  marketingPercentile,
  marketingWeekWindow,
  summarizeMarketingMeasurement,
} from "@/lib/marketingMeasurementCore";

test("a week is a Brisbane Monday to the next, and nothing else is a week", () => {
  const window = marketingWeekWindow("2026-11-02");
  assert.equal(window.start.toISOString(), "2026-11-01T14:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-11-08T14:00:00.000Z");
  assert.equal(marketingWeekWindow("2026-11-03"), null);
  assert.equal(marketingWeekWindow("not-a-date"), null);
});

test("percentiles are nearest-rank", () => {
  assert.equal(marketingPercentile([], 0.5), null);
  assert.equal(marketingPercentile([10], 0.95), 10);
  assert.equal(marketingPercentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(marketingPercentile([1, 2, 3, 4], 0.95), 4);
});

const at = (iso) => new Date(iso);
const WINDOW = marketingWeekWindow("2026-11-02");

const post = (overrides = {}) => ({
  accountSlug: "instagram-3",
  status: "pending_approval",
  createdAt: at("2026-11-03T00:00:00Z"),
  updatedAt: at("2026-11-03T00:00:00Z"),
  approvedAt: null,
  scheduledAt: null,
  publishedAt: null,
  verifiedPublicAt: null,
  outcomeUnknownAt: null,
  approvalExpiresAt: null,
  errorCode: null,
  guardCodes: ["new_copy"],
  attempts: [],
  ...overrides,
});

const CHANNELS = [
  { accountSlug: "instagram-3", channel: "instagram", status: "approval_mode", pauseReasonCode: null },
  { accountSlug: "facebook-3", channel: "facebook", status: "paused", pauseReasonCode: "outcome_unknown" },
];

test("the week's posts, dispatch and queue are counted, and a small sample is held", () => {
  const measurement = summarizeMarketingMeasurement({
    window: WINDOW,
    posts: [
      post(),
      post({ guardCodes: ["new_copy", "competitor_named"] }),
      post({
        status: "approved",
        approvedAt: at("2026-11-03T01:00:00Z"),
        approvalExpiresAt: at("2026-11-30T00:00:00Z"),
      }),
      post({
        status: "verified",
        approvedAt: at("2026-11-03T01:00:00Z"),
        scheduledAt: at("2026-11-04T00:00:00Z"),
        publishedAt: at("2026-11-04T00:10:00Z"),
        verifiedPublicAt: at("2026-11-04T01:00:00Z"),
        attempts: [{ at: at("2026-11-04T00:10:00Z"), attempt: 1, outcome: "published", errorCode: null }],
      }),
      post({
        accountSlug: "facebook-3",
        status: "failed",
        updatedAt: at("2026-11-05T00:00:00Z"),
        errorCode: "rate_limited",
        attempts: [{ at: at("2026-11-05T00:00:00Z"), attempt: 1, outcome: "failed", errorCode: "rate_limited" }],
      }),
      post({ status: "rejected", updatedAt: at("2026-11-04T00:00:00Z") }),
      // Before the week: counted only as the queue it is still in.
      post({ createdAt: at("2026-10-20T00:00:00Z"), updatedAt: at("2026-10-20T00:00:00Z") }),
    ],
    channels: CHANNELS,
    touches: 4,
    signups: { total: 3, attributed: 1 },
    guestLeads: null,
    llm: { calls: 10, countedMicroUsd: 1_500_000, capUsd: 100 },
  });

  assert.equal(measurement.drafts.created, 6);
  assert.deepEqual(measurement.drafts.guardCodes[0], { code: "new_copy", count: 6 });
  assert.deepEqual(measurement.decisions, { approved: 2, rejected: 1, expired: 0 });
  assert.equal(measurement.dispatch.sent, 2);
  assert.equal(measurement.dispatch.published, 1);
  assert.equal(measurement.dispatch.verified, 1);
  assert.equal(measurement.dispatch.failed, 1);
  assert.equal(measurement.dispatch.successRate, null);
  assert.equal(measurement.dispatch.latencyP50Ms, 10 * 60 * 1000);
  assert.deepEqual(measurement.dispatch.failuresByCode, [{ code: "rate_limited", count: 1 }]);
  assert.equal(measurement.queue.pendingApproval, 3);
  assert.equal(measurement.queue.oldestPendingAt, "2026-10-20T00:00:00.000Z");
  assert.equal(measurement.queue.approvedWaiting, 1);
  assert.equal(measurement.queue.nextApprovalExpiryAt, "2026-11-30T00:00:00.000Z");
  assert.deepEqual(
    measurement.accounts.map((row) => [row.accountSlug, row.published, row.failed, row.pendingApproval, row.pauseReasonCode]),
    [
      ["instagram-3", 1, 0, 3, null],
      ["facebook-3", 0, 1, 0, "outcome_unknown"],
    ],
  );
  assert.deepEqual([...measurement.held].sort(), ["signups", "success_rate"]);
});

test("enough sends give a rate, and an unreadable count stays null rather than zero", () => {
  const sent = Array.from({ length: 5 }, (_, index) =>
    post({
      status: index < 4 ? "verified" : "published",
      publishedAt: at("2026-11-04T00:00:00Z"),
      approvedAt: at("2026-11-03T23:00:00Z"),
      verifiedPublicAt: index < 4 ? at("2026-11-04T01:00:00Z") : null,
      attempts: [{ at: at("2026-11-04T00:00:00Z"), attempt: 1, outcome: "published", errorCode: null }],
    }),
  );
  const measurement = summarizeMarketingMeasurement({
    window: WINDOW,
    posts: sent,
    channels: [],
    touches: null,
    signups: null,
    guestLeads: null,
    llm: null,
  });
  assert.equal(measurement.dispatch.successRate, 0.8);
  assert.equal(measurement.touches, null);
  assert.ok(measurement.held.includes("signups"));
  assert.ok(!measurement.held.includes("success_rate"));
});

test("sends are attempts: a failure requeued and then published is two sends, and one in flight is a third", () => {
  const measurement = summarizeMarketingMeasurement({
    window: WINDOW,
    posts: [
      // Failed, requeued by a person, published: the status now says only "verified".
      post({
        status: "verified",
        approvedAt: at("2026-11-03T00:00:00Z"),
        scheduledAt: at("2026-11-05T00:00:00Z"),
        publishedAt: at("2026-11-05T00:05:00Z"),
        verifiedPublicAt: at("2026-11-05T01:00:00Z"),
        attempts: [
          { at: at("2026-11-04T00:00:00Z"), attempt: 1, outcome: "failed", errorCode: "media_rejected" },
          { at: at("2026-11-05T00:05:00Z"), attempt: 2, outcome: "published", errorCode: null },
        ],
      }),
      // An unknown outcome later resolved as failed is one send, failed.
      post({
        status: "failed",
        updatedAt: at("2026-11-06T00:00:00Z"),
        attempts: [
          { at: at("2026-11-04T02:00:00Z"), attempt: 1, outcome: "outcome_unknown", errorCode: "timeout" },
          { at: at("2026-11-06T00:00:00Z"), attempt: 1, outcome: "failed", errorCode: "not_on_platform" },
        ],
      }),
      post({ status: "publishing", updatedAt: at("2026-11-07T00:00:00Z") }),
      // An attempt before the week is not this week's send.
      post({
        status: "published",
        attempts: [{ at: at("2026-10-30T00:00:00Z"), attempt: 1, outcome: "published", errorCode: null }],
      }),
    ],
    channels: CHANNELS,
    touches: 0,
    signups: null,
    guestLeads: null,
    llm: null,
  });
  assert.equal(measurement.dispatch.sent, 4);
  assert.equal(measurement.dispatch.published, 1);
  assert.equal(measurement.dispatch.failed, 2);
  assert.equal(measurement.dispatch.outcomeUnknown, 0);
  assert.equal(measurement.dispatch.verified, 1);
  assert.deepEqual(
    measurement.dispatch.failuresByCode.map((entry) => entry.code).sort(),
    ["media_rejected", "not_on_platform"],
  );
  // Measured from the requeued schedule to the attempt that published.
  assert.equal(measurement.dispatch.latencyP50Ms, 5 * 60 * 1000);
  assert.equal(measurement.accounts[0].published, 1);
  assert.equal(measurement.accounts[0].failed, 2);
});

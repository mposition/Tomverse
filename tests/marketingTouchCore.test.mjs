import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_TOUCH_EVIDENCE,
  MARKETING_TOUCH_SERVER_PROPERTY_KEYS,
  MARKETING_TOUCH_LATE_ARRIVAL_MS,
  MARKETING_TOUCH_WINDOW_MS,
  isWithinMarketingTouchWindow,
  lateMarketingTouchRepair,
  marketingTouchSnapshot,
  marketingTouchWindow,
  shouldSnapshotMarketingTouch,
  stripServerOnlyTouchProperties,
  summarizeMarketingTouchAttribution,
} from "../lib/marketingTouchCore.ts";
import {
  PRODUCT_ANALYTICS_EVENT_NAMES,
  analyticsPropertiesSchema,
  shouldSendCustomProductEventToGa4,
} from "../lib/productAnalyticsShared.ts";

const receivedAt = new Date("2026-11-01T00:00:00.000Z");
const touch = (occurredAt, overrides = {}) => ({
  utmSource: "linkedin",
  utmMedium: "social",
  utmCampaign: "launch",
  utmContent: "linkedin-1",
  occurredAt,
  ...overrides,
});

test("marketing_touch is a registered event and stays out of GA4 custom events", () => {
  assert.ok(PRODUCT_ANALYTICS_EVENT_NAMES.includes("marketing_touch"));
  assert.equal(shouldSendCustomProductEventToGa4("marketing_touch"), false);
  assert.equal(shouldSendCustomProductEventToGa4("landing_view"), true);
});

test("the evidence value is closed and says client-observed, server-timed", () => {
  assert.equal(MARKETING_TOUCH_EVIDENCE, "client_observed_server_time");
  assert.equal(
    analyticsPropertiesSchema.safeParse({ touch_evidence: "server_verified" }).success,
    false,
  );
  assert.equal(
    analyticsPropertiesSchema.safeParse({ utm_content: "linkedin-1" }).success,
    true,
  );
});

test("every server-only key is stripped from a client payload", () => {
  const forged = {
    utm_content: "linkedin-1",
    touch_evidence: "client_observed_server_time",
    touch_attribution: "attributed",
    touch_utm_source: "forged",
    touch_utm_medium: "forged",
    touch_utm_campaign: "forged",
    touch_utm_content: "forged",
    touch_received_at: receivedAt.toISOString(),
  };
  assert.deepEqual(stripServerOnlyTouchProperties(forged), { utm_content: "linkedin-1" });
  for (const key of MARKETING_TOUCH_SERVER_PROPERTY_KEYS) {
    assert.ok(key in forged, `${key} is covered by the forged payload above`);
  }
});

test("only a sign-up and a guest's first answer are snapshotted", () => {
  assert.equal(shouldSnapshotMarketingTouch("signup_completed", "user-1"), true);
  assert.equal(shouldSnapshotMarketingTouch("first_response_completed", null), true);
  assert.equal(shouldSnapshotMarketingTouch("first_response_completed", "user-1"), false);
  assert.equal(shouldSnapshotMarketingTouch("landing_view", null), false);
  assert.equal(shouldSnapshotMarketingTouch("marketing_touch", null), false);
});

test("the seven-day window is inclusive at both ends and nothing outside it attributes", () => {
  const window = marketingTouchWindow(receivedAt);
  assert.equal(window.lte.getTime(), receivedAt.getTime());
  assert.equal(receivedAt.getTime() - window.gte.getTime(), MARKETING_TOUCH_WINDOW_MS);
  assert.equal(MARKETING_TOUCH_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);

  const exactlySevenDays = new Date(receivedAt.getTime() - MARKETING_TOUCH_WINDOW_MS);
  const justOutside = new Date(exactlySevenDays.getTime() - 1);
  const afterReceipt = new Date(receivedAt.getTime() + 1);
  assert.equal(isWithinMarketingTouchWindow(exactlySevenDays, receivedAt), true);
  assert.equal(isWithinMarketingTouchWindow(receivedAt, receivedAt), true);
  assert.equal(isWithinMarketingTouchWindow(justOutside, receivedAt), false);
  assert.equal(isWithinMarketingTouchWindow(afterReceipt, receivedAt), false);

  assert.equal(
    marketingTouchSnapshot(touch(exactlySevenDays), receivedAt).touch_attribution,
    "attributed",
  );
  assert.deepEqual(marketingTouchSnapshot(touch(justOutside), receivedAt), {
    touch_attribution: "unattributed",
  });
  assert.deepEqual(marketingTouchSnapshot(touch(afterReceipt), receivedAt), {
    touch_attribution: "unattributed",
  });
});

test("an attributed snapshot copies the touch and parses against the stored schema", () => {
  const at = new Date(receivedAt.getTime() - 60_000);
  const snapshot = marketingTouchSnapshot(touch(at), receivedAt);
  assert.deepEqual(snapshot, {
    touch_attribution: "attributed",
    touch_evidence: "client_observed_server_time",
    touch_utm_source: "linkedin",
    touch_utm_medium: "social",
    touch_utm_campaign: "launch",
    touch_utm_content: "linkedin-1",
    touch_received_at: at.toISOString(),
  });
  assert.equal(analyticsPropertiesSchema.safeParse(snapshot).success, true);
  assert.equal(
    "touch_utm_content" in marketingTouchSnapshot(touch(at, { utmContent: null }), receivedAt),
    false,
  );
});

test("no touch is unattributed; no event is unobserved; the two are reported apart", () => {
  const attributed = {
    properties: marketingTouchSnapshot(touch(new Date(receivedAt.getTime() - 1)), receivedAt),
  };
  const unattributed = { properties: marketingTouchSnapshot(null, receivedAt) };
  const beforeTouchesExisted = { properties: { method: "google" } };
  const summary = summarizeMarketingTouchAttribution({
    conversions: [attributed, unattributed, beforeTouchesExisted],
    unobserved: 4,
  });
  assert.equal(summary.evidence, "client_observed_server_time");
  assert.equal(summary.attributed, 1);
  assert.equal(summary.unattributed, 2);
  assert.equal(summary.unobserved, 4);
  assert.deepEqual(summary.channels, [
    {
      source: "linkedin",
      medium: "social",
      campaign: "launch",
      content: "linkedin-1",
      count: 1,
      held: true,
    },
  ]);

  const guests = summarizeMarketingTouchAttribution({ conversions: [], unobserved: null });
  assert.equal(guests.unobserved, null, "a guest lead with no event leaves nothing to count");
});

test("a link with ten attributed sign-ups is no longer held", () => {
  const at = new Date(receivedAt.getTime() - 1);
  const conversions = Array.from({ length: 10 }, () => ({
    properties: marketingTouchSnapshot(touch(at), receivedAt),
  }));
  const [channel] = summarizeMarketingTouchAttribution({ conversions, unobserved: 0 }).channels;
  assert.equal(channel.count, 10);
  assert.equal(channel.held, false);
});

// The server-side ordering repair: a touch the browser observed first but the
// server stored just after the conversion finishes the conversion's snapshot.
const conversionAt = new Date("2026-11-01T00:00:00.000Z");
const conversion = (overrides = {}) => ({
  eventName: "signup_completed",
  userId: "user-1",
  occurredAt: new Date(conversionAt.getTime() - 50),
  createdAt: conversionAt,
  properties: { method: "google", touch_attribution: "unattributed" },
  ...overrides,
});
const lateTouch = (afterMs, overrides = {}) =>
  touch(new Date(conversionAt.getTime() + afterMs), overrides);
const observedBefore = new Date(conversionAt.getTime() - 100);

test("a touch stored just after an unattributed conversion it preceded attributes it", () => {
  const repaired = lateMarketingTouchRepair({
    conversion: conversion(),
    touch: lateTouch(200),
    touchObservedAt: observedBefore,
  });
  assert.equal(repaired.touch_attribution, "attributed");
  assert.equal(repaired.touch_utm_campaign, "launch");
  assert.equal(repaired.method, "google", "the conversion's own properties survive");
  assert.equal(
    repaired.touch_received_at,
    new Date(conversionAt.getTime() + 200).toISOString(),
    "the repaired snapshot still says when the server received the touch",
  );
  assert.equal(analyticsPropertiesSchema.safeParse(repaired).success, true);
});

test("an older attributed touch is replaced by the newer one, never the other way", () => {
  const older = marketingTouchSnapshot(
    touch(new Date(conversionAt.getTime() - 60_000), { utmCampaign: "older" }),
    conversionAt,
  );
  const repaired = lateMarketingTouchRepair({
    conversion: conversion({ properties: { method: "google", ...older } }),
    touch: lateTouch(200),
    touchObservedAt: observedBefore,
  });
  assert.equal(repaired.touch_utm_campaign, "launch");

  const newer = marketingTouchSnapshot(
    touch(new Date(conversionAt.getTime() + 500), { utmCampaign: "newer" }),
    new Date(conversionAt.getTime() + 500),
  );
  assert.equal(
    lateMarketingTouchRepair({
      conversion: conversion({ properties: { ...newer } }),
      touch: lateTouch(200),
      touchObservedAt: observedBefore,
    }),
    null,
  );
});

test("no repair outside thirty seconds, for a touch observed after the conversion, or for a non-lead", () => {
  const cases = [
    ["too late", { touch: lateTouch(MARKETING_TOUCH_LATE_ARRIVAL_MS + 1) }],
    ["too early", { touch: lateTouch(-MARKETING_TOUCH_LATE_ARRIVAL_MS - 1) }],
    [
      "observed after the conversion",
      { touchObservedAt: new Date(conversionAt.getTime() + 10) },
    ],
    [
      "a signed-in first answer is not a lead",
      { conversion: conversion({ eventName: "first_response_completed" }) },
    ],
    [
      "a conversion with no snapshot at all",
      { conversion: conversion({ properties: { method: "google" } }) },
    ],
  ];
  for (const [label, override] of cases) {
    assert.equal(
      lateMarketingTouchRepair({
        conversion: conversion(),
        touch: lateTouch(200),
        touchObservedAt: observedBefore,
        ...override,
      }),
      null,
      label,
    );
  }
  assert.notEqual(
    lateMarketingTouchRepair({
      conversion: conversion({ eventName: "first_response_completed", userId: null }),
      touch: lateTouch(-200),
      touchObservedAt: observedBefore,
    }),
    null,
    "a guest's first answer, and a touch stored a moment before the conversion looked",
  );
});

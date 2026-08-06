import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatLimitDecisionRecord,
  futureResetAt,
  safeDailyResetAt,
  withFutureResetAt,
} from "../lib/chatLimitDecisionCore.ts";
import { getZonedDayWindow } from "../lib/userTimeZone.ts";

const baseInput = (overrides = {}) => ({
  traceId: "9f0f2f9c-9a1a-4a2f-8f2e-7b6c5d4e3f21",
  subjectKey: "user:5f3c9a2b",
  userId: "user_123",
  plan: "Pro",
  phase: "comparison_preflight",
  decision: "rejected",
  errorCode: "OPERATIONAL_COST_GUARDRAIL_TRIGGERED",
  limitLayer: "operational_guardrail",
  limitScope: "user_plan_cost_day",
  models: [
    {
      modelId: "gpt-5-5-thinking",
      provider: "openai",
      estimatedInputTokens: 3_469,
      estimatedOutputTokens: 6_144,
      estimatedCostMicroUsd: 201_665,
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 30,
      pricingVersion: "openai-gpt-5.5-2026-08-01",
      costSource: "registry",
      longContextThresholdTokens: null,
    },
    {
      modelId: "gemini-3-1-pro",
      provider: "google",
      estimatedInputTokens: 3_469,
      estimatedOutputTokens: 4_096,
      estimatedCostMicroUsd: 56_090,
      inputUsdPerMillionTokens: 2,
      outputUsdPerMillionTokens: 12,
      pricingVersion: "google-gemini-3.1-pro-preview-2026-08-01",
      costSource: "registry",
      longContextThresholdTokens: null,
    },
  ],
  enabledTools: ["web_search"],
  requiredCredits: 56,
  availableCredits: 2_932,
  usedAllowanceMicroUsd: 1_370_000,
  requiredAllowanceMicroUsd: 420_000,
  limitMicroUsd: 1_500_000,
  timeZone: "Australia/Brisbane",
  createdAt: new Date("2026-08-01T04:00:00.000Z"),
  ...overrides,
});

test("a rejection record carries every field needed to reconstruct the decision", () => {
  const record = buildChatLimitDecisionRecord(
    baseInput({ resetAt: "2026-08-01T14:00:00.000Z" })
  );

  assert.equal(record.traceId, "9f0f2f9c-9a1a-4a2f-8f2e-7b6c5d4e3f21");
  assert.equal(record.subjectKey, "user:5f3c9a2b");
  assert.equal(record.plan, "Pro");
  assert.equal(record.decision, "rejected");
  assert.equal(record.errorCode, "OPERATIONAL_COST_GUARDRAIL_TRIGGERED");
  assert.equal(record.limitLayer, "operational_guardrail");
  assert.equal(record.limitScope, "user_plan_cost_day");
  assert.deepEqual(record.modelIds, ["gpt-5-5-thinking", "gemini-3-1-pro"]);
  assert.deepEqual(record.enabledTools, ["web_search"]);
  assert.equal(record.estimatedInputTokens, 3_469 * 2);
  assert.equal(record.estimatedOutputTokens, 6_144 + 4_096);
  assert.equal(record.estimatedCostMicroUsd, 201_665 + 56_090);
  assert.deepEqual(record.pricingVersions, [
    "openai-gpt-5.5-2026-08-01",
    "google-gemini-3.1-pro-preview-2026-08-01",
  ]);
  assert.equal(record.usedAllowanceMicroUsd, 1_370_000);
  assert.equal(record.requiredAllowanceMicroUsd, 420_000);
  assert.equal(record.limitMicroUsd, 1_500_000);
  assert.equal(record.requiredCredits, 56);
  assert.equal(record.availableCredits, 2_932);
  assert.equal(record.timeZone, "Australia/Brisbane");
  assert.equal(record.resetAt.toISOString(), "2026-08-01T14:00:00.000Z");
  assert.equal(record.createdAt.toISOString(), "2026-08-01T04:00:00.000Z");
});

test("a record never carries prompt text or message content", () => {
  const record = buildChatLimitDecisionRecord(
    baseInput({ resetAt: "2026-08-01T14:00:00.000Z" })
  );
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("prompt"), false);
  assert.equal(serialized.includes("content"), false);
  assert.equal(serialized.includes("message"), false);
  // The subject is the already-hashed usage key, exactly as the rate limiter
  // stores it.
  assert.match(record.subjectKey, /^(user|guest):/);
});

test("a reset instant that has already passed is dropped, never displayed", () => {
  const record = buildChatLimitDecisionRecord(
    baseInput({ resetAt: "2026-07-31T14:00:00.000Z" })
  );
  assert.equal(record.resetAt, null);
});

test("futureResetAt only accepts instants strictly ahead of now", () => {
  const now = new Date("2026-08-01T04:00:00.000Z");
  assert.equal(futureResetAt("2026-08-01T04:00:00.000Z", now), null);
  assert.equal(futureResetAt("2026-08-01T03:59:59.999Z", now), null);
  assert.equal(
    futureResetAt("2026-08-01T04:00:00.001Z", now).toISOString(),
    "2026-08-01T04:00:00.001Z"
  );
  assert.equal(futureResetAt(null, now), null);
  assert.equal(futureResetAt("not a date", now), null);
});

test("a details bag keeps a reset instant that is still ahead of now", () => {
  const now = new Date("2026-08-01T04:00:00.000Z");
  const details = {
    requiredCredits: 12,
    resetAt: "2026-08-02T00:00:00.000Z",
    timeZone: "Asia/Seoul",
  };
  const guarded = withFutureResetAt(details, now);
  assert.equal(guarded.resetAt, "2026-08-02T00:00:00.000Z");
  assert.equal(guarded.requiredCredits, 12);
  assert.equal(guarded.timeZone, "Asia/Seoul");
});

test("a details bag drops a reset instant that has already passed", () => {
  const now = new Date("2026-08-01T04:00:00.000Z");
  for (const stale of [
    // Strictly past, exactly now, and the millisecond before now: the record
    // side treats all three as unusable, so the response side has to as well.
    "2026-07-31T14:00:00.000Z",
    "2026-08-01T04:00:00.000Z",
    "2026-08-01T03:59:59.999Z",
    new Date("2026-08-01T03:00:00.000Z"),
    // Neither an instant nor absent. A details bag is typed loosely enough to
    // carry these, and "unparseable" is not a reason to show it.
    "not a date",
    null,
    42,
    ["2026-08-02T00:00:00.000Z"],
  ]) {
    const guarded = withFutureResetAt(
      { requiredCredits: 12, resetAt: stale },
      now
    );
    assert.equal(
      "resetAt" in guarded,
      false,
      `${String(stale)} survived the guard`
    );
    // Dropping the instant must not take the rest of the rejection with it.
    assert.equal(guarded.requiredCredits, 12);
  }
});

test("a stale daily boundary is rolled forward whole days, not clamped", () => {
  const windowEnd = new Date("2026-08-01T15:00:00.000Z");
  // A minute past the boundary, three days past it, and exactly on it.
  const cases = [
    ["2026-08-01T15:01:00.000Z", "2026-08-02T15:00:00.000Z"],
    ["2026-08-04T09:00:00.000Z", "2026-08-04T15:00:00.000Z"],
    ["2026-08-01T15:00:00.000Z", "2026-08-02T15:00:00.000Z"],
    // Already ahead: returned unchanged rather than pushed out a day.
    ["2026-08-01T14:59:59.999Z", "2026-08-01T15:00:00.000Z"],
  ];
  for (const [instant, expected] of cases) {
    const now = new Date(instant);
    const rolled = safeDailyResetAt(windowEnd, now);
    assert.equal(rolled.toISOString(), expected, `from ${instant}`);
    assert.ok(rolled.getTime() > now.getTime());
    // And what it produces survives the guard on the way out, which is the
    // point: the record and the response carry the same instant.
    assert.equal(
      withFutureResetAt({ resetAt: rolled.toISOString() }, now).resetAt,
      expected
    );
  }
});

test("a details bag with no reset instant is passed through untouched", () => {
  const now = new Date("2026-08-01T04:00:00.000Z");
  const details = { requiredCredits: 12, shortfallCredits: 3 };
  assert.equal(withFutureResetAt(details, now), details);
});

test("day-window ends are in the future for Brisbane, a DST zone and UTC", () => {
  const instants = [
    // Just before and just after local midnight in each zone.
    "2026-08-01T13:59:59.000Z",
    "2026-08-01T14:00:01.000Z",
    "2026-01-01T00:00:00.000Z",
    "2026-06-15T12:00:00.000Z",
    // Australian DST transition weekend (Brisbane does not observe it,
    // Sydney does), and the northern-hemisphere spring-forward.
    "2026-10-04T15:30:00.000Z",
    "2026-03-08T07:30:00.000Z",
    "2026-11-01T06:30:00.000Z",
  ];
  const zones = [
    "Australia/Brisbane",
    "Australia/Sydney",
    "America/New_York",
    "Europe/Berlin",
    "Asia/Seoul",
    "UTC",
  ];
  for (const instant of instants) {
    const now = new Date(instant);
    for (const zone of zones) {
      const window = getZonedDayWindow(zone, now);
      assert.ok(
        window.end.getTime() > now.getTime(),
        `${zone} at ${instant} produced a non-future reset`
      );
      assert.ok(
        window.start.getTime() <= now.getTime(),
        `${zone} at ${instant} produced a future day start`
      );
      const record = buildChatLimitDecisionRecord(
        baseInput({ resetAt: window.end, createdAt: now, timeZone: zone })
      );
      assert.ok(record.resetAt, `${zone} at ${instant} dropped its reset`);
      assert.ok(record.resetAt.getTime() > now.getTime());
    }
  }
});

test("oversized or malformed input is bounded rather than stored raw", () => {
  const record = buildChatLimitDecisionRecord(
    baseInput({
      traceId: "x".repeat(500),
      enabledTools: ["web_search", "web_search", "", "y".repeat(200)],
      models: Array.from({ length: 20 }, (_, index) => ({
        modelId: `model-${index}`,
        provider: "openai",
        estimatedInputTokens: -5,
        estimatedOutputTokens: Number.NaN,
        estimatedCostMicroUsd: 10,
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 2,
        pricingVersion: "v1",
        costSource: "registry",
        longContextThresholdTokens: null,
      })),
    })
  );
  assert.equal(record.traceId.length, 120);
  assert.equal(record.models.length, 8);
  assert.equal(record.estimatedInputTokens, 0);
  assert.equal(record.estimatedOutputTokens, 0);
  assert.deepEqual(record.enabledTools, ["web_search", "y".repeat(60)]);
  assert.deepEqual(record.pricingVersions, ["v1"]);
});

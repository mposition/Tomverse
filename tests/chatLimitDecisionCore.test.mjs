import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatLimitDecisionRecord,
  futureResetAt,
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

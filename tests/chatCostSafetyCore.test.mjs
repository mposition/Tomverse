import assert from "node:assert/strict";
import test from "node:test";
import {
  formatChatCostSafetyDetails,
  isChatCostSafetyCode,
} from "../lib/chatCostSafetyCore.ts";

test("cost safety codes are identified without accepting adjacent errors", () => {
  assert.equal(isChatCostSafetyCode("INTERNAL_DAILY_COST_SAFETY_LIMIT"), true);
  assert.equal(isChatCostSafetyCode("CHAT_TOKEN_QUOTA_EXCEEDED"), false);
});

test("cost safety details expose the estimate, remainder, and local reset", () => {
  const text = formatChatCostSafetyDetails({
    requiredCostMicroUsd: 491_520,
    availableCostMicroUsd: 300_000,
    resetAt: "2026-07-19T14:00:00.000Z",
    timeZone: "Australia/Brisbane",
  });

  assert.match(text, /US\$0\.4915/);
  assert.match(text, /US\$0\.3000/);
  assert.match(text, /Australia\/Brisbane/);
});

test("invalid diagnostic details are not rendered", () => {
  assert.equal(formatChatCostSafetyDetails({ requiredCostMicroUsd: "secret" }), "");
});

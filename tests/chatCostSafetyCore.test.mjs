import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyChatLimitCode,
  CONCURRENT_RESERVATION_CONFLICT,
  CREDIT_BALANCE_INSUFFICIENT,
  formatChatCostSafetyDetails,
  isChatCostSafetyCode,
  isChatEntitlementCode,
  OPERATIONAL_COST_GUARDRAIL_TRIGGERED,
  PLAN_ENTITLEMENT_EXHAUSTED,
  PROVIDER_BUDGET_EXHAUSTED,
} from "../lib/chatCostSafetyCore.ts";

test("cost safety codes are identified without accepting adjacent errors", () => {
  assert.equal(isChatCostSafetyCode(OPERATIONAL_COST_GUARDRAIL_TRIGGERED), true);
  assert.equal(isChatCostSafetyCode("INTERNAL_DAILY_COST_SAFETY_LIMIT"), true);
  assert.equal(isChatCostSafetyCode("CHAT_TOKEN_QUOTA_EXCEEDED"), false);
});

test("entitlement and operational guardrail codes are separate layers", () => {
  assert.equal(classifyChatLimitCode(CREDIT_BALANCE_INSUFFICIENT), "entitlement");
  assert.equal(classifyChatLimitCode(PLAN_ENTITLEMENT_EXHAUSTED), "entitlement");
  assert.equal(
    classifyChatLimitCode(OPERATIONAL_COST_GUARDRAIL_TRIGGERED),
    "operational_guardrail"
  );
  assert.equal(
    classifyChatLimitCode(PROVIDER_BUDGET_EXHAUSTED),
    "operational_guardrail"
  );
  // A reservation race is neither: the caller simply retries.
  assert.equal(classifyChatLimitCode(CONCURRENT_RESERVATION_CONFLICT), "other");
  assert.equal(classifyChatLimitCode("SOMETHING_ELSE"), "other");

  assert.equal(isChatEntitlementCode(PLAN_ENTITLEMENT_EXHAUSTED), true);
  assert.equal(
    isChatEntitlementCode(OPERATIONAL_COST_GUARDRAIL_TRIGGERED),
    false
  );
});

test("the five distinct refusal codes never collapse into one another", () => {
  const codes = new Set([
    CREDIT_BALANCE_INSUFFICIENT,
    PLAN_ENTITLEMENT_EXHAUSTED,
    OPERATIONAL_COST_GUARDRAIL_TRIGGERED,
    PROVIDER_BUDGET_EXHAUSTED,
    CONCURRENT_RESERVATION_CONFLICT,
  ]);
  assert.equal(codes.size, 5);
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

test("a guardrail rejection shows the reset without any internal USD", () => {
  // The server omits internal cost fields from the client response for a
  // guardrail, so the rendered line must degrade to the reset alone.
  const text = formatChatCostSafetyDetails({
    scope: "user_plan_cost_day",
    limitLayer: "operational_guardrail",
    resetAt: "2026-08-02T14:00:00.000Z",
    timeZone: "Australia/Brisbane",
  });

  assert.doesNotMatch(text, /US\$/);
  assert.match(text, /Australia\/Brisbane/);
});

test("invalid diagnostic details are not rendered", () => {
  assert.equal(formatChatCostSafetyDetails({ requiredCostMicroUsd: "secret" }), "");
  assert.equal(formatChatCostSafetyDetails(null), "");
  assert.equal(formatChatCostSafetyDetails([1, 2, 3]), "");
});

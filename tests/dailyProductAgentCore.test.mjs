import assert from "node:assert/strict";
import test from "node:test";
import {
  dailyProductAgentEnabled, dailyProductDisplayState, dailyProductResultDecision,
  dailyProductResultSchema, parseDailyProductState, sourceOrder, scoutIdFromAgentId,
} from "../lib/dailyProductAgentCore.ts";
import { systemAuditActionAllowed } from "../lib/adminAuditSystemActors.ts";

const state = { status: "claimed", source: "memory", claimId: "11111111-2222-4333-8444-555555555555",
  at: "2026-11-13T00:00:00.000Z", leaseUntil: "2026-11-13T02:00:00.000Z" };
const result = { id: "scout.one", claimId: state.claimId, outcome: "failed", reason: "no_change" };

test("daily execution is explicitly enabled and rotates all three logical sources", () => {
  for (const value of [undefined, "false", "1", "TRUE"]) assert.equal(dailyProductAgentEnabled({ DAILY_PRODUCT_AGENT_ENABLED: value }), false);
  assert.equal(dailyProductAgentEnabled({ DAILY_PRODUCT_AGENT_ENABLED: "true" }), true);
  assert.deepEqual(sourceOrder("routing"), ["routing", "memory", "research"]);
  assert.deepEqual(sourceOrder("bad"), ["research", "routing", "memory"]);
  assert.equal(scoutIdFromAgentId("scout.one"), "one");
  assert.equal(scoutIdFromAgentId("scout.one/../../other"), null);
});

test("claim tokens fence results, exact replays are idempotent, and different outcomes cannot overwrite", () => {
  assert.equal(dailyProductResultDecision(state, result), "record");
  assert.equal(dailyProductResultDecision({ ...state, claimId: "other" }, result), "not_claimed");
  const recorded = { ...state, status: "failed", reason: "no_change" };
  assert.equal(dailyProductResultDecision(recorded, result), "replay");
  assert.equal(dailyProductResultDecision(recorded, { ...result, reason: "tests" }), "not_claimed");
  assert.equal(dailyProductResultDecision(null, result), "not_claimed");
});

test("expired and corrupt claims need lookup rather than being reopened", () => {
  assert.equal(parseDailyProductState("not json"), null);
  assert.equal(parseDailyProductState(JSON.stringify({ ...state, status: "retry_ready", reason: "pr_failed" })), null);
  assert.deepEqual(dailyProductDisplayState("not json", Date.now()), { status: "needs_lookup" });
  assert.deepEqual(dailyProductDisplayState(JSON.stringify(state), Date.parse(state.leaseUntil)), { status: "needs_lookup" });
  assert.equal(dailyProductDisplayState(JSON.stringify(state), Date.parse(state.at)).status, "claimed");
});

test("the result contract admits one repository and closed failure codes only", () => {
  assert.equal(dailyProductResultSchema.safeParse(result).success, true);
  assert.equal(dailyProductResultSchema.safeParse({ ...result, reason: "arbitrary private text" }).success, false);
  assert.equal(dailyProductResultSchema.safeParse({ id: result.id, claimId: state.claimId, outcome: "pr_opened", prUrl: "https://attacker.test/pull/1" }).success, false);
  assert.equal(dailyProductResultSchema.safeParse({ ...result, extra: "ignored?" }).success, false);
});

test("the daily actor cannot audit completion, AMUX submission or unrelated targets", () => {
  for (const action of ["daily_product_agent.claimed", "daily_product_agent.result_recorded"]) {
    assert.equal(systemAuditActionAllowed("daily-product-agent", action, "ProductResearchSuggestion"), true);
    assert.equal(systemAuditActionAllowed("daily-product-agent", action, "AppSettings"), false);
  }
  assert.equal(systemAuditActionAllowed("daily-product-agent", "product_research.suggestion.completed", "ProductResearchSuggestion"), false);
});

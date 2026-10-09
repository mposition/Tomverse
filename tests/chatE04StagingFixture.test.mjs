import assert from "node:assert/strict";
import test from "node:test";
import { chatE04StagingFixtureEligible, parseChatE04AutoAction, CHAT_E04_AUTO_ACTIONS } from "../lib/chatE04StagingFixture.ts";
import { runChatE04SyntheticAuto } from "../lib/chatE04StagingFixtureAuto.ts";

test("QA access requires an authenticated administrator and explicit staging environment", () => {
  for (const env of [{ NODE_ENV: "production" }, { APP_ENV: "production" }, { APP_ENV: "test" },
    { APP_ENV: "dev" }, { APP_ENV: "production", RAILWAY_ENVIRONMENT_NAME: "staging" }]) {
    assert.equal(chatE04StagingFixtureEligible({ environment: env, authenticated: true, administrator: true }), false);
  }
  for (const authenticated of [false, true]) for (const administrator of [false, true]) {
    assert.equal(chatE04StagingFixtureEligible({ environment: { APP_ENV: "staging" }, authenticated, administrator }), authenticated && administrator);
  }
  assert.equal(chatE04StagingFixtureEligible({ environment: { NODE_ENV: "production", RAILWAY_ENVIRONMENT_NAME: "staging" }, authenticated: true, administrator: true }), true);
});

test("the fixed action schema rejects client prompt, projection, comparison and dispatch authority", () => {
  for (const action of CHAT_E04_AUTO_ACTIONS) assert.equal(parseChatE04AutoAction({ action }), action);
  for (const value of [null, [], "accepted", {}, { action: "other" },
    ...["prompt", "refinedPrompt", "messages", "shadowComparison", "dispatchAuthorized"].map((key) => ({ action: "accepted", [key]: true }))]) {
    assert.equal(parseChatE04AutoAction(value), null);
  }
});

test("the actual D02 facade preserves authored bytes, shares stage input and never authorizes dispatch", () => {
  const expected = { default_off: ["original", "default_off", null],
    accepted: ["accepted_proposal", "accepted_proposal", null],
    kept_original: ["original", "kept_original", null],
    stale: ["original", "decision_invalid_or_unavailable", "stale"],
    replay: ["original", "decision_invalid_or_unavailable", "unavailable"],
    unknown: ["none", "candidate_outcome_unknown", null] };
  for (const action of CHAT_E04_AUTO_ACTIONS) {
    const result = runChatE04SyntheticAuto(action);
    assert.deepEqual([result.inputSource, result.reason, result.decisionErrorCode], expected[action]);
    assert.equal(result.authoredOriginalPreserved, true);
    assert.equal(result.stagesShareInput, true);
    assert.equal(result.dispatchAuthorized, false);
    assert.equal(result.evidenceAuthority, "synthetic_only");
    for (const key of ["providerCalls", "costMicroUsd", "productDatabaseWrites", "auditWrites"]) assert.equal(result[key], 0);
  }
});

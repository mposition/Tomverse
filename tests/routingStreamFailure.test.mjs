import assert from "node:assert/strict";
import test from "node:test";

import { classifyStreamFailure } from "../lib/routingStreamFailure.ts";
import { decideFallback } from "../lib/routingFallbackPolicy.ts";

// The claim under test is the one §9.1 of the rollout note had to withdraw:
// "the stream produced no text" is not the same as "the provider failed in a
// way §7 lets us route around". Most of these are cases where the first is
// true and the second is not.

const classify = (overrides = {}) =>
  classifyStreamFailure({
    error: Object.assign(new Error("upstream exploded"), {
      name: "APICallError",
      statusCode: 503,
    }),
    phase: "read",
    visibleTokenEmitted: false,
    downstreamOpen: true,
    ...overrides,
  });

const errorWith = (fields) => Object.assign(new Error("failed"), fields);

test("a provider stream failure with nothing shown is the fallback case", () => {
  const classified = classify();
  assert.equal(classified.outcome, "failed_pre_token");
  assert.equal(classified.failureLayer, "provider");
  assert.equal(classified.providerRefusal, null);
});

test("the same failure after a visible token is post-token", () => {
  const classified = classify({ visibleTokenEmitted: true });
  assert.equal(classified.outcome, "failed_post_token");
});

test("a closed response means the client left, whatever the error says", () => {
  // The error here is a textbook retryable provider failure. It does not
  // matter: there is nobody to show a second attempt to.
  const classified = classify({ downstreamOpen: false });
  assert.equal(classified.outcome, "cancelled");
  assert.equal(classified.failureLayer, "stream");
});

test("an aborted request is a cancellation, not a provider failure", () => {
  for (const error of [
    errorWith({ name: "AbortError" }),
    errorWith({ name: "TimeoutError" }),
    errorWith({ code: "ABORT_ERR" }),
    errorWith({ code: "ECONNRESET" }),
  ]) {
    const classified = classify({ error });
    assert.equal(classified.outcome, "cancelled", error.name ?? error.code);
    assert.equal(classified.failureLayer, "stream");
  }
});

test("a controller that is already closed is the client, not the provider", () => {
  const classified = classify({
    error: Object.assign(new Error("Controller is already closed"), {
      code: "ERR_INVALID_STATE",
    }),
  });
  assert.equal(classified.outcome, "cancelled");
  assert.equal(classified.failureLayer, "stream");
});

// The case §9.1 called out by name: `pull()`'s catch also receives failures
// from the completion handling that runs after the last chunk.
test("a completion-handling failure is ours, so it is never a provider failure", () => {
  const classified = classify({ phase: "completion" });
  assert.equal(classified.failureLayer, "stream");
  // Truthful about what the user saw -- the layer, not the outcome, is what
  // keeps this from being substituted.
  assert.equal(classified.outcome, "failed_pre_token");
});

test("a completion failure fails closed rather than trying another model", () => {
  const classified = classify({ phase: "completion" });
  const decision = decideFallback({
    attempt: {
      modelId: "gpt-5-6-luna",
      outcome: classified.outcome,
      failureLayer: classified.failureLayer,
      providerRefusal: classified.providerRefusal,
    },
    run: { passThroughUsed: false, rerouteCount: 0, visibleTokenEmitted: false },
    nextCandidateModelIds: ["deepseek-v4-flash"],
  });
  assert.equal(decision.action, "terminate");
  assert.equal(decision.reason, "fail_closed_layer");
});

// §7 lists policy rejection next to cancellation. Routing around a safety
// refusal is asking a second model to do what the first one would not.
test("a content-policy refusal is a provider failure that is not routed around", () => {
  for (const error of [
    errorWith({ code: "content_filter" }),
    errorWith({ name: "ContentPolicyViolationError" }),
    Object.assign(new Error("blocked by the safety system"), { statusCode: 400 }),
    Object.assign(new Error("prohibited_content in the request"), { statusCode: 400 }),
  ]) {
    const classified = classify({ error });
    assert.equal(classified.failureLayer, "provider");
    assert.equal(classified.providerRefusal, "policy", error.message);

    const decision = decideFallback({
      attempt: {
        modelId: "gpt-5-6-luna",
        outcome: classified.outcome,
        failureLayer: classified.failureLayer,
        providerRefusal: classified.providerRefusal,
      },
      run: { passThroughUsed: false, rerouteCount: 0, visibleTokenEmitted: false },
      nextCandidateModelIds: ["deepseek-v4-flash"],
    });
    assert.equal(decision.action, "terminate");
    assert.equal(decision.reason, "provider_policy_rejection");
  }
});

test("a provider that cannot fund the call is not answered by spending elsewhere", () => {
  const classified = classify({
    error: Object.assign(new Error("payment required"), { statusCode: 402 }),
  });
  assert.equal(classified.providerRefusal, "insufficient_credits");

  const decision = decideFallback({
    attempt: {
      modelId: "gpt-5-6-luna",
      outcome: classified.outcome,
      failureLayer: classified.failureLayer,
      providerRefusal: classified.providerRefusal,
    },
    run: { passThroughUsed: false, rerouteCount: 0, visibleTokenEmitted: false },
    nextCandidateModelIds: ["deepseek-v4-flash"],
  });
  assert.equal(decision.reason, "provider_insufficient_credits");
});

test("rate limits and server errors stay eligible, which is the point", () => {
  // If the exclusions above swallowed these too, the classifier would be safe
  // and useless: 429 and 503 are the failures a fallback exists for.
  for (const statusCode of [429, 500, 502, 503]) {
    const classified = classify({
      error: Object.assign(new Error("upstream"), { statusCode }),
    });
    assert.equal(classified.providerRefusal, null, String(statusCode));
    assert.equal(classified.failureLayer, "provider");
  }
});

test("the reason never carries the provider's own words", () => {
  // Provider errors routinely echo the request back, and this string is
  // written to operator surfaces.
  const secret = "sk-live-do-not-log-this";
  const classified = classify({
    error: Object.assign(new Error(`refused: ${secret}`), { statusCode: 500 }),
  });
  assert.equal(classified.reason.includes(secret), false);
});

test("an unrecognisable error is still a provider failure, not a shrug", () => {
  const classified = classify({ error: "a string, somehow" });
  assert.equal(classified.failureLayer, "provider");
  assert.equal(classified.outcome, "failed_pre_token");
});

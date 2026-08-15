import assert from "node:assert/strict";
import test from "node:test";

import {
  FALLBACK_POLICY_VERSION,
  MAX_MODEL_FALLBACKS,
  decideFallback,
  fallbackStateFor,
  mayRestoreRecoveryCandidate,
  plannerFailureMode,
  recoveryAfterFallback,
} from "../lib/routingFallbackPolicy.ts";

// §6 and §7. Most of these are about refusing to retry, because a retry that
// should not have happened is the expensive kind: it spends a second provider
// call, and on the wrong failure it replaces text the user is already reading.

const decide = (overrides = {}) =>
  decideFallback({
    attempt: {
      modelId: "gpt-5-6-luna",
      outcome: "failed_pre_token",
      failureLayer: "provider",
      ...(overrides.attempt ?? {}),
    },
    run: {
      passThroughUsed: false,
      rerouteCount: 0,
      visibleTokenEmitted: false,
      ...(overrides.run ?? {}),
    },
    nextCandidateModelIds: overrides.nextCandidateModelIds ?? ["deepseek-v4-flash"],
    plannerMode: overrides.plannerMode ?? "pass_through_once",
  });

test("a provider failure before any token falls back to a different model", () => {
  const decision = decide();
  assert.equal(decision.action, "fallback");
  assert.equal(decision.modelId, "deepseek-v4-flash");
  assert.equal(decision.version, FALLBACK_POLICY_VERSION);
});

test("an adapter failure is evidence about this model, so it falls back too", () => {
  const decision = decide({
    attempt: { failureLayer: "adapter", outcome: "not_dispatched" },
  });
  assert.equal(decision.action, "fallback");
});

test("a succeeded attempt is not a failure to recover from", () => {
  const decision = decide({ attempt: { outcome: "succeeded", failureLayer: "none" } });
  assert.equal(decision.action, "terminate");
  assert.equal(decision.reason, "not_a_failure");
});

// §7, and the rule with the most user-visible consequence: restarting on
// another model would replace text the user is already reading.
test("nothing is retried once the user has seen a token", () => {
  for (const attempt of [
    { outcome: "failed_post_token", failureLayer: "stream" },
    { outcome: "failed_pre_token", failureLayer: "provider" },
    { outcome: "not_dispatched", failureLayer: "planner" },
    { outcome: "not_dispatched", failureLayer: "adapter" },
  ]) {
    const decision = decide({ attempt, run: { visibleTokenEmitted: true } });
    assert.equal(
      decision.action,
      "terminate",
      `${attempt.failureLayer} retried after a visible token`
    );
    assert.equal(decision.reason, "visible_token_emitted");
  }
});

test("a post-token failure is refused even where nothing recorded the token", () => {
  const decision = decide({
    attempt: { outcome: "failed_post_token", failureLayer: "stream" },
    run: { visibleTokenEmitted: false },
  });
  assert.equal(decision.reason, "visible_token_emitted");
});

// The user asked for it to stop.
test("cancellation is never retried", () => {
  const decision = decide({
    attempt: { outcome: "cancelled", failureLayer: "none" },
  });
  assert.equal(decision.action, "terminate");
  assert.equal(decision.reason, "cancelled");
});

// §6: retrying a boundary that just refused is how a safety check becomes a
// rate limit.
test("manifest and billing failures fail closed rather than moving model", () => {
  for (const failureLayer of ["manifest", "billing"]) {
    const decision = decide({
      attempt: { failureLayer, outcome: "not_dispatched" },
    });
    assert.equal(decision.action, "terminate", `${failureLayer} moved model`);
    assert.equal(decision.reason, "fail_closed_layer");
  }
});

// §6: a Planner failure is a common-layer failure. Switching models would
// trade a working model for an unknown one on evidence about neither.
test("a planner failure retries the same model, never a different one", () => {
  const decision = decide({
    attempt: { failureLayer: "planner", outcome: "not_dispatched" },
  });
  assert.equal(decision.action, "pass_through");
  assert.equal(decision.modelId, "gpt-5-6-luna", "the pass-through changed model");
});

test("the pass-through downgrade is available once per response", () => {
  const decision = decide({
    attempt: { failureLayer: "planner", outcome: "not_dispatched" },
    run: { passThroughUsed: true },
  });
  assert.equal(decision.action, "terminate");
  assert.equal(decision.reason, "pass_through_exhausted");
});

// The case §6 calls out by name: primary provider fails pre-token, the
// fallback candidate's Planner then fails, and that candidate spends the
// remaining downgrade rather than triggering a third model.
test("a planner failure on the fallback candidate spends the downgrade, not a third model", () => {
  const decision = decide({
    attempt: { modelId: "deepseek-v4-flash", failureLayer: "planner", outcome: "not_dispatched" },
    run: { rerouteCount: 1, passThroughUsed: false },
    nextCandidateModelIds: ["a-third-model"],
  });
  assert.equal(decision.action, "pass_through");
  assert.equal(decision.modelId, "deepseek-v4-flash");
});

// §6's operational switch: enabled only after pass-through evaluation and
// rollback drills, neither of which has happened.
test("pass-through is off unless a deployment turns it on", () => {
  assert.equal(plannerFailureMode({}), "fail_closed");
  assert.equal(plannerFailureMode({ ROUTING_PLANNER_FAILURE_MODE: "true" }), "fail_closed");
  assert.equal(
    plannerFailureMode({ ROUTING_PLANNER_FAILURE_MODE: "pass_through_once" }),
    "pass_through_once"
  );

  const decision = decide({
    attempt: { failureLayer: "planner", outcome: "not_dispatched" },
    plannerMode: "fail_closed",
  });
  assert.equal(decision.action, "terminate");
  assert.equal(decision.reason, "planner_fail_closed");
});

// §6's two-build budget: the primary build and one more.
test("a second model fallback is refused on the build budget", () => {
  const decision = decide({ run: { rerouteCount: MAX_MODEL_FALLBACKS } });
  assert.equal(decision.action, "terminate");
  assert.equal(decision.reason, "build_budget_exhausted");
  assert.equal(MAX_MODEL_FALLBACKS, 1);
});

// A pass-through reuses the authorized context that was already built, so it
// is not a build.
test("a pass-through does not consume the build budget", () => {
  const decision = decide({
    attempt: { failureLayer: "planner", outcome: "not_dispatched" },
    run: { rerouteCount: MAX_MODEL_FALLBACKS },
  });
  assert.equal(decision.action, "pass_through");
});

test("nothing eligible is refused as no candidate, not as an exhausted budget", () => {
  const decision = decide({ nextCandidateModelIds: [] });
  assert.equal(decision.action, "terminate");
  assert.equal(decision.reason, "no_candidate");
});

// The fallback candidate goes through the same filters as the primary, so the
// caller supplies it. A policy that picked one itself would be choosing a
// model that had passed nothing.
test("the fallback model is the caller's first ranked candidate", () => {
  const decision = decide({ nextCandidateModelIds: ["first", "second"] });
  assert.equal(decision.modelId, "first");
});

// --- recorded state ---

// `fallbackState` is about model fallback and agrees with `rerouteCount` in
// the database. A pass-through changes no model and spends no reroute, so it
// must not claim one -- the downgrade is recorded by `passThroughUsed`.
test("a pass-through on a run that never rerouted claims no fallback", () => {
  const fresh = { passThroughUsed: false, rerouteCount: 0, visibleTokenEmitted: false };
  const passThrough = decide({
    attempt: { failureLayer: "planner", outcome: "not_dispatched" },
  });
  assert.equal(passThrough.action, "pass_through");
  assert.equal(fallbackStateFor(passThrough, fresh), "none");
});

test("fallbackState separates a spent budget from a refusal that had none", () => {
  const fresh = { passThroughUsed: false, rerouteCount: 0, visibleTokenEmitted: false };
  assert.equal(fallbackStateFor(decide(), fresh), "fallback_used");
  assert.equal(
    fallbackStateFor(decide({ attempt: { outcome: "cancelled" } }), fresh),
    "none"
  );
  assert.equal(
    fallbackStateFor(
      decide({ run: { rerouteCount: 1 } }),
      { ...fresh, rerouteCount: 1 }
    ),
    "exhausted"
  );
});

// --- §8 recovery ---

// Without a record of what was displaced, stickiness would defend the
// substitute forever.
test("a successful fallback keeps the model it displaced", () => {
  const recovery = recoveryAfterFallback({
    succeededModelId: "deepseek-v4-flash",
    displacedModelId: "gpt-5-6-luna",
    failureLayer: "provider",
  });
  assert.equal(recovery.stickyModelId, "deepseek-v4-flash");
  assert.equal(recovery.switchReason, "temporary_hard_fallback");
  assert.equal(recovery.recoveryCandidateModelId, "gpt-5-6-luna");
  assert.equal(recovery.healthEvidence, "provider");
});

test("a turn that never fell back leaves no recovery state to mistake for one", () => {
  assert.equal(
    recoveryAfterFallback({
      succeededModelId: "gpt-5-6-luna",
      displacedModelId: null,
      failureLayer: "none",
    }),
    null
  );
  assert.equal(
    recoveryAfterFallback({
      succeededModelId: "gpt-5-6-luna",
      displacedModelId: "gpt-5-6-luna",
      failureLayer: "provider",
    }),
    null
  );
});

// Both conditions, not either: health alone would restore a model that has
// since been retired or outgrown by the conversation's own length.
test("restoration needs the failure healed and every current filter passing", () => {
  const base = {
    switchReason: "temporary_hard_fallback",
    recoveryCandidateModelId: "gpt-5-6-luna",
    candidateIsHealthy: true,
    candidatePassesFilters: true,
  };
  assert.equal(mayRestoreRecoveryCandidate(base), true);
  assert.equal(
    mayRestoreRecoveryCandidate({ ...base, candidateIsHealthy: false }),
    false
  );
  assert.equal(
    mayRestoreRecoveryCandidate({ ...base, candidatePassesFilters: false }),
    false
  );
});

// §8 grants the hysteresis bypass to temporary_hard_fallback and nothing else:
// the ordinary reason to move models is not expected to reverse itself.
test("no other switch reason gets the hysteresis bypass", () => {
  for (const switchReason of ["task_preference", "sticky", "manual", null]) {
    assert.equal(
      mayRestoreRecoveryCandidate({
        switchReason,
        recoveryCandidateModelId: "gpt-5-6-luna",
        candidateIsHealthy: true,
        candidatePassesFilters: true,
      }),
      false,
      `${switchReason} was granted the bypass`
    );
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { getModel, PUBLIC_MODELS } from "../lib/models.ts";
import {
  getWebSearchCapability,
  nativeSearchIsDispatchable,
  webSearchIsDispatchable,
  NATIVE_GOOGLE_GROUNDING,
} from "../lib/webSearchCapability.ts";
import {
  ALL_WEB_SEARCH_BACKENDS_READY,
  NO_WEB_SEARCH_BACKENDS,
} from "../lib/webSearchBackends.ts";

test("confirmed-native models report the right tool provider and force/cost flags", () => {
  const openai = getWebSearchCapability("gpt-5-5");
  assert.equal(openai.support, "native");
  assert.equal(openai.provider, "openai");
  assert.equal(openai.canForceExecution, true);
  assert.equal(openai.returnsCitations, true);
  assert.equal(openai.hasAdditionalCost, true);
  assert.deepEqual(getWebSearchCapability("gpt-5-5-thinking"), openai);
  for (const id of ["gpt-5-6-sol", "gpt-5-6-terra", "gpt-5-6-luna"]) {
    assert.deepEqual(getWebSearchCapability(id), openai);
  }

  const anthropic = getWebSearchCapability("claude-sonnet-5");
  assert.equal(anthropic.support, "native");
  assert.equal(anthropic.provider, "anthropic");
  assert.equal(anthropic.canForceExecution, false);
  for (const id of [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-haiku-4-5",
  ]) {
    assert.deepEqual(getWebSearchCapability(id), anthropic);
  }

  // Google is deliberately absent from this test now: no catalogue model uses
  // its native grounding. The record still exists and is still asserted to be
  // undispatchable -- see "Google's own grounding stays undispatchable" below.
});

test("every active Google model searches through the application-managed backend", () => {
  // The four active Google models plus the stable id whose upstream apiModel is
  // gemini-3.5-flash-lite. Listed by hand rather than derived from the
  // catalogue, because the point of the test is that this exact set is what the
  // register says -- a derivation would pass by agreeing with itself.
  const googleModelIds = [
    "gemini-3-7-flash",
    "gemini-3-6-flash",
    "gemini-3-5-flash",
    "gemini-3-1-pro",
    "gemini-2-5-flash",
  ];
  const expected = getWebSearchCapability("gemini-3-7-flash");
  assert.equal(expected.support, "app-managed");
  assert.equal(expected.searchBackend, "brave");
  // Not the model's provider. A Brave request is not billed by Google, and a
  // capability that named one here would have its cost counted against the
  // wrong budget.
  assert.equal(expected.provider, undefined);
  assert.equal(expected.canForceExecution, false);
  assert.equal(expected.returnsCitations, true);
  assert.equal(expected.hasAdditionalCost, true);
  // The ceiling the executor enforces and the ceiling the money is sized on are
  // the same number, with no overshoot allowance: the sixth call never reaches
  // the network, so there is nothing for a provider to overshoot with.
  assert.equal(expected.requestEnforcedSearchQueries, 5);
  assert.equal(expected.maxBillableSearchQueriesPerRequest, 5);

  for (const id of googleModelIds) {
    assert.deepEqual(
      getWebSearchCapability(id),
      expected,
      `${id} should search through the application-managed backend`
    );
  }
});

test("Google's own grounding stays undispatchable", () => {
  // The record no catalogue model uses, kept so that re-enabling grounding is a
  // change this test fails rather than a change nobody notices. Grounding takes
  // no ceiling on the tool or on the request, so its worst case cannot be
  // reserved and nothing may dispatch it.
  assert.equal(NATIVE_GOOGLE_GROUNDING.support, "native");
  assert.equal(NATIVE_GOOGLE_GROUNDING.provider, "google");
  assert.equal(NATIVE_GOOGLE_GROUNDING.hasAdditionalCost, true);
  assert.equal(
    NATIVE_GOOGLE_GROUNDING.maxBillableSearchQueriesPerRequest,
    undefined
  );
  assert.equal(nativeSearchIsDispatchable(NATIVE_GOOGLE_GROUNDING), false);
  assert.equal(
    webSearchIsDispatchable(
      NATIVE_GOOGLE_GROUNDING,
      ALL_WEB_SEARCH_BACKENDS_READY
    ),
    false,
    "no readiness map may make grounding dispatchable"
  );
});

test("Perplexity search models are search-model support, not native", () => {
  for (const id of [
    "perplexity/sonar",
    "perplexity/sonar-pro",
    "perplexity/sonar-reasoning-pro",
  ]) {
    const capability = getWebSearchCapability(id);
    assert.equal(capability.support, "search-model");
    assert.equal(capability.provider, undefined);
    assert.equal(capability.canForceExecution, true);
    assert.equal(capability.hasAdditionalCost, false);
  }
});

test("models without a confirmed doc match are unverified, not assumed native", () => {
  assert.equal(getWebSearchCapability("gpt-5-4-mini").support, "unverified");
});

test("models with no registry entry default to unsupported", () => {
  assert.equal(getWebSearchCapability("codestral").support, "unsupported");
  // A retired id still has to resolve rather than throw when old history is read.
  assert.equal(getWebSearchCapability("llama-3-1").support, "unsupported");
  assert.equal(getWebSearchCapability("grok-4-3").support, "unsupported");
  assert.equal(getWebSearchCapability("not-a-real-model-id").support, "unsupported");
});

test("every public model resolves to a capability without throwing", () => {
  for (const model of PUBLIC_MODELS) {
    const capability = getWebSearchCapability(model.id);
    assert.ok(
      [
        "native",
        "app-managed",
        "search-model",
        "unsupported",
        "unverified",
      ].includes(capability.support)
    );
  }
  assert.ok(getModel("gpt-5-5"), "sanity check: catalog lookup still works");
});

test("an application-managed capability is not dispatchable without its backend", () => {
  const gemini = getWebSearchCapability("gemini-3-7-flash");
  // The register declaring it is not the deployment being able to run it. This
  // is the whole reason `readiness` is a required argument: an optional one
  // defaulting to "assume reachable" would let every surface promise a search
  // that this deployment has no credential for, charge eight credits for it,
  // and refuse only at dispatch.
  assert.equal(webSearchIsDispatchable(gemini, NO_WEB_SEARCH_BACKENDS), false);
  assert.equal(
    webSearchIsDispatchable(gemini, ALL_WEB_SEARCH_BACKENDS_READY),
    true
  );
  // And it is never "native" by either answer -- a caller asking that question
  // about a Brave-backed model must get no.
  assert.equal(nativeSearchIsDispatchable(gemini), false);
});

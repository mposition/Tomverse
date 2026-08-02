import assert from "node:assert/strict";
import test from "node:test";
import { getModel, PUBLIC_MODELS } from "../lib/models.ts";
import { getWebSearchCapability } from "../lib/webSearchCapability.ts";

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

  const google = getWebSearchCapability("gemini-3-5-flash");
  assert.equal(google.support, "native");
  assert.equal(google.provider, "google");
  assert.equal(google.canForceExecution, false);
  assert.deepEqual(getWebSearchCapability("gemini-3-1-pro"), google);
  assert.deepEqual(getWebSearchCapability("gemini-3-6-flash"), google);
  assert.deepEqual(getWebSearchCapability("gemini-2-5-flash"), google);
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
      ["native", "search-model", "unsupported", "unverified"].includes(
        capability.support
      )
    );
  }
  assert.ok(getModel("gpt-5-5"), "sanity check: catalog lookup still works");
});

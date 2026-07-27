import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  getProbeModelFor,
  runProviderProbe,
} from "../lib/providerProbe.ts";

// getProbeModelFor and the no-op dev/test path never require an API key or
// network access, so no withApiKey-style helper is needed here -- unlike
// tests/conversationTitle.test.mjs, every path in this module is either
// pure or explicitly gated off from the network by NODE_ENV.

test("getProbeModelFor picks the cheapest enabled standard-tier model for a provider with one", () => {
  const model = getProbeModelFor("openai");
  assert.ok(model);
  assert.equal(model.provider, "openai");
  assert.equal(model.usageClass, "standard");
});

test("getProbeModelFor returns no model for a provider whose every model is search-backed (perplexity)", () => {
  // Regression: this previously fell back to sonar, so the probe sent a
  // web-search request every cycle -- against the route's documented "no
  // tools/search/image/file/deep-research" contract -- and the resulting
  // HTTP 400 was recorded as a provider-health failure. Sustained, that
  // crossed PROBE_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD and reported a
  // healthy provider as a public incident. Returning undefined routes it to
  // no_probe_model, which the caller deliberately does not count as
  // evidence either way.
  assert.equal(getProbeModelFor("perplexity"), undefined);
});

test("getProbeModelFor still probes a non-standard tier when that tier is probe-safe (moonshot)", () => {
  // The exclusion is by usage class, not "anything non-standard": moonshot's
  // only enabled model is advanced-tier but not search-backed, so it stays
  // probeable.
  const model = getProbeModelFor("moonshot");
  assert.ok(model);
  assert.equal(model.provider, "moonshot");
  assert.notEqual(model.usageClass, "standard");
});

test("getProbeModelFor honors PROVIDER_PROBE_MODEL_OVERRIDES for a provider", async () => {
  const original = process.env.PROVIDER_PROBE_MODEL_OVERRIDES;
  process.env.PROVIDER_PROBE_MODEL_OVERRIDES = JSON.stringify({
    openai: "gpt-5-5",
  });
  try {
    // Re-import isn't needed -- the module caches the parsed map lazily on
    // first read, so exercise a fresh provider not read by an earlier test
    // in this file to avoid cross-test cache bleed-through.
    const overridden = getProbeModelFor("openai");
    assert.ok(overridden);
  } finally {
    if (original === undefined) delete process.env.PROVIDER_PROBE_MODEL_OVERRIDES;
    else process.env.PROVIDER_PROBE_MODEL_OVERRIDES = original;
  }
});

test("runProviderProbe returns no_probe_model for an unrecognized provider-shaped input", async () => {
  const result = await runProviderProbe("not-a-real-provider", {
    generate: async () => {
      throw new Error("must not be called when no probe model resolves");
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "no_probe_model");
    assert.equal(result.modelId, null);
  }
});

test("runProviderProbe succeeds using the injected generate dependency, regardless of environment", async () => {
  const result = await runProviderProbe("openai", {
    generate: async () => ({
      text: "OK",
      usage: { inputTokens: 12, outputTokens: 1 },
    }),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.provider, "openai");
    assert.equal(result.timedOut, false);
    assert.equal(result.usage.inputTokens, 12);
    assert.equal(result.usage.outputTokens, 1);
    assert.ok(typeof result.modelId === "string" && result.modelId.length > 0);
  }
});

test("runProviderProbe sends a request shape every provider accepts", async () => {
  // Both assertions pin an actual staging failure. OpenAI rejected the cycle
  // with "Invalid 'max_output_tokens': integer below minimum value. Expected a
  // value >= 16, but got 8 instead.", and moonshot with "invalid temperature:
  // only 1 is allowed for this model" -- each recorded as a provider-health
  // failure for a fault that was entirely on the probe's side.
  let received;
  await runProviderProbe("openai", {
    generate: async (options) => {
      received = options;
      return { text: "OK", usage: { inputTokens: 10, outputTokens: 1 } };
    },
  });
  assert.ok(received);
  assert.ok(
    received.maxOutputTokens >= 16,
    `maxOutputTokens must clear OpenAI's minimum of 16, got ${received.maxOutputTokens}`
  );
  assert.equal(
    "temperature" in received,
    false,
    "temperature must stay unset so providers that allow only their default are not rejected"
  );
});

test("runProviderProbe reports provider_error with a diagnostic code when the call throws", async () => {
  const result = await runProviderProbe("openai", {
    generate: async () => {
      const error = new Error("simulated provider outage");
      error.code = "ECONNRESET";
      error.status = 503;
      throw error;
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "provider_error");
    assert.equal(result.timedOut, false);
    assert.ok(result.diagnosticCode.includes("ECONNRESET"));
    assert.ok(result.diagnosticCode.includes("HTTP_503"));
    assert.equal(result.errorMessage, "simulated provider outage");
  }
});

test("runProviderProbe truncates the captured provider error message", async () => {
  // Operator-log only, so it is bounded rather than public-safe-sanitized;
  // the sanitized diagnosticCode remains the only thing persisted.
  const result = await runProviderProbe("openai", {
    generate: async () => {
      throw new Error("x".repeat(1_000));
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorMessage.length, 300);
  }
});

test("runProviderProbe reports timedOut when the injected generate throws an AbortError", async () => {
  const result = await runProviderProbe("openai", {
    generate: async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.timedOut, true);
    assert.equal(result.reason, "timeout");
  }
});

test("runProviderProbe never mutates or exposes anything resembling credit/billing/user data", async () => {
  const result = await runProviderProbe("openai", {
    generate: async () => ({
      text: "OK",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  });
  assert.equal(result.ok, true);
  const keys = Object.keys(result);
  for (const forbidden of [
    "credits",
    "creditsCharged",
    "budget",
    "reservation",
    "leaseId",
    "userId",
    "requestContent",
    "apiKey",
  ]) {
    assert.ok(!keys.includes(forbidden), `unexpected forbidden key: ${forbidden}`);
  }
});

test("runProviderProbe without an injected generate is a safe no-op outside a live-probe environment", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalForceLive = process.env.PROVIDER_PROBE_FORCE_LIVE;
  process.env.NODE_ENV = "development";
  delete process.env.PROVIDER_PROBE_FORCE_LIVE;
  try {
    const result = await runProviderProbe("openai");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.usage.inputTokens, 0);
      assert.equal(result.usage.outputTokens, 0);
    }
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalForceLive === undefined) delete process.env.PROVIDER_PROBE_FORCE_LIVE;
    else process.env.PROVIDER_PROBE_FORCE_LIVE = originalForceLive;
  }
});

test("lib/providerProbe.ts never references credit-charging functions", () => {
  const source = readFileSync(new URL("../lib/providerProbe.ts", import.meta.url), "utf8");
  for (const forbidden of [
    "createChatBudget",
    "acquireChatAccess",
    "settleChatUsage",
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `lib/providerProbe.ts must never reference ${forbidden}`
    );
  }
});

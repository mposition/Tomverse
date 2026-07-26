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

test("getProbeModelFor falls back to the cheapest enabled model when no standard tier exists (moonshot)", () => {
  const model = getProbeModelFor("moonshot");
  assert.ok(model);
  assert.equal(model.provider, "moonshot");
  // moonshot has no enabled "standard" model at all -- falling back to
  // whatever is cheapest/enabled is the documented AUD-R001 behavior.
});

test("getProbeModelFor falls back to the cheapest enabled model when no standard tier exists (perplexity)", () => {
  const model = getProbeModelFor("perplexity");
  assert.ok(model);
  assert.equal(model.provider, "perplexity");
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

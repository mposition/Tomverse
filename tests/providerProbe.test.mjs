import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_PROBE_DAILY_COST_CAP_USD,
  PROBE_MAX_OUTPUT_TOKENS,
  getProbeModelFor,
  runProviderProbe,
} from "../lib/providerProbe.ts";
import { getModel, getModelBillingProfile } from "../lib/models.ts";
import { calculateProviderUsageCost } from "../lib/providerUsageCost.ts";

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
  // The exclusion is by usage class, not "anything non-standard": neither of
  // moonshot's enabled models is standard-tier, but neither is search-backed
  // either, so the provider stays probeable.
  const model = getProbeModelFor("moonshot");
  assert.ok(model);
  assert.equal(model.provider, "moonshot");
  assert.notEqual(model.usageClass, "standard");
});

test("a provider with no enabled model yields no probe rather than a false failure", () => {
  // groq is deliberately kept wired up with zero public models after Llama's
  // retirement. Returning undefined makes the caller record no_probe_model;
  // anything else would report a provider outage for a provider Tomverse is
  // simply not calling.
  assert.equal(getProbeModelFor("groq"), undefined);
});

test("xai probes the one model it still has", () => {
  // Consolidating on Grok 4.5 removed the cheap standard-tier probe target,
  // so the probe now runs a premium-reasoning model. That is a deliberate
  // cost choice, revisitable through PROVIDER_PROBE_MODEL_OVERRIDES.
  const model = getProbeModelFor("xai");
  assert.ok(model);
  assert.equal(model.id, "grok-4-5");
});

test("xai's probe target is costed from xAI's published prices, not the premium fallback", () => {
  // The daily probe cost cap is shared across every provider and is spent
  // using each probe target's billing profile, so a mispriced target burns
  // the shared cap at the wrong rate. Grok 4.5 became xAI's only model and
  // therefore its probe target while still falling through to the "premium"
  // cost class: USD 15/60 per million booked against a USD 2/6 model.
  const billing = getModelBillingProfile(getProbeModelFor("xai"));
  assert.equal(billing.inputUsdPerMillionTokens, 2);
  assert.equal(billing.outputUsdPerMillionTokens, 6);
  assert.notEqual(billing.inputUsdPerMillionTokens, 15);
  assert.notEqual(billing.outputUsdPerMillionTokens, 60);
});

test("one xai probe cycle costs what the daily cap was sized against", () => {
  // Pins the arithmetic the cost-acceptance decision rests on: a generous
  // 50 input / 32 output tokens (the probe's whole output budget) must stay
  // far enough under the USD 1 shared daily cap that 144 cycles a day cannot
  // approach it. At the premium fallback this same cycle cost USD 0.00267.
  const billing = getModelBillingProfile(getProbeModelFor("xai"));
  const cost = calculateProviderUsageCost({
    inputTokens: 50,
    outputTokens: PROBE_MAX_OUTPUT_TOKENS,
    inputUsdPerMillionTokens: billing.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: billing.outputUsdPerMillionTokens,
    cachedInputPriceMultiplier: billing.cachedInputPriceMultiplier,
  });
  const perCycleUsd = cost.totalCostMicroUsd / 1_000_000;
  const dailyUsd = perCycleUsd * 144;

  assert.ok(
    perCycleUsd < 0.0004,
    `a worst-case probe cycle should cost well under USD 0.0004, got ${perCycleUsd}`
  );
  assert.ok(
    dailyUsd < DEFAULT_PROBE_DAILY_COST_CAP_USD / 10,
    `xai's own daily probe spend should stay an order of magnitude under the shared cap, got ${dailyUsd}`
  );
});

test("getProbeModelFor honors PROVIDER_PROBE_MODEL_OVERRIDES for a provider", async () => {
  const original = process.env.PROVIDER_PROBE_MODEL_OVERRIDES;
  process.env.PROVIDER_PROBE_MODEL_OVERRIDES = JSON.stringify({
    openai: "gpt-5-5",
  });
  try {
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

// PROVIDER_PROBE_REASONING_EFFORT. getModelGenerationSettings sends a
// reasoning model's *catalogue* effort, and every publicly listed reasoning
// model is "high" -- so without an override here the health probe would ask
// grok-4-5 for maximum reasoning 144 times a day to get back the word OK,
// out of the same 32-token budget the answer comes from. The probe pins its
// own effort instead, and an operator can still change it.
const withEnv = async (name, value, run) => {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
};

const probeRequestFor = async (provider) => {
  let received;
  await runProviderProbe(provider, {
    generate: async (options) => {
      received = options;
      return { text: "OK", usage: { inputTokens: 10, outputTokens: 1 } };
    },
  });
  return received;
};

test("the probe pins its own reasoning effort instead of the catalogue's", async () => {
  await withEnv("PROVIDER_PROBE_REASONING_EFFORT", undefined, async () => {
    const request = await probeRequestFor("xai");
    // grok-4-5's catalogue effort is "high"; a health check must not ask for
    // it. forceReasoning is preserved from getModelProviderOptions -- without
    // it the OpenAI SDK drops reasoning_effort before it reaches xAI.
    assert.deepEqual(request.providerOptions, {
      openai: { reasoningEffort: "low", forceReasoning: true },
    });
    assert.notEqual(getModel("grok-4-5").reasoning, "low");
  });
});

test("a configured reasoning effort reaches a reasoning probe target", async () => {
  await withEnv("PROVIDER_PROBE_REASONING_EFFORT", "minimal", async () => {
    const request = await probeRequestFor("xai");
    // xAI is reached through the OpenAI-compatible chat model, so this is the
    // namespace that becomes reasoning_effort on the wire.
    assert.equal(request.providerOptions.openai.reasoningEffort, "minimal");
  });
});

test("a non-reasoning probe target is never sent a reasoning effort", async () => {
  await withEnv("PROVIDER_PROBE_REASONING_EFFORT", "low", async () => {
    // mistral-small-4 carries no catalogue reasoning effort, so there is no
    // reasoning request to shape and the parameter must not appear at all --
    // an effort a provider does not implement is a rejected cycle, which the
    // caller records as provider health.
    assert.equal(getProbeModelFor("mistral").reasoning, undefined);
    const request = await probeRequestFor("mistral");
    assert.equal("providerOptions" in request, false);
  });
});

test("a reasoning probe target that is not xAI still gets the pinned effort", async () => {
  await withEnv("PROVIDER_PROBE_REASONING_EFFORT", undefined, async () => {
    // openai's cheapest probe-safe model is now a reasoning model, so this
    // path is not xAI-specific -- and OpenAI needs no forceReasoning, since
    // its own ids are on the SDK's reasoning allowlist already.
    assert.equal(getProbeModelFor("openai").reasoning, "medium");
    const request = await probeRequestFor("openai");
    assert.deepEqual(request.providerOptions, {
      openai: { reasoningEffort: "low" },
    });
  });
});

test("an unrecognized reasoning effort falls back rather than being passed through", async () => {
  await withEnv("PROVIDER_PROBE_REASONING_EFFORT", "cheapest-please", async () => {
    const request = await probeRequestFor("xai");
    assert.equal(request.providerOptions.openai.reasoningEffort, "low");
  });
});

test("an unusable probe model override is reported instead of silently dropped", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await withEnv(
      "PROVIDER_PROBE_MODEL_OVERRIDES",
      // grok-3-mini is retired, so it can never be probed. Naming a retired
      // model here is the likely case in practice: retiring a model does not
      // clear the environment variable that points at it.
      JSON.stringify({ xai: "grok-3-mini" }),
      async () => {
        const model = getProbeModelFor("xai");
        assert.ok(model);
        assert.equal(model.id, "grok-4-5", "the default target still wins");
      }
    );
  } finally {
    console.warn = originalWarn;
  }

  const overrideWarning = warnings.find((args) =>
    String(args[0]).includes("PROVIDER_PROBE_MODEL_OVERRIDES")
  );
  assert.ok(overrideWarning, "an ignored override must be logged");
  assert.equal(overrideWarning[1].overrideModelId, "grok-3-mini");
  assert.match(overrideWarning[1].reason, /not enabled/);
});

test("the override map is read fresh, so a later change is not masked by an earlier read", async () => {
  // Guards the reason the previous test can call getProbeModelFor directly:
  // a memoised map made the answer depend on whichever caller read it first,
  // which in this process is one of the tests above.
  const withOverride = await withEnv(
    "PROVIDER_PROBE_MODEL_OVERRIDES",
    JSON.stringify({ openai: "gpt-5-5" }),
    async () => getProbeModelFor("openai")
  );
  assert.equal(withOverride?.id, "gpt-5-5");

  const withoutOverride = await withEnv(
    "PROVIDER_PROBE_MODEL_OVERRIDES",
    undefined,
    async () => getProbeModelFor("openai")
  );
  assert.equal(withoutOverride?.usageClass, "standard");
  assert.notEqual(withoutOverride?.id, "gpt-5-5");
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
    assert.equal("errorMessage" in result, false);
  }
});

test("runProviderProbe never exposes the provider error message", async () => {
  const result = await runProviderProbe("openai", {
    generate: async () => {
      throw Object.assign(new Error("secret prompt and response"), {
        requestBodyValues: { prompt: "secret prompt" },
        responseBody: "secret response",
      });
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal("errorMessage" in result, false);
    assert.doesNotMatch(JSON.stringify(result), /secret prompt|secret response/);
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

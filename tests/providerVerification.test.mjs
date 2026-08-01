import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  PROVIDER_VERIFICATION_PREFERRED_MODEL_IDS,
  getVerificationModelFor,
  runProviderVerification,
} from "../lib/providerVerification.ts";

// getVerificationModelFor is pure registry logic, and runProviderVerification
// never touches the network here: NODE_ENV is "test" under the unit runner, so
// the live path is unreachable, and every case below either injects a fake
// generate or asserts on the no-call branch.

test("perplexity is verified with sonar, never with the deep-research model", () => {
  // The model whose HTTP 400s caused the incident must not be the model a
  // recovery is judged against -- verifying with it would re-run the failing
  // request instead of establishing whether Perplexity is reachable.
  const model = getVerificationModelFor("perplexity");
  assert.ok(model);
  assert.equal(model.id, "perplexity/sonar");
  assert.notEqual(model.usageClass, "deep-research");
  assert.equal(PROVIDER_VERIFICATION_PREFERRED_MODEL_IDS.perplexity, "perplexity/sonar");
});

test("no provider is ever verified with a deep-research model", () => {
  for (const provider of [
    "openai",
    "anthropic",
    "google",
    "groq",
    "xai",
    "deepseek",
    "mistral",
    "moonshot",
    "qwen",
    "zhipu",
    "perplexity",
  ]) {
    const model = getVerificationModelFor(provider);
    if (!model) continue;
    assert.notEqual(model.usageClass, "deep-research", provider);
    assert.equal(model.provider, provider);
    assert.equal(model.enabled, true);
  }
});

test("a provider with an API key verifies through the injected generate function", async () => {
  const previousKey = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = "test-key-not-a-real-credential";
  try {
    const calls = [];
    const result = await runProviderVerification("perplexity", {
      generate: async (options) => {
        calls.push(options);
        return { usage: { inputTokens: 7, outputTokens: 2 } };
      },
    });
    assert.equal(result.status, "success");
    assert.equal(result.modelId, "perplexity/sonar");
    assert.equal(result.diagnosticCode, null);
    assert.equal(calls.length, 1);
    // Minimal request: a tiny output budget, no retries, and a timeout.
    assert.ok(calls[0].maxOutputTokens <= 32);
    assert.equal(calls[0].maxRetries, 0);
    assert.ok(calls[0].abortSignal);
  } finally {
    if (previousKey === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = previousKey;
  }
});

test("a provider rejection is reported as failed with a sanitized code", async () => {
  const previousKey = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = "test-key-not-a-real-credential";
  try {
    const result = await runProviderVerification("perplexity", {
      generate: async () => {
        throw Object.assign(new Error("Bad request: Authorization: Bearer sk-abcdef1234567890"), {
          name: "AI_APICallError",
          statusCode: 400,
        });
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.diagnosticCode, /HTTP_400/);
    assert.equal(result.errorClassification, "BAD_REQUEST");
    assert.ok(!result.message.includes("sk-abcdef1234567890"));
  } finally {
    if (previousKey === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = previousKey;
  }
});

test("a provider with no API key reports unavailable without calling anything", async () => {
  const previousKey = process.env.PERPLEXITY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  try {
    let called = false;
    const result = await runProviderVerification("perplexity", {
      generate: async () => {
        called = true;
        return { usage: { inputTokens: 0, outputTokens: 0 } };
      },
    });
    assert.equal(result.status, "unavailable");
    assert.equal(called, false);
    assert.match(result.diagnosticCode, /NO_API_KEY/);
  } finally {
    if (previousKey !== undefined) process.env.PERPLEXITY_API_KEY = previousKey;
  }
});

test("verification never performs a live call under the test runner", async () => {
  const previousKey = process.env.PERPLEXITY_API_KEY;
  const previousForceLive = process.env.PROVIDER_VERIFICATION_FORCE_LIVE;
  process.env.PERPLEXITY_API_KEY = "test-key-not-a-real-credential";
  delete process.env.PROVIDER_VERIFICATION_FORCE_LIVE;
  try {
    // No injected generate. The live gate must fail closed here: the unit
    // runner leaves NODE_ENV unset, so a "not production" default would have
    // let the suite reach the network and spend provider money. An explicit
    // opt-in is required instead.
    const result = await runProviderVerification("perplexity");
    assert.equal(result.status, "unavailable");
    assert.match(result.diagnosticCode, /LIVE_CALLS_DISABLED/);
  } finally {
    if (previousKey === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = previousKey;
    if (previousForceLive !== undefined) {
      process.env.PROVIDER_VERIFICATION_FORCE_LIVE = previousForceLive;
    }
  }
});

test("NODE_ENV=test refuses a live call even when the force flag is set", async () => {
  const previousKey = process.env.PERPLEXITY_API_KEY;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousForceLive = process.env.PROVIDER_VERIFICATION_FORCE_LIVE;
  process.env.PERPLEXITY_API_KEY = "test-key-not-a-real-credential";
  process.env.NODE_ENV = "test";
  process.env.PROVIDER_VERIFICATION_FORCE_LIVE = "true";
  try {
    const result = await runProviderVerification("perplexity");
    assert.equal(result.status, "unavailable");
    assert.match(result.diagnosticCode, /LIVE_CALLS_DISABLED/);
  } finally {
    if (previousKey === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = previousKey;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousForceLive === undefined) {
      delete process.env.PROVIDER_VERIFICATION_FORCE_LIVE;
    } else {
      process.env.PROVIDER_VERIFICATION_FORCE_LIVE = previousForceLive;
    }
  }
});

test("verification never reserves credits or writes user-facing records", () => {
  // Static scan, mirroring the probe module's own contract test: the safest
  // way to guarantee "no conversation, no message, no credit ledger" is for
  // the module to have no way of reaching those APIs at all.
  const source = readFileSync(
    new URL("../lib/providerVerification.ts", import.meta.url),
    "utf8"
  );
  for (const forbidden of [
    "reserveChatUsage",
    "settleChatUsage",
    "creditLedger",
    "prisma.conversation",
    "prisma.message",
    "chatSecurity",
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `lib/providerVerification.ts must not reference ${forbidden}`
    );
  }
});

test("the scheduled probe policy still refuses to probe perplexity automatically", async () => {
  // Verification opting Perplexity in must not opt the unattended, recurring
  // probe in with it -- every Perplexity model bills a web search per call.
  const { getProbeModelFor } = await import("../lib/providerProbe.ts");
  assert.equal(getProbeModelFor("perplexity"), undefined);
});

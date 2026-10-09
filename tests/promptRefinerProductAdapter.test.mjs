import assert from "node:assert/strict";
import test from "node:test";

import {
  createPromptRefinerProductAdapter,
} from "../lib/promptRefinerProductAdapter.ts";
import { PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST } from
  "../lib/promptRefinerProductContract.ts";

const languageModel = Object.freeze({
  provider: "openai.responses",
  modelId: "gpt-5.6-luna",
});

test("product adapter includes durable admission in its 13 second deadline", async () => {
  let elapsed = 0;
  let generated = 0;
  const adapter = createPromptRefinerProductAdapter({
    languageModel,
    now: () => elapsed,
    wallClock: () => new Date(1_000 + elapsed),
    authorizeDispatch: async (intent) => {
      assert.equal(intent.adapterConfigDigest,
        PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST);
      elapsed = 13_000;
    },
    generate: async () => {
      generated += 1;
      throw new Error("provider must not be called");
    },
  });
  const outcome = await adapter.execute({
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceText: "Rewrite this request with a concrete output format.",
  });
  assert.equal(outcome.status, "undispatched");
  assert.equal(outcome.dispatchedAt, null);
  assert.equal(generated, 0);
  assert.equal(adapter.isTrustedUndispatched(outcome), true);
  assert.equal(adapter.isTrustedVerifiedBilling(outcome), false);
});

test("product adapter makes one retry-free Responses call with the remaining deadline", async () => {
  let elapsed = 0;
  let calls = 0;
  let options;
  const adapter = createPromptRefinerProductAdapter({
    languageModel,
    now: () => elapsed,
    wallClock: () => new Date(1_000 + elapsed),
    authorizeDispatch: async () => { elapsed = 2_000; },
    scheduleTimeout: () => 1,
    cancelTimeout: () => {},
    generate: async (value) => {
      calls += 1;
      options = value;
      elapsed = 2_100;
      return {
        text: JSON.stringify({ outcome: "suggested",
          refinedPrompt: "Return a numbered implementation plan with constraints.",
          abstentionReason: null }),
        finishReason: "stop",
        warnings: [], toolCalls: [], toolResults: [],
        steps: [{ toolCalls: [], toolResults: [] }],
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { reasoningTokens: 5 },
        },
      };
    },
  });
  const outcome = await adapter.execute({
    requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sourceText: "Please improve my implementation request.",
  });
  assert.equal(calls, 1);
  assert.equal(options.maxRetries, 0);
  assert.equal(options.timeout, 11_000);
  assert.equal(options.providerOptions.openai.store, false);
  assert.equal(options.providerOptions.openai.parallelToolCalls, false);
  assert.equal(outcome.status, "suggested");
  assert.equal(adapter.isTrustedVerifiedBilling(outcome), true);
  assert.equal(adapter.isTrustedBillingUnknown(outcome), false);
});

test("product adapter never starts a provider call after an earlier route deadline", async () => {
  let elapsed = 9_000;
  let generated = 0;
  const adapter = createPromptRefinerProductAdapter({
    languageModel,
    now: () => elapsed,
    wallClock: () => new Date(1_000 + elapsed),
    deadlineAtMonotonicMs: 10_000,
    authorizeDispatch: async () => { elapsed = 10_000; },
    generate: async () => { generated += 1; return {}; },
  });
  const outcome = await adapter.execute({
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    sourceText: "Refine this before the route deadline.",
  });
  assert.equal(outcome.status, "undispatched");
  assert.equal(generated, 0);
  assert.equal(adapter.isTrustedUndispatched(outcome), true);
});

test("a provider result resolving after the total deadline cannot publish a suggestion", async () => {
  let elapsed = 0;
  let fireDeadline;
  let resolveProvider;
  const provider = new Promise((resolve) => { resolveProvider = resolve; });
  const adapter = createPromptRefinerProductAdapter({
    languageModel,
    now: () => elapsed,
    wallClock: () => new Date(1_000 + elapsed),
    deadlineAtMonotonicMs: 13_000,
    authorizeDispatch: async () => {},
    scheduleTimeout: (callback) => { fireDeadline = callback; return 1; },
    cancelTimeout: () => {},
    generate: async () => provider,
  });
  const pending = adapter.execute({
    requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    sourceText: "Refine this exactly once.",
  });
  await new Promise(resolve => setImmediate(resolve));
  elapsed = 13_000;
  fireDeadline();
  const outcome = await pending;
  assert.equal(outcome.status, "billing_unknown");
  assert.equal(outcome.reason, "timeout");
  resolveProvider({ text: "late" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.isTrustedBillingUnknown(outcome), true);
  assert.equal(adapter.isTrustedVerifiedBilling(outcome), false);
});


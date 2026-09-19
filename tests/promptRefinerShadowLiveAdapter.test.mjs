import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PROMPT_REFINER_MAX_OUTPUT_TOKENS,
  PROMPT_REFINER_RETRY_COUNT,
  PROMPT_REFINER_TIMEOUT_MS,
} from "../lib/promptRefinerExecutionContract.ts";
import {
  createPromptRefinerShadowSdkAdapter,
  promptRefinerRenderedInputTokenUpperBound,
} from "../lib/promptRefinerShadowLiveAdapter.ts";
import { PROMPT_REFINER_SHADOW_ADAPTER_VERSION } from "../lib/promptRefinerShadowRunContract.ts";

const validRequest = (overrides = {}) => ({
  requestId: "shadow-case-01",
  prompt: "Summarize the launch plan.",
  onDispatch: async () => {},
  ...overrides,
});

const validResult = (overrides = {}) => ({
  text: JSON.stringify({
    refinedPrompt:
      "Summarize the launch plan with its objective, owner, deadline, and primary risk.",
  }),
  usage: {
    inputTokens: 100,
    outputTokens: 20,
    inputTokenDetails: { cacheReadTokens: 0 },
    outputTokenDetails: { reasoningTokens: 8 },
  },
  warnings: [],
  steps: [{}],
  ...overrides,
});

const adapterWith = (generate, times = [1000, 1010]) => {
  let index = 0;
  return createPromptRefinerShadowSdkAdapter({
    generate,
    languageModel: { kind: "mock-language-model" },
    now: () => times[Math.min(index++, times.length - 1)],
  });
};

test("adapter records dispatch immediately before one exact bounded generation", async () => {
  const events = [];
  let options;
  const adapter = adapterWith(async (candidate) => {
    events.push("generate");
    options = candidate;
    return validResult();
  });
  const outcome = await adapter(
    validRequest({
      onDispatch: async (fact) => {
        events.push("dispatch");
        assert.deepEqual(fact, {
          requestId: "shadow-case-01",
          adapterVersion: PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
          provider: "openai",
          modelId: "gpt-5-6-luna",
          apiModelId: "gpt-5.6-luna",
          maxOutputTokens: PROMPT_REFINER_MAX_OUTPUT_TOKENS,
          timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
          retryCount: PROMPT_REFINER_RETRY_COUNT,
        });
      },
    }),
  );

  assert.deepEqual(events, ["dispatch", "generate"]);
  assert.equal(options.maxOutputTokens, 4096);
  assert.equal(options.maxRetries, 0);
  assert.equal(options.timeout, 15_000);
  assert.deepEqual(options.include, {
    requestBody: false,
    responseBody: false,
  });
  assert.deepEqual(options.providerOptions, {
    openai: { reasoningEffort: "medium" },
  });
  assert.equal("tools" in options, false);
  assert.equal("temperature" in options, false);
  assert.match(options.system, /untrusted quoted data/);
  assert.deepEqual(JSON.parse(options.prompt), {
    inputScope: "current_user_turn_text_only",
    sourceText: "Summarize the launch plan.",
  });
  assert.equal(outcome.status, "suggested");
  assert.equal(outcome.terminalReason, "suggested");
  assert.equal(outcome.durationMs, 10);
  assert.deepEqual(outcome.usage, {
    inputTokens: 100,
    cachedInputTokens: 0,
    outputTokens: 20,
    reasoningTokens: 8,
    costUpperBoundMicroUsd: 44,
  });
});

test("dispatch refusal is pre-dispatch and never calls generate", async () => {
  let generated = false;
  const adapter = adapterWith(async () => {
    generated = true;
    return validResult();
  });
  await assert.rejects(
    adapter(
      validRequest({
        onDispatch: async () => {
          throw new Error("reservation was not consumed");
        },
      }),
    ),
    /reservation was not consumed/,
  );
  assert.equal(generated, false);
});

test("invalid request is rejected before dispatch", async () => {
  let dispatched = false;
  let generated = false;
  const adapter = adapterWith(async () => {
    generated = true;
    return validResult();
  });
  await assert.rejects(
    adapter(
      validRequest({
        prompt: " ",
        onDispatch: () => {
          dispatched = true;
        },
      }),
    ),
  );
  assert.equal(dispatched, false);
  assert.equal(generated, false);
});

test("the maximum escaping case remains under the conservative input ceiling", () => {
  const upperBound = promptRefinerRenderedInputTokenUpperBound({
    requestId: "worst-case",
    prompt: "\u0000".repeat(16_000),
  });
  assert.ok(upperBound <= 100_000, `${upperBound} exceeded the contract`);
  assert.ok(upperBound >= 96_000);
});

test("strict parser failures remain fixed response-validation reasons", async (t) => {
  for (const [name, text, reason] of [
    ["fenced", "```json\n{\"refinedPrompt\":\"better\"}\n```", "invalid_response"],
    ["empty", "", "empty_response"],
    ["no change", '{"refinedPrompt":"Summarize the launch plan."}', "no_change"],
  ]) {
    await t.test(name, async () => {
      const adapter = adapterWith(async () => validResult({ text }));
      const outcome = await adapter(validRequest());
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.terminalReason, reason);
      assert.equal(outcome.refinedPrompt, null);
    });
  }
});

test("post-dispatch errors separate timeout, known provider failure, and unknown", async (t) => {
  for (const [name, error, reason] of [
    ["timeout", Object.assign(new Error("secret timeout prose"), { name: "TimeoutError" }), "timeout"],
    ["provider", Object.assign(new Error("secret provider prose"), { statusCode: 429 }), "provider_error"],
    ["unknown", new Error("secret unknown prose"), "unknown_after_dispatch"],
  ]) {
    await t.test(name, async () => {
      const adapter = adapterWith(async () => {
        throw error;
      });
      const outcome = await adapter(validRequest());
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.terminalReason, reason);
      assert.deepEqual(outcome.usage, {
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        costUpperBoundMicroUsd: null,
      });
      assert.equal(JSON.stringify(outcome).includes("secret"), false);
    });
  }
});

test("warnings, multiple steps, or provider usage beyond the contract stop as unknown", async (t) => {
  for (const [name, override] of [
    ["warning", { warnings: [{ type: "unsupported-setting" }] }],
    ["multiple steps", { steps: [{}, {}] }],
    ["input overrun", { usage: { inputTokens: 100_001, outputTokens: 1 } }],
    ["output overrun", { usage: { inputTokens: 1, outputTokens: 4_097 } }],
  ]) {
    await t.test(name, async () => {
      const adapter = adapterWith(async () => validResult(override));
      const outcome = await adapter(validRequest());
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.terminalReason, "unknown_after_dispatch");
    });
  }
});

test("partial usage keeps cost unknown rather than fabricating complete telemetry", async () => {
  const adapter = adapterWith(async () =>
    validResult({ usage: { inputTokens: 100, outputTokens: 20 } }),
  );
  const outcome = await adapter(validRequest());
  assert.equal(outcome.status, "suggested");
  assert.deepEqual(outcome.usage, {
    inputTokens: 100,
    cachedInputTokens: null,
    outputTokens: 20,
    reasoningTokens: null,
    costUpperBoundMicroUsd: null,
  });
});

const SOURCE_SCAN_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".tmp",
  "artifacts",
  "docs",
  "node_modules",
  "public",
  "tests",
]);

const sourceFiles = (root) =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (
        SOURCE_SCAN_EXCLUDED_DIRECTORIES.has(entry.name) ||
        (entry.name.startsWith(".") && entry.name !== ".railway")
      ) {
        return [];
      }
      return sourceFiles(path);
    }
    return /\.(?:ts|tsx|mjs)$/.test(entry.name) ? [path] : [];
  });

test("no shipped entry point imports the live adapter", () => {
  const root = resolve(import.meta.dirname, "..");
  const adapterPath = join(root, "lib/promptRefinerShadowLiveAdapter.ts");
  const scanned = sourceFiles(root).filter((path) => path !== adapterPath);
  assert.ok(scanned.some((path) => path === join(root, "instrumentation.ts")));
  assert.ok(scanned.some((path) => path.startsWith(join(root, "components"))));
  const offenders = scanned
    .filter((path) =>
      readFileSync(path, "utf8").includes("promptRefinerShadowLiveAdapter"),
    )
    .map((path) => path.slice(root.length + 1).replaceAll("\\", "/"));
  assert.deepEqual(offenders, []);

  const adapterSource = readFileSync(
    adapterPath,
    "utf8",
  );
  assert.match(adapterSource, /import\("ai"\)/);
  assert.match(adapterSource, /import\("@\/lib\/activeAiModel"\)/);
  assert.doesNotMatch(adapterSource, /^import .* from "ai";/m);
  assert.doesNotMatch(adapterSource, /^import .*activeAiModel/m);
});

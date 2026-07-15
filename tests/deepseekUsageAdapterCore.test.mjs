import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeDeepSeekSseLine,
  normalizeDeepSeekUsagePayload,
} from "../lib/deepseekUsageAdapterCore.ts";

test("DeepSeek cache-hit tokens are normalized for AI SDK accounting", () => {
  assert.deepEqual(
    normalizeDeepSeekUsagePayload({
      id: "request-1",
      usage: {
        prompt_tokens: 1_000,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200,
        completion_tokens: 50,
        total_tokens: 1_050,
      },
    }),
    {
      id: "request-1",
      usage: {
        prompt_tokens: 1_000,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200,
        prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens: 50,
        total_tokens: 1_050,
      },
    }
  );
});

test("DeepSeek streaming Usage is normalized without changing DONE events", () => {
  const line = normalizeDeepSeekSseLine(
    'data: {"choices":[],"usage":{"prompt_tokens":20,"prompt_cache_hit_tokens":15,"completion_tokens":2}}\n'
  );
  assert.equal(
    JSON.parse(line.slice("data: ".length)).usage.prompt_tokens_details
      .cached_tokens,
    15
  );
  assert.equal(normalizeDeepSeekSseLine("data: [DONE]\n"), "data: [DONE]\n");
});

test("DeepSeek cached tokens are bounded by total prompt tokens", () => {
  const normalized = normalizeDeepSeekUsagePayload({
    usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 999 },
  });
  assert.equal(normalized.usage.prompt_tokens_details.cached_tokens, 10);
});

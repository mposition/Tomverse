import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import {
  anthropicPromptCacheApplies,
  anthropicPromptCacheOptions,
  ANTHROPIC_MIN_CACHEABLE_PREFIX_TOKENS,
  ANTHROPIC_PROMPT_CACHE_PATHS,
  ANTHROPIC_PROMPT_CACHE_TTL,
} from "../lib/anthropicPromptCaching.ts";
import { getModelGenerationSettings } from "../lib/modelGenerationCompatibility.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";
import { calculateProviderUsageCost } from "../lib/providerUsageCost.ts";

const model = (modelId) => {
  const found = AVAILABLE_MODELS.find((candidate) => candidate.id === modelId);
  assert.ok(found, `model ${modelId} is missing from the registry`);
  return found;
};

const anthropicNamespace = (settings) => settings.providerOptions?.anthropic;

// ---------------------------------------------------------------------------
// Which requests carry a marker
// ---------------------------------------------------------------------------

test("an Anthropic chat turn carries a 5-minute cache marker", () => {
  const settings = getModelGenerationSettings(model("claude-sonnet-5"), {
    promptCachePath: "chat_turn",
  });
  assert.deepEqual(anthropicNamespace(settings).cacheControl, {
    type: "ephemeral",
    ttl: "5m",
  });
});

test("the TTL is 5m and the 1-hour cache is not reachable from any path", () => {
  assert.equal(ANTHROPIC_PROMPT_CACHE_TTL, "5m");
  // Every path that caches, checked -- not just the one above. A 1-hour write
  // costs 2x base input against the 5-minute write's 1.25x, and the decision to
  // pay that has not been made (docs/policy/anthropic-prompt-caching.md §3).
  for (const [path, policy] of Object.entries(ANTHROPIC_PROMPT_CACHE_PATHS)) {
    if (!policy.caches) continue;
    const options = anthropicPromptCacheOptions(model("claude-sonnet-5"), path);
    assert.equal(
      options.anthropic.cacheControl.ttl,
      "5m",
      `${path} must request the 5-minute TTL`
    );
  }
});

test("thinking and effort survive beside the cache marker", () => {
  // The failure this guards is silent: `anthropic` is one namespace, and a
  // shallow spread replaces `thinking`/`effort` with `cacheControl` alone --
  // a request that stops reasoning and reports nothing.
  const reasoning = AVAILABLE_MODELS.find(
    (candidate) =>
      candidate.provider === "anthropic" && candidate.reasoning !== undefined
  );
  assert.ok(reasoning, "at least one Anthropic model declares a reasoning effort");

  const settings = getModelGenerationSettings(reasoning, {
    promptCachePath: "chat_turn",
  });
  const namespace = anthropicNamespace(settings);
  assert.deepEqual(namespace.thinking, { type: "adaptive" });
  assert.equal(namespace.effort, reasoning.reasoning);
  assert.deepEqual(namespace.cacheControl, { type: "ephemeral", ttl: "5m" });
});

test("MiniMax gets no Anthropic cache marker despite sharing the SDK namespace", () => {
  // MiniMax is built with `createAnthropic()` against api.minimax.io, so it
  // reads the same `anthropic` provider-options namespace. Gating on "uses the
  // Anthropic SDK" would send `cache_control` to an endpoint whose caching
  // semantics and price this application has never verified.
  const minimax = model("minimax-m3");
  assert.equal(minimax.provider, "minimax");

  const settings = getModelGenerationSettings(minimax, {
    promptCachePath: "chat_turn",
  });
  const namespace = anthropicNamespace(settings);
  assert.equal(namespace.cacheControl, undefined);
  // Its own thinking configuration is untouched.
  assert.deepEqual(namespace.thinking, { type: "adaptive" });
  assert.equal(anthropicPromptCacheApplies(minimax, "chat_turn"), false);
});

test("no non-Anthropic provider receives a cache marker on any path", () => {
  for (const candidate of AVAILABLE_MODELS) {
    if (candidate.provider === "anthropic") continue;
    for (const path of Object.keys(ANTHROPIC_PROMPT_CACHE_PATHS)) {
      const settings = getModelGenerationSettings(candidate, {
        promptCachePath: path,
      });
      assert.equal(
        anthropicNamespace(settings)?.cacheControl,
        undefined,
        `${candidate.id} (${candidate.provider}) must not carry a cache marker on ${path}`
      );
    }
  }
});

test("the fallback attempt carries no marker in the first launch scope", () => {
  // This assertion used to require the fallback to match the primary, on the
  // argument that two attempts of one turn should differ only by model. The
  // argument was about manifest legibility and never about whether the
  // fallback has a prefix to read back -- and it does not: reading its own
  // entry needs the same conversation to fail over to the same model twice
  // inside five minutes, which nothing measures. So the fallback is held out
  // of the launch scope, and the manifests differ by a marker the table
  // explains rather than by an accident (lib/anthropicPromptCaching.ts).
  const sonnet = model("claude-sonnet-5");
  const primary = getModelGenerationSettings(sonnet, {
    promptCachePath: "chat_turn",
  });
  const fallback = getModelGenerationSettings(sonnet, {
    promptCachePath: "chat_fallback_turn",
  });
  assert.deepEqual(anthropicNamespace(primary).cacheControl, {
    type: "ephemeral",
    ttl: "5m",
  });
  assert.equal(anthropicNamespace(fallback)?.cacheControl, undefined);
});

test("one-shot paths carry no marker and say why", () => {
  for (const path of [
    "conversation_title",
    "comparison_review_verify_item",
    "provider_probe",
    "provider_verification",
    "memory_extraction",
  ]) {
    assert.equal(
      ANTHROPIC_PROMPT_CACHE_PATHS[path].caches,
      false,
      `${path} repeats no prefix`
    );
    assert.equal(
      anthropicPromptCacheOptions(model("claude-sonnet-5"), path),
      undefined
    );
    assert.ok(
      ANTHROPIC_PROMPT_CACHE_PATHS[path].rationale.length > 40,
      `${path} must record why it is excluded`
    );
  }
});

test("every declared path records a rationale", () => {
  for (const [path, policy] of Object.entries(ANTHROPIC_PROMPT_CACHE_PATHS)) {
    assert.equal(typeof policy.caches, "boolean", path);
    assert.ok(
      typeof policy.rationale === "string" && policy.rationale.length > 40,
      `${path} must record the repeated prefix it has, or the reason it has none`
    );
  }
});

test("an unnamed path caches nothing", () => {
  // The default direction matters: "cache unless told not to" would have made
  // the health probe and the title call cache writes nothing reads, silently.
  const settings = getModelGenerationSettings(model("claude-sonnet-5"));
  assert.equal(anthropicNamespace(settings)?.cacheControl, undefined);
});

test("the chat route decides its caching path exactly once", () => {
  // This used to count two `promptCachePath: "chat_turn"` literals -- one for
  // the budget, one for the request -- on the argument that the two are
  // decided far apart in a very long function and a drift between them
  // under-reserves rather than failing.
  //
  // The argument was right and counting literals was the wrong expression of
  // it: two literals that agree today are still two readings, and the route now
  // has to choose between `chat_turn` and `chat_turn_native_search` from
  // `nativeSearchEnabled`. So the route computes the path once and both calls
  // read that variable, and the structural check moved to
  // tests/anthropicPromptCachingWiring.test.mjs, which resolves the variable
  // and verifies both call sites per call rather than by counting text.
  const route = readFileSync(
    join(import.meta.dirname, "..", "app/api/chat/route.ts"),
    "utf8"
  );
  assert.equal(
    (route.match(/const promptCachePath\b/g) ?? []).length,
    1,
    "one assignment, so the budget and the request cannot disagree"
  );
  assert.equal(
    (route.match(/promptCachePath: "chat_turn"/g) ?? []).length,
    0,
    "the call sites read the variable, not a repeated literal"
  );
});

test("minimum cacheable prefixes are recorded but never suppress the marker", () => {
  // Haiku 4.5's minimum is eight times Opus 5's, and a prompt under it is a
  // normal cache miss: the provider writes nothing and charges nothing extra.
  assert.equal(ANTHROPIC_MIN_CACHEABLE_PREFIX_TOKENS["claude-haiku-4-5"], 4_096);
  assert.equal(ANTHROPIC_MIN_CACHEABLE_PREFIX_TOKENS["claude-sonnet-5"], 1_024);
  assert.equal(ANTHROPIC_MIN_CACHEABLE_PREFIX_TOKENS["claude-opus-4-8"], 512);

  // Haiku still gets the marker. Withholding it would mean deciding from this
  // application's own token *estimate*, which is an estimate.
  const settings = getModelGenerationSettings(model("claude-haiku-4-5"), {
    promptCachePath: "chat_turn",
  });
  assert.deepEqual(anthropicNamespace(settings).cacheControl, {
    type: "ephemeral",
    ttl: "5m",
  });
});

// ---------------------------------------------------------------------------
// What a cached turn costs
// ---------------------------------------------------------------------------

const sonnetPricing = () => resolveModelPricing(model("claude-sonnet-5"));

const priceTurn = ({ inputTokens, cacheRead = 0, cacheWrite = 0, outputTokens = 0 }) => {
  const pricing = sonnetPricing();
  return calculateProviderUsageCost({
    inputTokens,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens,
    inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
    cachedInputPriceMultiplier: pricing.cachedInputPriceMultiplier,
    cacheWriteUsdPerMillionTokens: pricing.cacheWriteUsdPerMillionTokens,
  });
};

test("a cache miss costs exactly what it always cost", () => {
  // The no-regression case: a turn with no cache activity must price
  // byte-identically to how it did before any of this existed.
  const priced = priceTurn({ inputTokens: 100_000, outputTokens: 1_000 });
  assert.equal(priced.uncachedInputTokens, 100_000);
  assert.equal(priced.cachedInputTokens, 0);
  assert.equal(priced.cacheWriteInputTokens, 0);
  // 100,000 x US$2/MTok = 200,000 micro-USD.
  assert.equal(priced.uncachedInputCostMicroUsd, 200_000);
  assert.equal(priced.cacheWriteInputCostMicroUsd, 0);
  assert.equal(priced.outputCostMicroUsd, 10_000);
  assert.equal(priced.totalCostMicroUsd, 210_000);
});

test("a cache write is charged at 1.25x the input rate", () => {
  // The first turn of a conversation: the whole prompt is written into the
  // cache. `inputTokens` is the SDK's total and already contains the write
  // count, so nothing is left over as uncached.
  const priced = priceTurn({ inputTokens: 100_000, cacheWrite: 100_000 });
  assert.equal(priced.uncachedInputTokens, 0);
  assert.equal(priced.cacheWriteInputTokens, 100_000);
  // 100,000 x US$2.50/MTok = 250,000 micro-USD -- 25% over the uncached 200,000.
  assert.equal(priced.cacheWriteInputCostMicroUsd, 250_000);
  assert.equal(priced.totalCostMicroUsd, 250_000);
  assert.equal(priced.unpricedCacheWriteTokens, 0);
});

test("a cache read is charged at 0.1x the input rate", () => {
  const priced = priceTurn({ inputTokens: 100_000, cacheRead: 100_000 });
  assert.equal(priced.cachedInputCostMicroUsd, 20_000);
  assert.equal(priced.totalCostMicroUsd, 20_000);
});

test("a steady multi-turn request reads most of its prefix and writes the delta", () => {
  // The healthy loop: 90,000 read back, 8,000 newly written, 2,000 uncached
  // tail after the breakpoint.
  const priced = priceTurn({
    inputTokens: 100_000,
    cacheRead: 90_000,
    cacheWrite: 8_000,
    outputTokens: 1_000,
  });
  assert.equal(priced.uncachedInputTokens, 2_000);
  assert.equal(priced.cachedInputCostMicroUsd, 18_000); // 90,000 x 0.20
  assert.equal(priced.cacheWriteInputCostMicroUsd, 20_000); // 8,000 x 2.50
  assert.equal(priced.uncachedInputCostMicroUsd, 4_000); // 2,000 x 2.00
  assert.equal(priced.outputCostMicroUsd, 10_000);
  assert.equal(priced.totalCostMicroUsd, 52_000);

  // And it is genuinely cheaper than the same traffic uncached, which is the
  // claim the whole feature rests on.
  const uncached = priceTurn({ inputTokens: 100_000, outputTokens: 1_000 });
  assert.ok(priced.totalCostMicroUsd < uncached.totalCostMicroUsd);
});

test("writes are never folded into the uncached remainder", () => {
  // The specific defect: before the write count was carved out, these tokens
  // sat inside `uncachedInputTokens` and were billed at 1.0x. The difference is
  // exactly the 25% premium.
  const correct = priceTurn({ inputTokens: 100_000, cacheWrite: 100_000 });
  const asIfWritesWereUncached = priceTurn({ inputTokens: 100_000 });
  assert.equal(
    correct.totalCostMicroUsd - asIfWritesWereUncached.totalCostMicroUsd,
    50_000,
    "a fully-written prompt must cost 25% more than the same prompt uncached"
  );
});

test("a model with no verified write rate reports the gap instead of discounting it", () => {
  const priced = calculateProviderUsageCost({
    inputTokens: 10_000,
    cacheWriteInputTokens: 10_000,
    outputTokens: 0,
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 10,
    cacheWriteUsdPerMillionTokens: null,
  });
  assert.equal(priced.cacheWriteInputCostMicroUsd, 0);
  assert.equal(
    priced.unpricedCacheWriteTokens,
    10_000,
    "an unverified rate must surface as a stated token gap, not as a silent discount"
  );
  assert.equal(priced.cacheWriteUsdPerMillionTokens, null);
});

test("reads and writes that overrun the input total are clamped downward", () => {
  // A provider that contradicts itself. Reads are taken first because they are
  // the cheaper line, so a contradiction can only ever move cost down.
  const priced = priceTurn({
    inputTokens: 1_000,
    cacheRead: 900,
    cacheWrite: 900,
  });
  assert.equal(priced.cachedInputTokens, 900);
  assert.equal(priced.cacheWriteInputTokens, 100);
  assert.equal(priced.uncachedInputTokens, 0);
  assert.equal(
    priced.cachedInputTokens +
      priced.cacheWriteInputTokens +
      priced.uncachedInputTokens,
    priced.inputTokens,
    "the three token lines must always be a split of the input total"
  );
});

test("a web-searching turn still prices its cache lines", () => {
  // Anthropic's server-side search inserts its own 5-minute cache write after
  // tool results when the request already uses caching, so a searching turn
  // legitimately reports writes at a position nobody marked. It must price the
  // same way as any other write -- the search's own per-query charge is a
  // separate line that never passes through this function.
  const priced = priceTurn({
    inputTokens: 50_000,
    cacheRead: 30_000,
    cacheWrite: 15_000,
    outputTokens: 2_000,
  });
  assert.equal(priced.uncachedInputTokens, 5_000);
  assert.equal(priced.cacheWriteInputCostMicroUsd, 37_500); // 15,000 x 2.50
  assert.equal(priced.cachedInputCostMicroUsd, 6_000); // 30,000 x 0.20
});

test("a historical snapshot re-prices at its own stored rate", () => {
  // Re-pricing a stored settlement means using the rate on the snapshot, not
  // today's registry. A later price change must not move an old number.
  const storedSnapshotRate = 3; // a hypothetical earlier US$3 input rate
  const priced = calculateProviderUsageCost({
    inputTokens: 100_000,
    cacheWriteInputTokens: 100_000,
    outputTokens: 0,
    inputUsdPerMillionTokens: storedSnapshotRate,
    outputUsdPerMillionTokens: 15,
    cacheWriteUsdPerMillionTokens: storedSnapshotRate * 1.25,
  });
  assert.equal(priced.cacheWriteInputCostMicroUsd, 375_000);
  assert.notEqual(
    priced.cacheWriteUsdPerMillionTokens,
    sonnetPricing().cacheWriteUsdPerMillionTokens,
    "the stored rate, not the current one"
  );
});

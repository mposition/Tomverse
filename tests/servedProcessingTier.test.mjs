import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyServedProcessingTier,
  observeServedProcessingTier,
  readServedProcessingTier,
} from "../lib/servedProcessingTier.ts";

// The point of this module is that "we assume Standard" stops being an
// unchecked claim. Each case below is a way that claim could be wrong while
// still looking fine.

test("a response served at Standard is not a mismatch", () => {
  const metadata = { openai: { serviceTier: "default" } };
  const observation = observeServedProcessingTier("openai", metadata);
  assert.equal(observation.servedTier, "default");
  assert.equal(observation.classification, "standard");
  assert.equal(observation.mismatchesAssumedStandard, false);
});

test("a premium tier is a mismatch: the profile priced it too cheaply", () => {
  for (const tier of ["priority", "scale"]) {
    const observation = observeServedProcessingTier("openai", {
      openai: { serviceTier: tier },
    });
    assert.equal(observation.classification, "premium", tier);
    assert.equal(observation.mismatchesAssumedStandard, true, tier);
  }
});

test("a discounted tier is a mismatch too", () => {
  // Over-reserving is the safe direction, but a profile that does not describe
  // what was billed is still wrong, and the fallback-vs-settled ratios the
  // admin report tracks would drift without anyone seeing why.
  for (const tier of ["flex", "batch"]) {
    const observation = observeServedProcessingTier("openai", {
      openai: { serviceTier: tier },
    });
    assert.equal(observation.classification, "discounted", tier);
    assert.equal(observation.mismatchesAssumedStandard, true, tier);
  }
});

test("a tier nobody has priced reads as unknown, never as standard", () => {
  const observation = observeServedProcessingTier("openai", {
    openai: { serviceTier: "turbo-max-2027" },
  });
  assert.equal(observation.classification, "unknown");
  assert.equal(observation.mismatchesAssumedStandard, true);
});

test("silence is not a claim", () => {
  // Every provider without a tier concept reports nothing, and that must not
  // read as either confirmation or contradiction.
  for (const metadata of [undefined, null, {}, { openai: {} }, "nonsense", 7]) {
    const observation = observeServedProcessingTier("openai", metadata);
    assert.equal(observation.classification, "absent");
    assert.equal(observation.mismatchesAssumedStandard, false);
  }
});

test("a non-OpenAI provider reporting a tier is surfaced, not assumed benign", () => {
  // No other provider is expected to send one. If one starts, the profiles
  // were written without knowing about it.
  const observation = observeServedProcessingTier("anthropic", {
    anthropic: { serviceTier: "priority" },
  });
  assert.equal(observation.classification, "unknown");
  assert.equal(observation.mismatchesAssumedStandard, true);
});

test("metadata belonging to another provider is not read", () => {
  const observation = observeServedProcessingTier("anthropic", {
    openai: { serviceTier: "flex" },
  });
  assert.equal(observation.servedTier, null);
  assert.equal(observation.classification, "absent");
});

test("a malformed shape degrades instead of throwing", () => {
  // This runs on the chat path the instant a response completes. A version
  // bump that changes the metadata shape must not take the stream down with it.
  assert.equal(readServedProcessingTier("openai", { openai: { serviceTier: 42 } }), null);
  assert.equal(readServedProcessingTier("openai", { openai: { serviceTier: "  " } }), null);
  assert.equal(readServedProcessingTier("openai", { openai: null }), null);
  assert.equal(classifyServedProcessingTier("openai", null), "absent");
});

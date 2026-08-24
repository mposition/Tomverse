import assert from "node:assert/strict";
import test from "node:test";

import {
  modelOwner,
  modelOwnerLabel,
  modelOwnerPhrase,
} from "../lib/modelOwner.ts";

// Who made a model, as distinct from whose catalogue we read it from (ML-13).
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md ML-13.

test("the three lines the audit measured now name the right maker", () => {
  // Every one of these was printed with the scanning provider in front of it,
  // so the report said Qwen built GLM, Qwen built Kimi, and Perplexity built
  // DeepSeek.
  assert.equal(modelOwner("ZHIPU/GLM-5.3"), "zhipu");
  assert.equal(modelOwner("kimi-k3"), "moonshot");
  assert.equal(modelOwner("perplexity/deepseek-v4-pro-0813"), "deepseek");
});

test("an aggregator's route never becomes the maker", () => {
  // The prefix says where the request goes. Reading it as authorship would
  // relabel other people's models as the host's.
  for (const [apiModel, owner] of [
    ["perplexity/glm-5.3", "zhipu"],
    ["groq/llama-4-70b", "meta"],
    ["openrouter/anthropic-claude-opus-5", "anthropic"],
    ["qwen/deepseek-v4", "deepseek"],
  ]) {
    assert.equal(modelOwner(apiModel), owner, apiModel);
  }
});

test("a host's own model is still the host's", () => {
  assert.equal(modelOwner("perplexity/sonar"), "perplexity");
  assert.equal(modelOwner("sonar-pro"), "perplexity");
});

test("a longer family token wins over a shorter one it contains", () => {
  // `chatglm` contains `glm` and `chatgpt` contains `gpt`, but only one of each
  // pair is the answer.
  assert.equal(modelOwner("chatglm-4"), "zhipu");
  assert.equal(modelOwner("chatgpt-4o-latest"), "openai");
  assert.equal(modelOwner("mistralai/mixtral-8x22b"), "mistral");
});

test("an unrecognised model is unknown, never the provider that listed it", () => {
  // The whole point of the label. A guess dressed as a fact is worse than an
  // admission, because nothing downstream would ever correct it.
  assert.equal(modelOwner("aurora-9"), "unknown");
  assert.equal(modelOwner("groq/aurora-9"), "unknown");
  assert.equal(modelOwner(""), "unknown");
  assert.equal(modelOwner("   "), "unknown");
  assert.equal(modelOwner("some-vendor/"), "unknown");
});

test("a vendor prefix decides only a name that says nothing itself", () => {
  // `nvidia` publishes models whose names carry no family token of their own.
  assert.equal(modelOwner("nvidia/some-internal-build"), "nvidia");
  assert.equal(modelOwner("meta-llama/scout-17b"), "meta");
  // And a nested path ends with the vendor that owns the namespace beneath it.
  assert.equal(modelOwner("accounts/deepseek-ai/models/r2-preview"), "deepseek");
});

test("case and surrounding whitespace do not change the answer", () => {
  assert.equal(modelOwner("  ZHIPU/GLM-5.3  "), "zhipu");
  assert.equal(modelOwner("Claude-Opus-5"), "anthropic");
  assert.equal(modelOwner("GPT-5.6-luna"), "openai");
});

test("every owner has a label, and unknown reads as an admission", () => {
  const owners = new Set(
    [
      "ZHIPU/GLM-5.3",
      "kimi-k3",
      "gpt-5-6-luna",
      "claude-opus-5",
      "gemini-3-pro",
      "llama-4-70b",
      "grok-5",
      "deepseek-v4",
      "mistral-large-3",
      "minimax-m2",
      "qwen3-max",
      "sonar-pro",
      "command-r-plus",
      "phi-5",
      "nemotron-4",
      "aurora-9",
    ].map(modelOwner)
  );
  for (const owner of owners) {
    const label = modelOwnerLabel(owner);
    assert.ok(label && label.length > 0, owner);
  }
  assert.match(modelOwnerLabel("unknown"), /unknown/);
  assert.equal(modelOwnerPhrase("kimi-k3"), "Moonshot");
  assert.equal(modelOwnerPhrase("aurora-9"), "unknown owner");
});

test("resolution is a pure function of the identifier", () => {
  // It reads no registry and no scan result, which is why a report can call it
  // on a model nothing in this system has ever served.
  assert.equal(modelOwner("glm-6"), modelOwner("glm-6"));
  assert.equal(modelOwner("ZHIPU/GLM-5.3"), modelOwner("zhipu/glm-5.3"));
});

// The Slack side of the same fix: one line per model, saying who made it and
// which catalogues carried it.

const scan = (provider, newCandidates) => ({
  provider,
  status: "checked",
  discovered: newCandidates.length,
  mapped: [],
  candidates: newCandidates,
  newCandidates,
  missing: [],
  lifecycleWarnings: [],
});

test("a candidate line separates the maker from the catalogue", async () => {
  const { candidateRowsFor } = await import(
    "../lib/providerModelCatalogReport.ts"
  );
  const [row] = candidateRowsFor([scan("qwen", ["ZHIPU/GLM-5.3"])]);
  assert.match(row, /Zhipu/);
  assert.match(row, /seen in Qwen/);
  // And never the old shape, where the scanning provider led the line.
  assert.doesNotMatch(row, /^• Qwen/);
});

test("one model seen in three catalogues is one line, not three", async () => {
  const { candidateRowsFor } = await import(
    "../lib/providerModelCatalogReport.ts"
  );
  const rows = candidateRowsFor([
    scan("zhipu", ["glm-5.3"]),
    scan("qwen", ["ZHIPU/GLM-5.3"]),
    scan("perplexity", ["perplexity/glm-5.3"]),
  ]);
  assert.equal(rows.length, 1);
  for (const name of ["Zhipu GLM", "Qwen", "Perplexity"]) {
    assert.ok(rows[0].includes(name), `${name} missing from: ${rows[0]}`);
  }
  // A catalogue that named it differently says so, because somebody checking
  // the claim needs the string that was actually there.
  assert.match(rows[0], /as `ZHIPU\/GLM-5\.3`/);
});

test("different models stay on different lines", async () => {
  const { candidateRowsFor } = await import(
    "../lib/providerModelCatalogReport.ts"
  );
  const rows = candidateRowsFor([
    scan("qwen", ["ZHIPU/GLM-5.3", "kimi-k3"]),
  ]);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => /Zhipu/.test(row)));
  assert.ok(rows.some((row) => /Moonshot/.test(row)));
});

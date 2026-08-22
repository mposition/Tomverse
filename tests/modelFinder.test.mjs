import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  MODEL_FINDER_FILE_USAGE,
  MODEL_FINDER_PRIORITIES,
  MODEL_FINDER_TASKS,
  getComplementaryModelSuggestion,
  getContextualModelSuggestion,
  getModelFinderCombination,
  getModelFinderPromptKey,
  getModelFinderRecommendations,
  getOptionalModelSuggestion,
  isModelFinderDefaultId,
} from "../lib/modelFinder.ts";

test("model finder returns at most three free Standard defaults", () => {
  const recommendations = getModelFinderRecommendations({
    tasks: ["documents", "general"],
    priority: "fast",
    fileUsage: "documents",
  });
  assert.ok(recommendations.length > 0);
  assert.ok(recommendations.length <= 3);
  assert.ok(recommendations.every(({ modelId }) => isModelFinderDefaultId(modelId)));
  assert.equal(recommendations[0].modelId, "gemini-2-5-flash");
});

test("coding and multilingual work map to suitable Standard models", () => {
  const coding = getModelFinderRecommendations({
    tasks: ["coding"],
    priority: "fast",
    fileUsage: "rarely",
  });
  const multilingual = getModelFinderRecommendations({
    tasks: ["multilingual"],
    priority: "balanced",
    fileUsage: "rarely",
  });
  assert.equal(coding[0].modelId, "deepseek-v4-flash");
  assert.ok(["mistral-small-4", "qwen3.6-flash"].includes(multilingual[0].modelId));
});

test("Advanced and Research models are optional, never default recommendations", () => {
  const deep = getOptionalModelSuggestion({
    tasks: ["documents"],
    priority: "deep",
    fileUsage: "documents",
  });
  const research = getOptionalModelSuggestion({
    tasks: ["research"],
    priority: "sources",
    fileUsage: "rarely",
  });
  assert.deepEqual(deep, {
    modelId: "claude-sonnet-5",
    reason: "deep_analysis",
  });
  assert.deepEqual(research, {
    modelId: "perplexity/sonar",
    reason: "research",
  });
});

test("contextual suggestions classify locally without returning prompt content", () => {
  const suggestion = getContextualModelSuggestion({
    text: "이 계약서의 위험 조항을 분석해줘",
    attachments: [{ name: "contract.pdf", mediaType: "application/pdf" }],
  });
  assert.equal(suggestion?.modelId, "claude-sonnet-5");
  assert.deepEqual(Object.keys(suggestion || {}).sort(), ["key", "modelId", "reason"]);
});

test("model finder combination always returns 2-3 distinct models with a primary matching the ranked top pick", () => {
  const answers = { tasks: ["documents", "coding"], priority: "fast" };
  const combo = getModelFinderCombination(answers);
  const topRanked = getModelFinderRecommendations({
    ...answers,
    fileUsage: "rarely",
  })[0];

  assert.ok(combo.length === 2 || combo.length === 3);
  assert.equal(new Set(combo.map((pick) => pick.modelId)).size, combo.length);
  assert.equal(combo[0].role, "primary");
  assert.equal(combo[0].modelId, topRanked.modelId);
  assert.ok(
    combo
      .filter((pick) => pick.role !== "advanced")
      .every((pick) => isModelFinderDefaultId(pick.modelId))
  );
});

test("a research-and-sources answer includes an advanced research add-on", () => {
  const combo = getModelFinderCombination({
    tasks: ["research"],
    priority: "sources",
  });
  const advanced = combo.find((pick) => pick.role === "advanced");
  assert.equal(advanced?.modelId, "perplexity/sonar");
  assert.equal(advanced?.reasonKey, "modelFinder.optionalResearch");
});

test("complementary suggestion fills the missing capability in priority order", () => {
  // deepseek-r1 was the reasoning suggestion until DeepSeek retired
  // deepseek-reasoner; the slot now falls through to the next live model in
  // REASONING_SUGGESTION_ORDER rather than disappearing.
  const noReasoningOrResearch = getComplementaryModelSuggestion([
    "gpt-5-4-mini",
    "gemini-2-5-flash",
  ]);
  assert.deepEqual(noReasoningOrResearch, {
    modelId: "grok-4-5",
    reason: "reasoning",
  });

  const hasReasoningOnly = getComplementaryModelSuggestion([
    "grok-4-5",
    "gemini-2-5-flash",
  ]);
  assert.deepEqual(hasReasoningOnly, {
    modelId: "perplexity/sonar",
    reason: "research",
  });

  const hasReasoningAndResearch = getComplementaryModelSuggestion([
    "grok-4-5",
    "perplexity/sonar",
  ]);
  // Tracks the head of STANDARD_CANDIDATE_ORDER, which gpt-5-6-luna took
  // over from gpt-5-4-mini when it became the app default.
  assert.deepEqual(hasReasoningAndResearch, {
    modelId: "gpt-5-6-luna",
    reason: "different_provider",
  });
});

test("complementary suggestion never re-suggests an already-selected model", () => {
  const suggestion = getComplementaryModelSuggestion([
    "grok-4-5",
    "deepseek-v4-flash",
  ]);
  assert.equal(suggestion?.modelId, "perplexity/sonar");
  assert.notEqual(suggestion?.modelId, "grok-4-5");
  assert.notEqual(suggestion?.modelId, "deepseek-v4-flash");
});

// The Router used to rank from this file's tables. It no longer does -- it has
// its own versioned policy in lib/routerScorePolicy.ts, over every enabled
// model rather than these six. This is the test that makes the separation
// real: the wizard's answer to every question it can be asked must be
// identical to what it was before the split, or the split changed a product
// recommendation while claiming to be a refactor.
//
// A hash rather than 756 inlined expectations, because what is being asserted
// is that *nothing* moved, and a reviewer cannot check 756 lists by eye. When
// it fails, print the two and diff them.
//
// Two legitimate reasons for it to fail, and they need different responses:
//
//   - the catalogue changed. `isModelFinderDefaultId` reads enablement, plan
//     and usage category, so retiring a Standard model really does change what
//     this wizard recommends. Re-record the hash as part of that change.
//   - a scoring table or the candidate order changed. That is a product
//     decision about onboarding, and it should be made on purpose.
//
// What it must never be is collateral from a routing change.
test("the wizard's output is unchanged over every combination of answers", () => {
  const taskSubsets = [];
  for (let mask = 1; mask < 1 << MODEL_FINDER_TASKS.length; mask += 1) {
    taskSubsets.push(
      MODEL_FINDER_TASKS.filter((_, index) => (mask & (1 << index)) !== 0)
    );
  }

  const lines = [];
  for (const tasks of taskSubsets) {
    for (const priority of MODEL_FINDER_PRIORITIES) {
      for (const fileUsage of MODEL_FINDER_FILE_USAGE) {
        const answers = { tasks, priority, fileUsage };
        lines.push(
          JSON.stringify({
            answers,
            recommendations: getModelFinderRecommendations(answers),
            optional: getOptionalModelSuggestion(answers),
            promptKey: getModelFinderPromptKey(answers),
            combination: getModelFinderCombination({ tasks, priority }),
          })
        );
      }
    }
  }

  // Every non-empty subset of the six tasks, times four priorities, times
  // three file-usage answers. Pinned so a table gaining or losing a task shows
  // up here rather than silently shrinking the coverage this test claims.
  assert.equal(lines.length, 756);
  assert.equal(
    createHash("sha256").update(lines.join("\n")).digest("hex"),
    "bf0a0651835eb5b228fd763c06c27cd1fba6a36f0f9f7f6f0d9dd58384a358ee",
    "the model finder's recommendations changed"
  );
});

// The scores are still curation, and still this file's alone. A routing import
// would put them back where they were: shared, they could not change for one
// consumer without changing the other, and the Router's ceiling would again be
// whichever six models the onboarding wizard happens to list.
//
// Imports rather than mentions, so a file may still *explain* the split. That
// is the difference between reading the table and describing it.
test("nothing outside the model finder imports its scoring tables", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const path = await import("node:path");
  const roots = ["lib", "app", "components", "scripts"];
  const guarded = ["MODEL_FINDER_SCORES", "STANDARD_CANDIDATE_ORDER"];
  const offenders = [];

  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mjs)$/.test(entry.name)) continue;
      if (full.endsWith(path.join("lib", "modelFinder.ts"))) continue;
      const source = readFileSync(full, "utf8");
      for (const match of source.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s+"([^"]*modelFinder[^"]*)"/g
      )) {
        const named = match[1];
        if (guarded.some((identifier) => named.includes(identifier))) {
          offenders.push(full);
        }
      }
    }
  };
  for (const root of roots) walk(path.join(process.cwd(), root));

  assert.deepEqual(
    offenders,
    [],
    "MODEL_FINDER_SCORES and STANDARD_CANDIDATE_ORDER are static product " +
      "curation for the onboarding wizard. Routing reads " +
      "lib/routerScorePolicy.ts, which is versioned and covers every enabled model."
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTEMPT_BOUND_FIELDS,
  attemptDispatchOptions,
  attemptRefusalError,
  attemptUsageCaptureKey,
  planAttemptExecution,
} from "../lib/chatAttemptExecution.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";
import { createTokenEstimateAccumulator } from "../lib/chatTokenEstimate.ts";

// §9.1: "the closure also holds modelConfig, generationSettings,
// webSearchToolConfig, requestMaxOutputTokens ... all bound to the primary.
// Leaving any of them would record or bill the fallback as the primary."
//
// The property these tests are after is not that a plan is correct -- the
// helpers it calls have their own tests -- but that a plan for one model
// contains nothing of another's.

const enabled = AVAILABLE_MODELS.filter((model) => model.enabled !== false);
const modelOf = (provider) => enabled.find((model) => model.provider === provider);

const realBreakdown = () => {
  const accumulator = createTokenEstimateAccumulator();
  accumulator.addText("user", "hello there, this is a question about routing");
  return accumulator.breakdown();
};

const request = (overrides = {}) => ({
  accessKind: "user",
  inputBreakdown: 1000,
  webSearchMode: "off",
  traceId: "trace-1",
  attemptIndex: 0,
  ...overrides,
});

const planFor = (model, overrides) => {
  const result = planAttemptExecution(model, request(overrides));
  assert.equal(result.ok, true, `expected a plan for ${model.id}`);
  return result.plan;
};

test("every attempt-bound field is produced per attempt, not captured once", () => {
  // The list is the point: the failure this guards is *forgetting* one when
  // the fallback is wired up, and a forgotten one bills the fallback as the
  // primary. Two surfaces carry them -- the plan, and the options a dispatch
  // is built from -- and a field must appear on one of them.
  const plan = planFor(enabled[0]);
  const options = attemptDispatchOptions(plan);
  for (const field of ATTEMPT_BOUND_FIELDS) {
    assert.ok(
      field in plan || field in options,
      `${field} is named attempt-bound but nothing produces it per attempt`
    );
  }
});

test("two models' plans agree on nothing that identifies a model", () => {
  const first = enabled[0];
  const second = enabled.find(
    (model) => model.provider !== first.provider && model.id !== first.id
  );
  assert.ok(second, "the catalog needs two providers for this test to mean anything");

  const a = planFor(first);
  const b = planFor(second);

  assert.notEqual(a.modelId, b.modelId);
  assert.notEqual(a.provider, b.provider);
  assert.notEqual(a.activeModel, b.activeModel);
  assert.notEqual(a.budget, b.budget);
  // The price snapshot is the field a fallback settled through the primary's
  // reservation would get wrong.
  assert.equal(a.budget.modelId, first.id);
  assert.equal(b.budget.modelId, second.id);
  assert.equal(a.budget.provider, first.provider);
  assert.equal(b.budget.provider, second.provider);
});

test("a plan is a pure function of its model and request", () => {
  const model = enabled[0];
  const a = planFor(model);
  const b = planFor(model);
  assert.equal(a.modelId, b.modelId);
  assert.equal(a.maxOutputTokens, b.maxOutputTokens);
  assert.deepEqual(a.generationSettings, b.generationSettings);
});

test("the output ceiling is fitted to the model's own window", () => {
  const windows = new Map();
  for (const model of enabled) {
    const result = planAttemptExecution(model, request());
    if (!result.ok) continue;
    windows.set(model.id, result.plan.maxOutputTokens);
  }
  // Not every model has a different ceiling, but a single value across the
  // whole catalog would mean the window was never consulted.
  assert.ok(new Set(windows.values()).size > 1);
});

test("the dispatch options carry the plan's model settings and nothing else", () => {
  const plan = planFor(enabled[0]);
  const options = attemptDispatchOptions(plan);
  assert.equal(options.maxOutputTokens, plan.maxOutputTokens);
  for (const [key, value] of Object.entries(plan.generationSettings)) {
    assert.deepEqual(options[key], value);
  }
});

test("zhipu keeps its retries off, and only zhipu", () => {
  // The SDK retries internally on failures this application records itself.
  for (const model of enabled) {
    const result = planAttemptExecution(model, request());
    if (!result.ok) continue;
    const options = attemptDispatchOptions(result.plan);
    assert.equal(
      options.maxRetries,
      model.provider === "zhipu" ? 0 : undefined,
      model.id
    );
  }
});

// Perplexity buffers response bodies per key and consuming a capture releases
// it. Two attempts under one key would hand the second reader the first
// attempt's body, or nothing.
test("every attempt captures provider usage under its own key", () => {
  assert.equal(attemptUsageCaptureKey("trace-1", 0), "trace-1");
  assert.notEqual(
    attemptUsageCaptureKey("trace-1", 1),
    attemptUsageCaptureKey("trace-1", 0)
  );
  assert.notEqual(
    attemptUsageCaptureKey("trace-1", 2),
    attemptUsageCaptureKey("trace-1", 1)
  );
});

test("the primary's capture key is the bare trace id, so nothing existing moves", () => {
  const plan = planFor(enabled[0], { attemptIndex: 0 });
  assert.equal(plan.usageCaptureKey, "trace-1");
});

test("a perplexity fallback sends its own capture header", () => {
  const perplexity = modelOf("perplexity");
  if (!perplexity) return;
  const primary = attemptDispatchOptions(planFor(perplexity, { attemptIndex: 0 }));
  const fallback = attemptDispatchOptions(planFor(perplexity, { attemptIndex: 1 }));
  assert.ok(primary.headers);
  assert.notDeepEqual(primary.headers, fallback.headers);
});

test("a model that cannot hold the conversation is a refusal, not a throw", () => {
  // §6: a fallback candidate that fails its own token check is one candidate
  // that did not qualify, not the request failing. A thrown error would make
  // the caller catch an error class to take a routing decision.
  const model = enabled.reduce((smallest, candidate) =>
    (candidate.contextWindowTokens ?? Infinity) <
    (smallest.contextWindowTokens ?? Infinity)
      ? candidate
      : smallest
  );
  const result = planAttemptExecution(
    model,
    request({ inputBreakdown: (model.contextWindowTokens ?? 8000) * 4 })
  );
  assert.equal(result.ok, false);
  assert.ok(
    ["context_window_exceeded", "budget_refused"].includes(result.refusal.kind)
  );
});

test("a refusal converts back to the error the primary path has always raised", () => {
  const error = attemptRefusalError({
    kind: "context_window_exceeded",
    modelId: "m",
    modelName: "A Model",
    limitTokens: 128000,
  });
  assert.equal(error.status, 400);
  assert.equal(error.code, "MODEL_CONTEXT_WINDOW_EXCEEDED");
  assert.match(error.message, /128,000 tokens/);
});

test("web search is off unless the turn asked for it and the model can", () => {
  for (const model of enabled) {
    const off = planAttemptExecution(model, request({ webSearchMode: "off" }));
    if (!off.ok) continue;
    assert.equal(off.plan.nativeSearchEnabled, false, model.id);
    assert.equal(off.plan.webSearchToolConfig, null, model.id);
  }
});

test("a search-capable model asked to search gets its own tool config", () => {
  const searching = enabled
    .map((model) => planAttemptExecution(model, request({ webSearchMode: "always" })))
    .filter((result) => result.ok && result.plan.nativeSearchEnabled);
  assert.ok(
    searching.length > 0,
    "no model produced a native search config; the fixture no longer exercises this"
  );
  for (const result of searching) {
    assert.ok(result.plan.webSearchToolConfig);
    const options = attemptDispatchOptions(result.plan);
    assert.ok(options.tools);
  }
});

test("the breakdown shape the route passes is accepted", () => {
  // The route hands `inputEstimate.breakdown()`, not a bare number.
  const result = planAttemptExecution(enabled[0], request({ inputBreakdown: realBreakdown() }));
  assert.equal(result.ok, true);
});

// A plan says whether its attempt can actually search, and refuses when the
// caller required one and it cannot. The Router's filter answers "may this
// model search"; this answers "will this dispatch search", which is a
// different fact and was never checked.

const modelById = (id) => {
  const model = enabled.find((entry) => entry.id === id);
  assert.ok(model, `${id} is expected to be enabled in the catalogue`);
  return model;
};

test("a plan reports the search path its own dispatch will have", () => {
  // Perplexity searches as part of ordinary completion, whatever the mode.
  assert.deepEqual(
    planFor(modelById("perplexity/sonar"), { webSearchMode: "off" }).searchPath,
    { kind: "search_model" }
  );

  // A native model with the mode on carries the tool and the surcharge.
  const native = planFor(modelById("gpt-5-6-luna"), { webSearchMode: "always" });
  assert.deepEqual(native.searchPath, { kind: "native_tool" });
  assert.ok(native.webSearchToolConfig);
  assert.ok(native.searchSurchargeCredits > 0);

  // The same model with the mode off carries neither, and says which.
  const idle = planFor(modelById("gpt-5-6-luna"), { webSearchMode: "off" });
  assert.deepEqual(idle.searchPath, { kind: "none", gap: "mode_not_always" });
  assert.equal(idle.webSearchToolConfig, null);
});

test("the tool configuration a plan reports is the one it will dispatch", () => {
  // Rebuilt rather than read, the check could pass for a request that carried
  // no tools -- which is the whole failure it exists to catch.
  const plan = planFor(modelById("gpt-5-6-luna"), { webSearchMode: "always" });
  const options = attemptDispatchOptions(plan);
  assert.equal(plan.searchPath.kind, "native_tool");
  assert.ok(options.tools, "a native_tool plan must dispatch tools");
});

test("a candidate with no search path is refused when one was required", () => {
  // `docs/policy/tomverse-chat-routing.md` §10, read in the direction it
  // usually is not: a fallback may not silently change what the user was going
  // to get. A searching turn continued on a model that answers from training
  // data is a different answer, not a substitute.
  const result = planAttemptExecution(
    modelById("deepseek-v4-flash"),
    request({ webSearchMode: "always", requireSearchPath: true })
  );
  assert.equal(result.ok, false);
  assert.equal(result.refusal.kind, "search_path_unavailable");
  assert.equal(result.refusal.modelId, "deepseek-v4-flash");
  assert.equal(result.refusal.gap, "capability_unsupported");
});

test("requiring a search path accepts either kind of path", () => {
  for (const [modelId, webSearchMode] of [
    ["perplexity/sonar", "off"],
    ["gpt-5-6-luna", "always"],
  ]) {
    const result = planAttemptExecution(
      modelById(modelId),
      request({ webSearchMode, requireSearchPath: true })
    );
    assert.equal(result.ok, true, modelId);
  }
});

test("nothing is refused on the axis by default", () => {
  // Most turns do not need the web, and refusing on an axis the turn never
  // used would only lose the answer. The flag is opt-in for that reason.
  const result = planAttemptExecution(
    modelById("deepseek-v4-flash"),
    request({ webSearchMode: "off" })
  );
  assert.equal(result.ok, true);
  assert.equal(result.plan.searchPath.kind, "none");
});

test("the refusal maps to an error rather than falling through to a plan", () => {
  const refusal = {
    kind: "search_path_unavailable",
    modelId: "deepseek-v4-flash",
    gap: "capability_unsupported",
  };
  const error = attemptRefusalError(refusal);
  assert.equal(error.status, 503);
  assert.equal(error.code, "MODEL_WEB_SEARCH_UNAVAILABLE");
  // Content-free: the message names no model and no request text.
  assert.ok(!error.message.includes("deepseek"));
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  getWebSearchCapability,
  modelWebSearchIsDispatchable,
  nativeSearchIsDispatchable,
  openAiNativeSearchToolCallCeiling,
  webSearchIsDispatchable,
  WEB_SEARCH_CAPABILITIES,
} from "../lib/webSearchCapability.ts";
import { deriveWebSearchComposerState } from "../lib/webSearchComposerState.ts";
import { estimateRequestCredits } from "../lib/webSearchCredits.ts";
import { getModel, PUBLIC_MODELS } from "../lib/models.ts";
import {
  searchProviderBucketKey,
  searchProviderBudgetEnvName,
} from "../lib/searchProviderBudget.ts";
import { PROVIDER_BUCKET_PREFIX } from "../lib/chatProviderHolds.ts";
import {
  classifyChatLimitCode,
  SEARCH_PROVIDER_BUDGET_EXHAUSTED,
} from "../lib/chatCostSafetyCore.ts";

// Provider capability and operational dispatchability are two different facts,
// and the incident that produced this file is what happens when one surface
// answers the first while behaving as though it had answered the second.
//
// `gpt-5-6-luna` is registered as an OpenAI native-search model. Its
// capability declared no per-request query ceiling, so `reserveNativeSearchCost`
// refused it -- but the composer counted it as search-ready, the credit
// estimate charged the surcharge, and preflight and availability reported the
// request runnable. Everything said yes except the one place that spends
// money, and the user got a 503 on a control four surfaces had told them to
// use.
//
// The rule these tests hold: every surface asks `nativeSearchIsDispatchable`,
// so nothing is ever offered that the reservation would refuse.

const ROOT = resolve(import.meta.dirname, "..");
const source = (relativePath) =>
  readFileSync(resolve(ROOT, relativePath), "utf8");

test("dispatchability is capability AND an enforceable per-request ceiling", () => {
  // Native and free of a per-query charge: nothing to bound.
  assert.equal(
    nativeSearchIsDispatchable({ support: "native", hasAdditionalCost: false }),
    true
  );
  // Native, paid per query, ceiling declared: bounded, so dispatchable.
  assert.equal(
    nativeSearchIsDispatchable({
      support: "native",
      hasAdditionalCost: true,
      maxBillableSearchQueriesPerRequest: 5,
    }),
    true
  );
  // Native, paid per query, no ceiling: the worst case is "as many as the
  // model decides", which no reservation covers.
  assert.equal(
    nativeSearchIsDispatchable({ support: "native", hasAdditionalCost: true }),
    false
  );
  assert.equal(
    nativeSearchIsDispatchable({
      support: "native",
      hasAdditionalCost: true,
      maxBillableSearchQueriesPerRequest: 0,
    }),
    false
  );
  // Not native at all.
  for (const support of ["search-model", "unverified", "unsupported"]) {
    assert.equal(
      nativeSearchIsDispatchable({ support, hasAdditionalCost: false }),
      false,
      support
    );
  }
  // A search model searches inside its own completion at no separate charge,
  // so it is dispatchable by the other route.
  assert.equal(
    webSearchIsDispatchable({ support: "search-model", hasAdditionalCost: false }),
    true
  );
});

test("Luna and every OpenAI native-search model is dispatchable; Gemini is not", () => {
  for (const id of [
    "gpt-5-6-luna",
    "gpt-5-6-sol",
    "gpt-5-6-terra",
    "gpt-5-5",
    "gpt-5-5-thinking",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-haiku-4-5",
    "perplexity/sonar",
  ]) {
    assert.equal(modelWebSearchIsDispatchable(id), true, id);
  }
  for (const id of [
    "gemini-3-7-flash",
    "gemini-3-6-flash",
    "gemini-3-5-flash",
    "gemini-3-1-pro",
    "gemini-2-5-flash",
    "gpt-5-4-mini",
    "codestral",
  ]) {
    assert.equal(modelWebSearchIsDispatchable(id), false, id);
  }
});

test("the composer's supported count and surcharge agree with dispatchability", () => {
  // One number, two ways of arriving at it. The chip promises a search and the
  // surcharge charges for one; if they could disagree, one of them is lying.
  const selection = [
    "gpt-5-6-luna",
    "claude-sonnet-5",
    "gemini-3-6-flash",
    "codestral",
  ];
  const state = deriveWebSearchComposerState({
    webSearchMode: "always",
    selectedModelIds: selection,
  });
  const dispatchable = selection.filter(modelWebSearchIsDispatchable);
  assert.equal(state.supportedCount, dispatchable.length);
  assert.equal(state.supportedCount, 2);
  assert.deepEqual(state.unsupportedModelIds, ["gemini-3-6-flash", "codestral"]);

  const estimate = estimateRequestCredits({
    models: selection.map(getModel),
    estimatedInputTokens: 100,
    webSearchMode: "always",
  });
  assert.equal(
    estimate.webSearchReservationCredits,
    state.estimatedSurchargeCredits,
    "the composer quotes what the request will reserve"
  );
  assert.equal(
    estimate.models.filter((entry) => entry.nativeSearchEligible).length,
    2,
    "only the two dispatchable native models are surcharged"
  );
});

test("the mixed and all-unsupported composer contracts survive the narrowing", () => {
  // Mixed: a warning with the exception named, not a block -- the dispatchable
  // models still search and the rest answer without one.
  const mixed = deriveWebSearchComposerState({
    webSearchMode: "always",
    selectedModelIds: ["gpt-5-6-luna", "gemini-3-6-flash"],
  });
  assert.equal(mixed.tone, "warning");
  assert.equal(mixed.hasException, true);
  assert.equal(mixed.allUnsupported, false);
  assert.deepEqual(mixed.unsupportedModelIds, ["gemini-3-6-flash"]);

  // Every selected model undispatchable: blocked, so the composer states the
  // problem before the send rather than after it.
  const blocked = deriveWebSearchComposerState({
    webSearchMode: "always",
    selectedModelIds: ["gemini-3-6-flash", "gemini-3-1-pro"],
  });
  assert.equal(blocked.tone, "blocked");
  assert.equal(blocked.allUnsupported, true);
  assert.equal(blocked.supportedCount, 0);
  assert.equal(blocked.estimatedSurchargeCredits, 0);

  // Auto only offers a search, so an undispatchable model is not an exception
  // the user has to resolve before sending.
  const auto = deriveWebSearchComposerState({
    webSearchMode: "auto",
    selectedModelIds: ["gemini-3-6-flash"],
  });
  assert.equal(auto.tone, "neutral");
  assert.equal(auto.hasException, false);
});

test("the tool-call ceiling is sent only on a searching OpenAI turn", () => {
  const luna = getWebSearchCapability("gpt-5-6-luna");
  assert.equal(
    openAiNativeSearchToolCallCeiling({
      capability: luna,
      nativeSearchEnabled: true,
    }),
    5
  );
  assert.equal(
    openAiNativeSearchToolCallCeiling({
      capability: luna,
      nativeSearchEnabled: false,
    }),
    undefined,
    "a turn with web search off bounds no built-in tool calls, so it sends no bound"
  );
  // Anthropic's ceiling rides on the tool (`maxUses`), not on the request.
  assert.equal(
    openAiNativeSearchToolCallCeiling({
      capability: getWebSearchCapability("claude-sonnet-5"),
      nativeSearchEnabled: true,
    }),
    undefined
  );
  // Google has no parameter to send, which is exactly why it is undispatchable.
  assert.equal(
    openAiNativeSearchToolCallCeiling({
      capability: getWebSearchCapability("gemini-3-6-flash"),
      nativeSearchEnabled: true,
    }),
    undefined
  );
});

test("no surface decides search capability from `support` alone", () => {
  // The audited consumers, by name. Each one had -- or could have had -- its
  // own `support === "native"`, and each such copy is a place the four
  // surfaces can disagree with the dispatch again.
  const audited = [
    "lib/webSearchComposerState.ts",
    "lib/webSearchCredits.ts",
    "lib/webSearchExecutionNormalizer.ts",
    "lib/chatAttemptExecution.ts",
    "lib/routerCandidates.ts",
    "lib/modelPickerPresentation.ts",
    "components/chat/ChatMessageList.tsx",
    "app/api/chat/route.ts",
    "app/api/chat/preflight/route.ts",
    "app/api/chat/availability/route.ts",
  ];
  for (const path of audited) {
    const text = source(path)
      // Prose is allowed to discuss the old rule; code is not.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.equal(
      /support\s*===\s*"native"/.test(text),
      false,
      `${path}: read dispatchability through nativeSearchIsDispatchable, not through \`support\``
    );
  }
});

test("every route that budgets a turn also reserves that turn's search cost", () => {
  // Three routes price the same request, and a route that skipped the
  // reservation quoted the token half of a searching turn and none of the
  // per-query half -- so it admitted requests against a provider budget
  // smaller than the one they spend against.
  for (const path of [
    "app/api/chat/route.ts",
    "app/api/chat/preflight/route.ts",
    "app/api/chat/availability/route.ts",
  ]) {
    const text = source(path);
    // Both vendors, in one call. Three routes price the same request, and a
    // route that reserved only one half quoted a searching turn against a
    // budget smaller than the one it spends against -- which is the defect this
    // check was written for. `reserveTurnSearchCost` returns the pair, so a
    // route cannot reserve one and forget the other.
    assert.ok(
      text.includes("reserveTurnSearchCost("),
      `${path}: must reserve this turn's search cost before budgeting`
    );
    assert.ok(
      /nativeSearch:\s*nativeSearchReservation\.native/.test(text),
      `${path}: must carry the provider-native half into createChatBudget`
    );
    assert.ok(
      /searchBackend:\s*nativeSearchReservation\.searchBackend/.test(text),
      `${path}: must carry the search vendor's half into createChatBudget`
    );
  }
});

test("the search vendor's spend never lands in the model provider's bucket", () => {
  // Two invoices, two buckets (docs/policy/credit-and-cost-limits.md). A Brave
  // charge counted under `provider:google` would tell an operator Google was
  // overspending while the vendor whose invoice actually grew stayed invisible
  // to the budget that exists to bound it.
  assert.equal(searchProviderBucketKey("brave"), "search-provider:brave");
  assert.ok(
    !searchProviderBucketKey("brave").startsWith(PROVIDER_BUCKET_PREFIX),
    "a search bucket must not be readable as a provider bucket"
  );
  // And the reverse: the provider-bucket prefix must not swallow the search
  // one, or settlement would hand a search entry a model provider's cost.
  assert.ok(!PROVIDER_BUCKET_PREFIX.startsWith("search-"));
});

test("the search backend budget is named apart from the chat provider budget", () => {
  // Names, error codes and metrics stay separate: an operator told
  // "PROVIDER_BUDGET_EXHAUSTED" would go and look at the wrong budget.
  assert.equal(
    searchProviderBudgetEnvName("brave", "day"),
    "SEARCH_PROVIDER_BRAVE_COST_MICROUSD_PER_DAY"
  );
  assert.equal(
    searchProviderBudgetEnvName("brave", "month"),
    "SEARCH_PROVIDER_BRAVE_COST_MICROUSD_PER_MONTH"
  );
  assert.notEqual(
    SEARCH_PROVIDER_BUDGET_EXHAUSTED,
    "PROVIDER_BUDGET_EXHAUSTED"
  );
  // Still an operational guardrail, so the UI keeps talking about a temporary
  // internal hold rather than about the user's credits.
  assert.equal(
    classifyChatLimitCode(SEARCH_PROVIDER_BUDGET_EXHAUSTED),
    "operational_guardrail"
  );
});

test("nothing native is priced without either a ceiling or a way to refuse it", () => {
  // A standing check on the register itself: adding a native capability that
  // charges per query and declares no ceiling is allowed -- Google is one --
  // but it must fall out as undispatchable rather than as a model surfaces
  // will offer.
  for (const [modelId, capability] of Object.entries(WEB_SEARCH_CAPABILITIES)) {
    if (capability.support !== "native") continue;
    if (!capability.hasAdditionalCost) continue;
    if (capability.maxBillableSearchQueriesPerRequest) continue;
    assert.equal(
      nativeSearchIsDispatchable(capability),
      false,
      `${modelId}: an unbounded paid search must never read as dispatchable`
    );
  }
  // And the catalogue as a whole resolves without throwing.
  for (const model of PUBLIC_MODELS) {
    assert.equal(typeof modelWebSearchIsDispatchable(model.id), "boolean");
  }
});

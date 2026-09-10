import assert from "node:assert/strict";
import test from "node:test";

import { decideRouterModel } from "../lib/routerDecision.ts";
import {
  diagnoseFullCatalog,
  FALLBACK_UNVERIFIED_CONDITIONS,
  fallbackReachabilityFor,
  ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION,
} from "../lib/routerFullCatalogDiagnostic.ts";
import { decideFallback } from "../lib/routingFallbackPolicy.ts";
import { CANDIDATE_REJECTIONS } from "../lib/routerCandidates.ts";
import { NEUTRAL_QUALITY_BAND, ROUTER_TIE_BREAK_ORDER } from "../lib/routerScorePolicy.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";
import { toReservedInputTokens } from "../lib/chatTokenEstimate.ts";
import { NO_WEB_SEARCH_BACKENDS } from "../lib/webSearchBackends.ts";

/**
 * The diagnostic is an explanation of the product's decision, not a second
 * decision. What these tests hold is that it never disagrees with the product
 * on the same input, that every model in the catalogue is accounted for with
 * a fixed reason when refused, that an unmeasured model is reported as
 * unmeasured rather than scored, and that the cap the Router routed under is
 * reported beside the cap dispatch will apply rather than reconciled with it.
 */

const model = (id, overrides = {}) => ({
  id,
  name: id,
  apiModel: id,
  provider: "openai",
  icon: "",
  bestFor: "",
  minimumPlan: "Guest",
  usageClass: "standard",
  enabled: true,
  status: "available",
  contextWindowTokens: 100_000,
  maxOutputTokens: 4_000,
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 1,
  ...overrides,
});

const catalogue = () => [
  model("cheap", { inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.1 }),
  model("mid", { maxOutputTokens: 16_000 }),
  model("dear", { inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 10 }),
  model("off", { enabled: false, status: "disabled" }),
  model("paid", { minimumPlan: "Pro" }),
  model("nowindow", { contextWindowTokens: undefined }),
];

const items = () => [
  { id: "i-1", cell: "en", stratum: "general_question_answering", prompt: "What is a mortgage?" },
  { id: "i-2", cell: "en", stratum: "coding", prompt: "Fix this TypeScript function:\n```ts\nconst f = () => {}\n```" },
];

const base = (overrides = {}) => ({
  items: items(),
  models: catalogue(),
  plan: "Free",
  requestedModelId: "mid",
  searchBackendReadiness: NO_WEB_SEARCH_BACKENDS,
  now: () => 0,
  ...overrides,
});

test("every catalogue model appears on every item, and a refused one carries a declared reason", () => {
  const report = diagnoseFullCatalog(base());
  assert.equal(report.version, ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION);
  assert.equal(report.items.length, 2);
  for (const item of report.items) {
    assert.deepEqual(
      item.models.map((row) => row.modelId),
      catalogue().map((entry) => entry.id),
      "catalogue order, nothing missing"
    );
    for (const row of item.models) {
      if (row.disposition === "rejected") {
        assert.ok(CANDIDATE_REJECTIONS.includes(row.rejectionReason), `${row.modelId}: ${row.rejectionReason}`);
        assert.equal(row.rank, null);
      } else {
        assert.equal(row.rejectionReason, null);
        assert.ok(row.rank >= 1);
      }
    }
    const byId = Object.fromEntries(item.models.map((row) => [row.modelId, row]));
    assert.equal(byId.off.rejectionReason, "disabled");
    assert.equal(byId.paid.rejectionReason, "plan");
    assert.equal(byId.nowindow.rejectionReason, "context_window_undeclared");
  }
  assert.deepEqual(
    report.summary.neverEligible.map((entry) => entry.modelId).sort(),
    ["nowindow", "off", "paid"]
  );
});

test("the diagnostic agrees with the product's own decision on the same input", () => {
  const report = diagnoseFullCatalog(base());
  const cap = resolveModelPricing(catalogue()[1]).maxOutputTokens;
  for (const [index, item] of report.items.entries()) {
    const source = items()[index];
    const product = decideRouterModel(
      {
        text: source.prompt,
        attachments: [],
        webSearchRequested: false,
        models: catalogue(),
        plan: "Free",
        searchBackendReadiness: NO_WEB_SEARCH_BACKENDS,
        reservedInputTokens: item.caps.routerReservedInputTokens,
        requestOutputCapTokens: cap,
        sticky: null,
      },
      () => 0
    );
    assert.equal(product.outcome, "selected");
    assert.equal(item.decision.primaryModelId, product.modelId);
    assert.deepEqual(item.decision.rankedModelIds, [product.modelId, ...product.fallbackCandidateModelIds]);
    assert.deepEqual(item.decision.fallbackCandidateModelIds, product.fallbackCandidateModelIds);
    assert.deepEqual(
      item.models.filter((row) => row.rejectionReason !== null).map((row) => ({ modelId: row.modelId, reason: row.rejectionReason })),
      product.record.rejections
    );
    assert.equal(item.decision.decidedBy, product.record.selectionDecidedBy);
    assert.equal(item.consistency.agreesWithProduct, true, item.consistency.problems.join("; "));
    assert.equal(item.caps.primary.routerOutputTokens, product.outputTokens);
  }
  assert.equal(report.summary.consistencyProblems, 0);
  assert.deepEqual(report.problems, []);
});

test("the cost tie-break picks the cheapest, and every loser says which criterion it lost on", () => {
  const report = diagnoseFullCatalog(base());
  const item = report.items[0];
  assert.equal(item.decision.primaryModelId, "cheap");
  assert.equal(item.decision.decidedBy, "expected_total_cost");
  assert.equal(item.decision.selectionReason, "fallback_order");
  for (const row of item.models) {
    if (row.disposition !== "fallback_candidate") continue;
    assert.ok(ROUTER_TIE_BREAK_ORDER.includes(row.versusPrimary.decidedBy));
    assert.equal(row.versusPrimary.wouldBeatPrimary, false);
    assert.ok(row.expectedTotalCostUsd > item.models.find((m) => m.modelId === "cheap").expectedTotalCostUsd);
  }
  assert.equal(report.summary.pairwiseInversions, 0);
});

test("an unmeasured model is reported at the neutral band with no evidence, never at zero and never promoted", () => {
  const report = diagnoseFullCatalog(base());
  for (const item of report.items) {
    for (const row of item.models) {
      assert.equal(row.quality.band, NEUTRAL_QUALITY_BAND);
      assert.equal(row.quality.evidenceRef, null);
      assert.equal(row.quality.status, "no_evidence");
    }
    assert.deepEqual(item.evidence.eligibleWithEvidence, []);
    assert.equal(item.evidence.decidedWithoutQualityEvidence, true);
  }
  assert.equal(report.summary.evidenceCells.withEvidence, 0);
  assert.ok(report.improvementCandidates.some((c) => c.kind === "no_quality_evidence_for_kind"));
  // Nothing here writes a band: the policy module is read, not edited.
  assert.ok(!report.improvementCandidates.some((c) => c.detail.includes("promote")));
});

test("the Router's output cap and dispatch's are both reported, and a difference is named rather than hidden", () => {
  // Routed under `mid`'s cap of 16,000; the primary `cheap` dispatches under
  // its own 4,000. The Router fitted every candidate to 16,000 output tokens
  // and dispatch will hand `cheap` 4,000.
  const report = diagnoseFullCatalog(base());
  const item = report.items[0];
  assert.equal(report.inputs.routerRequestOutputCapTokens, 16_000);
  assert.equal(item.caps.primary.modelId, "cheap");
  assert.equal(item.caps.primary.routerOutputTokens, 16_000);
  assert.equal(item.caps.primary.dispatchRequestOutputCapTokens, 4_000);
  assert.equal(item.caps.primary.dispatchOutputTokens, 4_000);
  assert.equal(item.caps.primary.outputCapDiffers, true);
  assert.equal(report.summary.outputCapMismatchItems, 2);
  assert.ok(report.improvementCandidates.some((c) => c.kind === "output_cap_mismatch"));

  // Routed under the primary's own cap, the two agree and nothing is flagged.
  const aligned = diagnoseFullCatalog(base({ requestedModelId: "cheap" }));
  assert.equal(aligned.items[0].caps.primary.outputCapDiffers, false);
  assert.equal(aligned.summary.outputCapMismatchItems, 0);
});

test("fallback is reachable only when the gate, the product's own decision and dispatch all say yes; as deployed the gate says no", () => {
  const report = diagnoseFullCatalog(base());
  const item = report.items[0];
  assert.deepEqual(item.fallback.scopeAsDeployed, { allowed: false, reason: "flag_off" });
  assert.deepEqual(item.fallback.scopeIfFlagOn, { allowed: true });
  assert.equal(item.fallback.maxModelFallbacks, 1);
  const first = item.decision.fallbackCandidateModelIds[0];
  assert.ok(first, "the catalogue leaves a candidate behind the primary");
  // decideFallback -- the product's function, asked under the stated
  // hypothesis -- names the Router's next candidate, and is recorded as it
  // answered, version included.
  const policyVersion = decideFallback({
    attempt: { modelId: "x", outcome: "failed_pre_token", failureLayer: "provider", providerRefusal: null },
    run: { passThroughUsed: false, rerouteCount: 0, visibleTokenEmitted: false },
    nextCandidateModelIds: [],
  }).version;
  assert.deepEqual(item.fallback.decision, { version: policyVersion, action: "fallback", modelId: first, reason: null });
  // The candidate is listed as what it is: named by the decision, re-fitted
  // by dispatch. That is not the same as reachable.
  assert.equal(item.fallback.firstCandidate.modelId, first);
  assert.equal(item.fallback.firstCandidate.dispatchFit, "fitted");
  assert.deepEqual(item.fallback.reachableAsDeployed, { reachable: false, refusal: "gate:flag_off" });
  assert.equal(item.fallback.reachableIfFlagOn.reachable, true);
  assert.equal(item.fallback.reachableIfFlagOn.modelId, first);
  // A reachable answer carries what only a real dispatch could still refuse.
  assert.deepEqual(item.fallback.reachableIfFlagOn.unverifiedConditions, FALLBACK_UNVERIFIED_CONDITIONS);
  assert.ok(FALLBACK_UNVERIFIED_CONDITIONS.some((line) => line.startsWith("search_path_unavailable")));
  assert.ok(FALLBACK_UNVERIFIED_CONDITIONS.some((line) => line.startsWith("budget_refused")));
  assert.ok(FALLBACK_UNVERIFIED_CONDITIONS.some((line) => line.startsWith("candidate_unavailable")));
  assert.ok(FALLBACK_UNVERIFIED_CONDITIONS.some((line) => line.startsWith("no_provider_hold")));
  assert.ok(item.fallback.notModelled.length > FALLBACK_UNVERIFIED_CONDITIONS.length);
  assert.equal(report.inputs.fallbackFlagAsDeployed, "off");
  assert.equal(report.summary.fallbackReachableAsDeployed["gate:flag_off"], 2);
  assert.equal(report.summary.fallbackReachableIfFlagOn.reachable, 2);

  const on = diagnoseFullCatalog(base({ fallbackEnvironment: { AUTO_ROUTER_FALLBACK_ENABLED: "on" } }));
  assert.deepEqual(on.items[0].fallback.scopeAsDeployed, { allowed: true });
  assert.equal(on.items[0].fallback.reachableAsDeployed.reachable, true);
  assert.equal(on.inputs.fallbackFlagAsDeployed, "on");

  // With nothing ranked behind the primary the decision itself terminates,
  // and that is what is reported: no candidate is invented.
  const lone = diagnoseFullCatalog(base({ models: [model("cheap")], requestedModelId: "cheap", fallbackEnvironment: { AUTO_ROUTER_FALLBACK_ENABLED: "on" } }));
  assert.equal(lone.items[0].decision.primaryModelId, "cheap");
  assert.deepEqual(lone.items[0].fallback.decision, { version: policyVersion, action: "terminate", modelId: null, reason: "no_candidate" });
  assert.equal(lone.items[0].fallback.firstCandidate, null);
  // The gate is asked first and refuses on the same fact, so the refusal
  // names the gate; the decision's own answer is still on record above.
  assert.deepEqual(lone.items[0].fallback.reachableAsDeployed, { reachable: false, refusal: "gate:no_candidate" });

  // The three steps, each answered by the product's order: the gate, then the
  // decision naming a candidate, then dispatch fitting it. A candidate that
  // dispatch cannot fit (planAttemptExecution's context_window_exceeded) is
  // named by the Router and refused at the attempt, and no other is tried.
  //
  // Under the active estimator calibration the diagnostic's dispatch
  // reservation equals the Router's raw estimate (`toReservedInputTokens` of
  // a bare number is identity), so the Router refuses such a model before it
  // is ever a candidate; the product reaches the case through attachment and
  // tool overhead, which the diagnostic lists as not modelled. The branch is
  // held here on the helper itself.
  const prompt = items()[0].prompt;
  const routerReserved = Math.max(1, Math.ceil(Buffer.byteLength(prompt, "utf8") / 4));
  assert.equal(toReservedInputTokens(routerReserved), routerReserved);
  const named = { version: "v", action: "fallback", modelId: "mid", reason: null };
  const terminated = { version: "v", action: "terminate", modelId: null, reason: "visible_token_emitted" };
  const fitted = { modelId: "mid", dispatchFit: "fitted", dispatchOutputTokens: 4_000 };
  const exceeded = { modelId: "mid", dispatchFit: "exceeded", dispatchOutputTokens: null };
  assert.deepEqual(fallbackReachabilityFor({ allowed: false, reason: "flag_off" }, named, fitted), { reachable: false, refusal: "gate:flag_off" });
  assert.deepEqual(fallbackReachabilityFor({ allowed: false, reason: "tools_offered" }, named, exceeded), { reachable: false, refusal: "gate:tools_offered" });
  assert.deepEqual(fallbackReachabilityFor({ allowed: true }, terminated, fitted), { reachable: false, refusal: "decision:visible_token_emitted" });
  assert.deepEqual(fallbackReachabilityFor({ allowed: true }, named, null), { reachable: false, refusal: "decision:mid is not the candidate dispatch was asked to fit" });
  assert.deepEqual(fallbackReachabilityFor({ allowed: true }, named, exceeded), { reachable: false, refusal: "candidate_context_window_exceeded" });
  // Reachable offline is never "executable": the answer says so itself.
  assert.deepEqual(fallbackReachabilityFor({ allowed: true }, named, fitted), {
    reachable: true,
    ...fitted,
    execution: "unverified",
    unverifiedConditions: FALLBACK_UNVERIFIED_CONDITIONS,
  });
  assert.deepEqual(fallbackReachabilityFor({ allowed: true }, named, { ...fitted, dispatchFit: "unbounded" }), {
    reachable: true,
    ...fitted,
    dispatchFit: "unbounded",
    execution: "unverified",
    unverifiedConditions: FALLBACK_UNVERIFIED_CONDITIONS,
  });
  assert.equal(item.fallback.reachableIfFlagOn.execution, "unverified");
  assert.ok(!JSON.stringify(report.items[0].fallback).includes('"executable"'));
});

test("improvement candidates name the reachability gap and the never-chosen models with fixed identifiers", () => {
  const report = diagnoseFullCatalog(base());
  const kinds = report.improvementCandidates.map((c) => c.kind);
  assert.ok(kinds.includes("context_window_undeclared"));
  assert.deepEqual(
    report.improvementCandidates.find((c) => c.kind === "context_window_undeclared").modelIds,
    ["nowindow"]
  );
  assert.ok(kinds.includes("eligible_never_primary"));
  assert.deepEqual(report.summary.eligibleNeverPrimary, ["dear", "mid"]);
  assert.ok(kinds.includes("decided_by_tie_break"));
  // `paid` is never eligible on the Free plan, and is neither undeclared nor disabled.
  assert.deepEqual(report.improvementCandidates.find((c) => c.kind === "never_eligible").modelIds, ["paid"]);
});

test("a requested model outside the catalogue is refused rather than routed under an invented cap", () => {
  assert.throws(() => diagnoseFullCatalog(base({ requestedModelId: "ghost" })), /not in the catalogue/);
});

test("the report carries nothing derived from a prompt", () => {
  const secret = "PROMPT-TEXT-THAT-MUST-NOT-LEAK";
  const report = diagnoseFullCatalog(base({ items: [{ id: "i-1", prompt: `Explain ${secret} please` }] }));
  assert.ok(!JSON.stringify(report).includes(secret));
});

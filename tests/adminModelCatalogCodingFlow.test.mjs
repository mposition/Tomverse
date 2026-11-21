import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityOrigin,
  codingAttentionCounts,
  codingCatalogItems,
  codingDraftSources,
  codingEdit,
  codingEditProblems,
  codingNextAction,
  codingServing,
  codingStage,
  linkAllReasonRows,
  reasonMessage,
} from "../lib/adminModelCatalogFlow.ts";
import { applyCodingDraftEdits, codingDraftEditSchema, codingProfileSchema } from "../lib/modelCatalogCore.ts";

const PRICING = "https://www.anthropic.com/pricing";

const profile = {
  name: "Claude Sonnet 5.5",
  provider: "anthropic",
  apiModelId: "claude-sonnet-5-5",
  minimumPlan: "Pro",
  capabilities: { toolCalling: "parallel", structuredOutput: "forced_tool_use", imageInput: true, maxContextTokens: 200_000, maxOutputTokens: 64_000 },
  pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, creditWeight: 12, verifiedAt: "2026-11-12", sources: [PRICING] },
};

const row = (overrides = {}) => ({
  modelId: "claude-sonnet-5-5",
  enabled: null,
  holdReason: null,
  profile: null,
  problem: "no_profile",
  admission: null,
  draft: null,
  ...overrides,
});

const item = (overrides) => codingCatalogItems({ models: [row(overrides)] })[0];

test("the fixture is a valid coding profile, so the flow reads what the server stores", () => {
  assert.equal(codingProfileSchema.safeParse(profile).success, true);
});

test("each coding row is on one step, and an invalid profile asks for a new draft, not JSON", () => {
  assert.equal(codingStage(item({})), "needs_draft");
  assert.equal(codingStage(item({ profile: { broken: true }, problem: "invalid_profile" })), "profile_invalid");
  assert.equal(codingNextAction("profile_invalid"), "redraft");
  assert.equal(codingStage(item({ draft: profile, draftReview: { floor: 9, reasons: [] } })), "draft_ready");
  const applied = { profile, problem: null, admission: { admitted: true } };
  assert.equal(codingStage(item(applied)), "ready_to_enable");
  assert.equal(codingStage(item({ ...applied, enabled: true })), "serving");
  assert.equal(codingStage(item({ ...applied, enabled: true, holdReason: "cost check" })), "held");
  assert.equal(codingStage(item({ ...applied, enabled: false })), "held");
  assert.equal(codingStage(item({ ...applied, admission: { admitted: false, reasons: ["credits_below_floor:9"] } })), "blocked");
  // Turned on but no longer admitted (a lapsed judge) is not "serving".
  assert.equal(codingStage(item({ ...applied, enabled: true, admission: { admitted: false, reasons: ["no_tool_calling"] } })), "blocked");
  // A new draft on a serving model is the step to take, and the model still serves.
  const repriced = item({ ...applied, enabled: true, draft: profile });
  assert.equal(codingStage(repriced), "draft_ready");
  assert.equal(codingServing(repriced), true);
});

test("the item takes its name and provider from the profile, or the draft before one exists", () => {
  const fromDraft = item({ draft: profile });
  assert.equal(fromDraft.name, "Claude Sonnet 5.5");
  assert.equal(fromDraft.provider, "anthropic");
  assert.equal(item({}).name, "claude-sonnet-5-5");
});

test("the operator's name, plan and weight are checked like the server checks them, and only changes are sent", () => {
  assert.deepEqual(codingEditProblems(profile, {}, 9), {});
  assert.deepEqual(codingEditProblems(profile, { creditWeight: "8" }, 9), { creditWeight: "below_floor" });
  assert.deepEqual(codingEditProblems(profile, { creditWeight: "1.5" }, 9), { creditWeight: "not_a_number" });
  assert.deepEqual(codingEditProblems(profile, { creditWeight: "1001" }, null), { creditWeight: "not_a_number" });
  assert.deepEqual(codingEditProblems(profile, { name: "   " }, 9), { name: "name_invalid" });
  // No floor: not an input error here; the draft's own reasons say why it cannot apply.
  assert.deepEqual(codingEditProblems(profile, { creditWeight: "1" }, null), {});

  assert.deepEqual(codingEdit(profile, { name: "Claude Sonnet 5.5", minimumPlan: "Pro", creditWeight: "12" }), {});
  assert.deepEqual(codingEdit(profile, { name: " Sonnet ", minimumPlan: "Max", creditWeight: "20" }), {
    name: "Sonnet",
    minimumPlan: "Max",
    creditWeight: 20,
  });
});

test("a coding draft reads the price page, or the provider's default, and nothing else", () => {
  assert.deepEqual(codingDraftSources({ priceUrl: "" }, [PRICING]), [PRICING]);
  assert.deepEqual(codingDraftSources({ priceUrl: ` ${PRICING}/other ` }, [PRICING]), [`${PRICING}/other`]);
  assert.deepEqual(codingDraftSources({ priceUrl: "" }, []), []);
});

test("a row stored or drafted with provider conditions still reads, and one without reads the same way", () => {
  const withTerms = {
    ...profile,
    terms: { allowsResaleAndCodingAgent: true, url: "https://www.anthropic.com/legal/commercial-terms", checkedAt: "2026-11-12" },
    retention: { url: "https://docs.anthropic.com/en/docs/data-retention", checkedAt: "2026-11-12" },
    processingRegion: "us",
  };
  assert.equal(codingProfileSchema.safeParse(withTerms).success, true);
  for (const stored of [withTerms, profile]) {
    const read = item({ profile: stored, problem: null, admission: { admitted: true } });
    assert.equal(read.profile?.name, "Claude Sonnet 5.5");
    assert.equal(codingStage(read), "ready_to_enable");
    assert.equal(item({ draft: stored }).draft?.name, "Claude Sonnet 5.5");
  }
});

test("the attention count has a credit-floor kind and an other kind, and no provider-conditions kind", () => {
  const blocked = (reasons) => item({ profile, problem: null, admission: { admitted: false, reasons } });
  const counts = codingAttentionCounts([
    blocked(["credits_below_floor:9"]),
    blocked(["unknown_provider"]),
    blocked(["provider_destination_unproven"]),
    item({ profile, problem: null, admission: { admitted: true }, enabled: true }),
  ]);
  assert.deepEqual(counts, { floor: 1, other: 2 });
});

test("a link's capability values come from the registry when no page was read, from an LLM draft when one was", () => {
  const evidence = { draftedAt: "2026-11-21", toolCalling: "basic", structuredOutput: "none" };
  assert.equal(capabilityOrigin({ evidence: { ...evidence, sources: [] } }), "registry");
  assert.equal(capabilityOrigin({}), "registry");
  assert.equal(capabilityOrigin({ evidence: { ...evidence, sources: [PRICING] } }), "llm");
});

test("the add-all result lists refusal reasons by count, most common first, with a sample that keeps the detail", () => {
  const rows = linkAllReasonRows({
    reasonCounts: { unknown_provider: 1, credits_below_floor: 2 },
    refused: [
      { modelId: "a", reasons: ["credits_below_floor:7", "unknown_provider"] },
      { modelId: "b", reasons: ["credits_below_floor:9"] },
    ],
  });
  assert.deepEqual(rows, [
    { reason: "credits_below_floor", sample: "credits_below_floor:7", count: 2 },
    { reason: "unknown_provider", sample: "unknown_provider", count: 1 },
  ]);
  assert.deepEqual(reasonMessage(rows[0].sample), { key: "codingWeightBelowFloor", floor: 7 });
});

test("coding refusals read in words, and image ones are unchanged", () => {
  assert.deepEqual(reasonMessage("credits_below_floor:12"), { key: "codingWeightBelowFloor", floor: 12 });
  assert.deepEqual(reasonMessage("credits_below_floor:high/1536x1024"), { key: "creditsBelowFloor", quality: "high", size: "1536x1024" });
  assert.deepEqual(reasonMessage("unofficial_price_source:https://blog.example.com/x"), { key: "unofficialSource", host: "blog.example.com" });
  // Provider conditions are no longer a reason (owner decision 2026-11-21); an old code reads as unknown.
  assert.deepEqual(reasonMessage("terms_do_not_allow"), { key: "unknown", code: "terms_do_not_allow" });
  assert.deepEqual(reasonMessage("provider_destination_unproven"), { key: "destinationUnproven" });
  assert.deepEqual(reasonMessage("no_valid_profile"), { key: "noProfile" });
  assert.deepEqual(reasonMessage("draft_rejected", "credit_floor_unbounded"), { key: "codingFloorUnbounded" });
  assert.deepEqual(reasonMessage("draft_rejected", "capabilities.maxContextTokens"), {
    key: "draftIncomplete",
    detail: "capabilities.maxContextTokens",
  });
  assert.deepEqual(reasonMessage("draft_rejected", "no_options: not listed"), { key: "noPriceFound", detail: "not listed" });
  assert.deepEqual(reasonMessage("draft_rejected", "invalid_prices"), { key: "noPriceFound", detail: "" });
});

test("an applied coding draft changes only the three operator fields, and names each change", () => {
  const { profile: next, edits } = applyCodingDraftEdits(profile, { name: "Sonnet", creditWeight: 20, minimumPlan: "Pro" });
  assert.equal(next.name, "Sonnet");
  assert.equal(next.pricing.creditWeight, 20);
  assert.equal(next.pricing.inputUsdPerMTok, 3);
  assert.deepEqual(edits, [
    { field: "name", from: "Claude Sonnet 5.5", to: "Sonnet" },
    { field: "creditWeight", from: 12, to: 20 },
  ]);
  assert.deepEqual(applyCodingDraftEdits(profile, {}).profile, profile);
  // Prices and evidence are not editable through the apply request.
  assert.equal(codingDraftEditSchema.safeParse({ inputUsdPerMTok: 0.01 }).success, false);
  assert.equal(codingDraftEditSchema.safeParse({ creditWeight: 0 }).success, false);
  assert.equal(codingDraftEditSchema.safeParse({ minimumPlan: "Enterprise" }).success, false);
});

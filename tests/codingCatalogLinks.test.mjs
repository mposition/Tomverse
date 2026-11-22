import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  catalogContentHash,
  normalizedSnapshotContentHash,
  codingCandidateExclusion,
  codingApiSnapshotRows,
  codingCatalogExternalChannelsEnabled,
  codingCatalogRowSchema,
  codingPlanReaches,
  codingStoredProfileSchema,
  judgeCodingChannels,
  judgeCodingModel,
  onCodingApi,
  registryCodingCapabilities,
  resolveCodingEntry,
  snapshotPendingChanges,
} from "../lib/modelCatalogCore.ts";

// Chat links and the external channels of the coding catalogue (owner decision
// 2026-11-20). Provider conditions are no longer judged (owner decision
// 2026-11-21); what is kept here is that a row which carried them is read, and
// published, exactly as before.

const TERMS = "https://www.anthropic.com/legal/commercial-terms";
const RETENTION = "https://docs.anthropic.com/en/docs/data-retention";

const chat = (overrides = {}) => ({
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  provider: "anthropic",
  apiModelId: "claude-sonnet-4-6",
  minimumPlan: "Pro",
  usageClass: "premium",
  creditWeight: 6,
  // The registry sets this model's credits (chatModelFacts, hasRegistryCredits).
  registryCredits: true,
  enabled: true,
  status: "enabled",
  publiclyListed: true,
  catalogDeleted: false,
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 64_000,
  imageInput: true,
  price: {
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    pricingVersion: "anthropic-claude-sonnet-4-6-2026-08-03",
    effectiveDate: "2026-08-03",
    verified: true,
    reasoningBilledSeparately: false,
  },
  ...overrides,
});

const providerTerms = (overrides = {}) => ({
  allowsResaleAndCodingAgent: true,
  termsUrl: TERMS,
  retentionUrl: RETENTION,
  processingRegion: "US",
  checkedAt: "2026-11-10",
  sources: [TERMS, RETENTION],
  ...overrides,
});

const link = (overrides = {}) => ({
  source: "chat",
  registryModelId: "claude-sonnet-4-6",
  capabilities: { toolCalling: "parallel", structuredOutput: "forced_tool_use" },
  channels: ["code"],
  ...overrides,
});

const dedicated = (overrides = {}) => ({
  name: "Qwen 3.7 Coder Plus",
  provider: "qwen",
  apiModelId: "qwen3.7-coder-plus",
  minimumPlan: "Pro",
  capabilities: { toolCalling: "parallel", structuredOutput: "strict_schema", imageInput: false, maxContextTokens: 256_000, maxOutputTokens: 32_000 },
  pricing: {
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    creditWeight: 9,
    verifiedAt: "2026-11-01",
    sources: ["https://www.alibabacloud.com/help/en/model-studio/model-pricing"],
  },
  ...overrides,
});

/** A dedicated row stored before provider conditions were dropped: it carries its own. */
const dedicatedWithOwnTerms = (overrides = {}) =>
  dedicated({
    terms: { allowsResaleAndCodingAgent: true, url: "https://www.alibabacloud.com/help/en/terms", checkedAt: "2026-11-01" },
    retention: { url: "https://www.alibabacloud.com/help/en/privacy", checkedAt: "2026-11-01" },
    processingRegion: "Singapore",
    ...overrides,
  });

const resolve = (profile, { chatModels = [chat()], terms = {}, modelId = "claude-sonnet-4-6" } = {}) =>
  resolveCodingEntry({
    modelId,
    profile,
    chat: (id) => chatModels.find((model) => model.id === id) ?? null,
    providerTerms: (provider) => terms[provider] ?? null,
  });

/** The overall answer of the per-channel judge, as the single answer it used to be. */
const judgeCodingResolution = (resolution, judge) => judgeCodingChannels(resolution, judge).admission;

const deps = (floor = 5) => ({
  knownProvider: () => true,
  providerDestinationEstablished: () => true,
  creditFloor: () => floor,
});

test("a chat link reads name, provider, prices, context, output limit and image input from chat", () => {
  const resolved = resolve(link());
  assert.equal(resolved.problem, null);
  assert.equal(resolved.source, "chat");
  const row = resolved.row;
  assert.equal(row.name, "Claude Sonnet 4.6");
  assert.equal(row.provider, "anthropic");
  assert.equal(row.apiModelId, "claude-sonnet-4-6");
  assert.equal(row.pricing.inputUsdPerMTok, 3);
  assert.equal(row.pricing.outputUsdPerMTok, 15);
  assert.equal(row.pricing.pricingVersion, "anthropic-claude-sonnet-4-6-2026-08-03");
  assert.deepEqual(row.pricing.sources, []);
  assert.equal(row.capabilities.maxContextTokens, 1_000_000);
  assert.equal(row.capabilities.maxOutputTokens, 64_000);
  assert.equal(row.capabilities.imageInput, true);
  // The coding catalogue's own values.
  assert.equal(row.capabilities.toolCalling, "parallel");
  assert.equal(row.capabilities.structuredOutput, "forced_tool_use");
  assert.deepEqual(row.channels, ["code"]);
  // Inherited plan and weight when the link does not override them.
  assert.equal(row.minimumPlan, "Pro");
  assert.equal(row.pricing.creditWeight, 6);
});

test("a chat link's overrides win over chat's plan and weight, and a chat change shows up on the next read", () => {
  const overridden = resolve(link({ minimumPlan: "Max", creditWeight: 14 })).row;
  assert.equal(overridden.minimumPlan, "Max");
  assert.equal(overridden.pricing.creditWeight, 14);
  // Guest and Free chat plans read as Free.
  assert.equal(resolve(link(), { chatModels: [chat({ minimumPlan: "Free" })] }).row.minimumPlan, "Free");
  const moved = resolve(link(), {
    chatModels: [chat({ name: "Claude Sonnet 4.6 (new)", maxOutputTokens: 32_000, price: { ...chat().price, inputUsdPerMTok: 4 } })],
  }).row;
  assert.equal(moved.name, "Claude Sonnet 4.6 (new)");
  assert.equal(moved.capabilities.maxOutputTokens, 32_000);
  assert.equal(moved.pricing.inputUsdPerMTok, 4);
  // The changed read is a different snapshot row: the managed path refuses the old one.
  assert.notEqual(canonicalJson(moved), canonicalJson(resolve(link()).row));
});

test("a stored link is only the link: inherited values are not accepted in it", () => {
  assert.equal(codingStoredProfileSchema.safeParse(link()).success, true);
  assert.equal(codingStoredProfileSchema.safeParse({ ...link(), name: "copied" }).success, false);
  assert.equal(codingStoredProfileSchema.safeParse({ ...link(), channels: [] }).success, false);
  assert.equal(codingStoredProfileSchema.safeParse({ ...link(), channels: ["code", "code"] }).success, false);
  // Channels are stored in one order whatever order they were picked in.
  assert.deepEqual(codingStoredProfileSchema.parse(link({ channels: ["cli", "code"] })).channels, ["code", "cli"]);
  // A link made from the registry records no pages; one drafted from pages (before) still parses.
  const fromRegistry = link({ evidence: { sources: [], draftedAt: "2026-11-21", ...registryCodingCapabilities() } });
  assert.equal(codingStoredProfileSchema.safeParse(fromRegistry).success, true);
  const fromPages = link({
    evidence: { sources: [TERMS], draftedAt: "2026-11-20", toolCalling: "parallel", structuredOutput: "forced_tool_use", note: "Section 4." },
  });
  assert.equal(codingStoredProfileSchema.safeParse(fromPages).success, true);
});

test("a link made from the registry takes tool calling from it and leaves structured output at the conservative none", () => {
  assert.deepEqual(registryCodingCapabilities(), { toolCalling: "basic", structuredOutput: "none" });
  const row = resolve(link({ capabilities: registryCodingCapabilities() })).row;
  assert.equal(row.capabilities.toolCalling, "basic");
  assert.equal(row.capabilities.structuredOutput, "none");
  // The judge passes it: tool calling is all a link needs besides the floor.
  assert.deepEqual(judgeCodingModel(row, deps()), { admitted: true });
});

test("the judge refuses a link whose chat model is off, deleted, unpriced or missing", () => {
  const judge = (resolution) => judgeCodingResolution(resolution, (row) => judgeCodingModel(row, deps()));
  assert.deepEqual(judge(resolve(link())), { admitted: true });
  assert.ok(judge(resolve(link(), { chatModels: [chat({ enabled: false })] })).reasons.includes("chat_model_disabled"));
  assert.ok(judge(resolve(link(), { chatModels: [chat({ status: "disabled" })] })).reasons.includes("chat_model_disabled"));
  assert.ok(judge(resolve(link(), { chatModels: [chat({ catalogDeleted: true })] })).reasons.includes("chat_model_deleted"));
  assert.ok(judge(resolve(link(), { chatModels: [chat({ price: { ...chat().price, verified: false } })] })).reasons.includes("chat_price_unverified"));
  assert.deepEqual(judge(resolve(link(), { chatModels: [] })), { admitted: false, reasons: ["chat_model_missing"] });
  // An unknown context window is Code's problem only: the row resolves, carries a placeholder, and the coding API still takes it.
  const noContext = resolve(link({ channels: ["code"] }), { chatModels: [chat({ contextWindowTokens: null })] });
  assert.equal(noContext.contextUnknown, true);
  assert.deepEqual(judge(noContext), { admitted: false, reasons: ["chat_context_unknown"] });
  const noContextApi = resolve(link({ channels: ["code", "api"] }), { chatModels: [chat({ contextWindowTokens: null })] });
  assert.deepEqual(judgeCodingChannels(noContextApi, (row) => judgeCodingModel(row, deps())).effectiveChannels, ["api"]);
  // Code's managed path refuses separately billed reasoning; the judge says so before activation.
  const reasoning = resolve(link(), { chatModels: [chat({ price: { ...chat().price, reasoningBilledSeparately: true } })] });
  assert.ok(judge(reasoning).reasons.includes("reasoning_cost_unbounded"));
  // An API-only link is not held to Code's managed-path limits.
  const apiOnly = resolve(link({ channels: ["api"] }), { chatModels: [chat({ price: { ...chat().price, reasoningBilledSeparately: true } })] });
  assert.equal(judge(apiOnly).admitted, true);
});

test("a chat link is judged per channel: the coding API needs the chat side, Code needs Code's rules too", () => {
  const channels = (profile, options = {}, floor = 5) =>
    judgeCodingChannels(resolve(profile, options), (row) => judgeCodingModel(row, deps(floor)));
  const both = link({ channels: ["code", "api"], capabilities: { toolCalling: "basic", structuredOutput: "none" } });

  // Chat credits below Code's floor, no structured output, separately billed reasoning, unknown window:
  // none of it stands in the coding API's way; every one stands in Code's.
  const heavy = channels(both, { chatModels: [chat({ contextWindowTokens: null, price: { ...chat().price, reasoningBilledSeparately: true } })] }, 99);
  assert.deepEqual(heavy.api, { admitted: true });
  assert.equal(heavy.code.admitted, false);
  for (const reason of ["credits_below_floor:99", "chat_context_unknown", "reasoning_cost_unbounded", "no_structured_output"]) {
    assert.ok(heavy.code.reasons.includes(reason), reason);
  }
  assert.deepEqual(heavy.admission, { admitted: true });
  assert.deepEqual(heavy.effectiveChannels, ["api"]);

  // A floor nobody can compute is Code's too.
  assert.ok(channels(both, {}, null).code.reasons.includes("credit_floor_unbounded"));
  assert.deepEqual(channels(both, {}, null).api, { admitted: true });

  // Once the structured output is set and the weight meets the floor, both pass.
  const ready = channels(link({ channels: ["code", "api"], creditWeight: 9 }), {}, 9);
  assert.deepEqual(ready.code, { admitted: true });
  assert.deepEqual(ready.effectiveChannels, ["code", "api"]);

  // What stands in the way of both channels stands in the way of the row.
  for (const [reason, options, depsOverride] of [
    ["chat_model_disabled", { chatModels: [chat({ enabled: false })] }, {}],
    ["chat_price_unverified", { chatModels: [chat({ price: { ...chat().price, verified: false } })] }, {}],
    ["provider_cost_unbounded", { chatModels: [chat({ provider: "perplexity" })] }, {}],
    ["provider_destination_unproven", {}, { providerDestinationEstablished: () => false }],
    ["unknown_provider", {}, { knownProvider: () => false }],
  ]) {
    const refused = judgeCodingChannels(resolve(both, options), (row) => judgeCodingModel(row, { ...deps(), ...depsOverride }));
    assert.equal(refused.admission.admitted, false, reason);
    assert.ok(refused.api.reasons.includes(reason), `api: ${reason}`);
    assert.ok(refused.code.reasons.includes(reason), `code: ${reason}`);
    assert.deepEqual(refused.effectiveChannels, [], reason);
  }
  const noTools = channels(link({ channels: ["code", "api"], capabilities: { toolCalling: "none", structuredOutput: "json_mode" } }));
  assert.ok(noTools.api.reasons.includes("no_tool_calling") && noTools.code.reasons.includes("no_tool_calling"));

  // A frontier or apex link whose chat model has no registry credits: its credits
  // would be a class default nobody set, and the coding API never serves it
  // (hasRegistryCredits), so the judge refuses it on both channels, a Code
  // credit weight on the link or not.
  for (const usageClass of ["frontier", "apex"]) {
    for (const profile of [both, link({ channels: ["code", "api"], creditWeight: 120 })]) {
      const unpriced = channels(profile, { chatModels: [chat({ usageClass, creditWeight: 80, registryCredits: false })] });
      assert.equal(unpriced.admission.admitted, false, usageClass);
      assert.ok(unpriced.api.reasons.includes("chat_credits_missing"), `api: ${usageClass}`);
      assert.ok(unpriced.code.reasons.includes("chat_credits_missing"), `code: ${usageClass}`);
      assert.deepEqual(unpriced.effectiveChannels, []);
    }
    // With credits the registry holds, the coding API takes it.
    assert.deepEqual(channels(both, { chatModels: [chat({ usageClass, creditWeight: 80 })] }).api, { admitted: true });
  }
  // Other classes are charged their class default as Chat charges them: never refused for it.
  assert.deepEqual(channels(both, { chatModels: [chat({ registryCredits: false })] }).api, { admitted: true });

  // A channel the row is not offered on has no answer; a Code-only row that fails Code is refused as before.
  const codeOnly = channels(link({ channels: ["code"], capabilities: { toolCalling: "basic", structuredOutput: "none" } }));
  assert.equal(codeOnly.api, null);
  assert.deepEqual(codeOnly.admission, { admitted: false, reasons: ["no_structured_output"] });
  const apiOnly = channels(link({ channels: ["api"], capabilities: { toolCalling: "basic", structuredOutput: "none" } }), {}, 99);
  assert.equal(apiOnly.code, null);
  assert.deepEqual(apiOnly.admission, { admitted: true });
  // The older "cli" channel is the coding API.
  assert.deepEqual(channels(link({ channels: ["code", "cli"], capabilities: { toolCalling: "basic", structuredOutput: "none" } }), {}, 99).effectiveChannels, ["cli"]);
});

test("a dedicated row has one answer for every channel, as before", () => {
  const dedicatedChannels = (profile, floor = 5) =>
    judgeCodingChannels(resolve(profile, { modelId: "qwen3.7-coder-plus" }), (row) => judgeCodingModel(row, deps(floor)));
  // Below the floor, structured output none: a dedicated row is judged as one thing on both channels (the coding API has its own credit rule).
  const below = dedicatedChannels(dedicated({ channels: ["code", "api"], capabilities: { ...dedicated().capabilities, structuredOutput: "none" } }), 99);
  assert.equal(below.code.admitted, false);
  assert.equal(below.api.admitted, false);
  assert.deepEqual(below.code.reasons, below.api.reasons);
  assert.ok(!below.code.reasons.includes("no_structured_output"));
  const ok = dedicatedChannels(dedicated({ channels: ["code", "api"] }));
  assert.deepEqual(ok.effectiveChannels, ["code", "api"]);
});

test("the judge asks for no provider conditions: a row with none passes, and terms never refuse", () => {
  const judge = (resolution, floor = 5) => judgeCodingResolution(resolution, (row) => judgeCodingModel(row, deps(floor)));
  // No provider record: the row has no conditions and is admitted.
  const none = resolve(link());
  assert.equal(none.row.terms, undefined);
  assert.equal(none.row.retention, undefined);
  assert.equal(none.row.processingRegion, undefined);
  assert.deepEqual(judge(none), { admitted: true });
  assert.deepEqual(resolve(dedicated(), { modelId: "qwen3.7-coder-plus" }).refusals, []);
  assert.deepEqual(judge(resolve(dedicated(), { modelId: "qwen3.7-coder-plus" })), { admitted: true });
  // Terms that deny, an unofficial page and an old check no longer refuse or warn.
  const denying = resolve(link(), {
    terms: { anthropic: providerTerms({ allowsResaleAndCodingAgent: false, termsUrl: "https://blog.example/terms", checkedAt: "2025-01-01" }) },
  });
  assert.deepEqual(judge(denying), { admitted: true });
  assert.equal("warnings" in denying, false);
  assert.equal("termsSource" in denying, false);
  // What the judge still decides.
  assert.ok(judge(resolve(link()), 9).reasons.includes("credits_below_floor:9"));
  assert.equal(judge(resolve(link({ creditWeight: 9 })), 9).admitted, true);
  assert.ok(judge(resolve(link({ capabilities: { toolCalling: "none", structuredOutput: "json_mode" } }))).reasons.includes("no_tool_calling"));
  assert.ok(judgeCodingModel(resolve(link()).row, { ...deps(), knownProvider: () => false }).reasons.includes("unknown_provider"));
  // A provider with no established data destination is still refused (the privacy side, as for chat).
  assert.deepEqual(judgeCodingModel(resolve(link()).row, { ...deps(), providerDestinationEstablished: () => false }), {
    admitted: false,
    reasons: ["provider_destination_unproven"],
  });
  // Price sources must still be the provider's own.
  const unofficial = dedicated({ pricing: { ...dedicated().pricing, sources: ["https://blog.example/prices"] } });
  assert.ok(judgeCodingModel(unofficial, deps()).reasons.includes("unofficial_price_source:https://blog.example/prices"));
});

test("a dedicated row keeps carrying its own terms, unjudged, until its provider has a record, then the record", () => {
  const own = resolve(dedicatedWithOwnTerms(), { modelId: "qwen3.7-coder-plus" });
  assert.equal(own.row.terms.url, "https://www.alibabacloud.com/help/en/terms");
  assert.equal(own.row.processingRegion, "Singapore");
  assert.deepEqual(own.row.channels, ["code"]);
  const record = {
    qwen: {
      allowsResaleAndCodingAgent: true,
      termsUrl: "https://www.alibabacloud.com/help/en/legal/terms",
      retentionUrl: "https://www.alibabacloud.com/help/en/legal/privacy",
      processingRegion: "Singapore, US",
      checkedAt: "2026-11-18",
      sources: ["https://www.alibabacloud.com/help/en/legal/terms"],
    },
  };
  const provider = resolve(dedicatedWithOwnTerms(), { modelId: "qwen3.7-coder-plus", terms: record });
  assert.equal(provider.row.terms.url, "https://www.alibabacloud.com/help/en/legal/terms");
  assert.equal(provider.row.processingRegion, "Singapore, US");
  // A dedicated row may be offered on the coding API (owner decision
  // 2026-11-21): it runs there as its own row, so only a provider whose cost a
  // token row cannot bound is refused, as Code's managed path refuses it.
  const onApi = resolve(dedicated({ channels: ["code", "api"] }), { modelId: "qwen3.7-coder-plus" });
  assert.deepEqual(onApi.refusals, []);
  assert.deepEqual(onApi.row.channels, ["code", "api"]);
  for (const channels of [["code", "api"], ["cli"]]) {
    const unbounded = resolve(dedicated({ provider: "openrouter", channels }), { modelId: "qwen3.7-coder-plus" });
    assert.ok(unbounded.refusals.includes("provider_cost_unbounded"), channels.join(","));
  }
  assert.deepEqual(resolve(dedicated({ provider: "openrouter", channels: ["code"] }), { modelId: "qwen3.7-coder-plus" }).refusals, []);
});

// What the code published before provider conditions were dropped, taken from
// that code (the commit this change branched from) for these inputs. The
// managed path compares a snapshot row with the row resolved now by
// canonicalJson (lib/codeManagedService.ts modelPair), and the scheduled
// renewal by catalogContentHash: neither may move for rows that were published.
const PUBLISHED_CHAT_ROW = {
  modelId: "claude-sonnet-4-6",
  source: "chat",
  channels: ["code", "api"],
  name: "Claude Sonnet 4.6",
  provider: "anthropic",
  apiModelId: "claude-sonnet-4-6",
  minimumPlan: "Pro",
  capabilities: { toolCalling: "parallel", structuredOutput: "forced_tool_use", imageInput: true, maxContextTokens: 1000000, maxOutputTokens: 64000 },
  pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, creditWeight: 6, verifiedAt: "2026-08-03", sources: [], pricingVersion: "anthropic-claude-sonnet-4-6-2026-08-03" },
  terms: { allowsResaleAndCodingAgent: true, url: "https://www.anthropic.com/legal/commercial-terms", checkedAt: "2026-11-10" },
  retention: { url: "https://docs.anthropic.com/en/docs/data-retention", checkedAt: "2026-11-10" },
  processingRegion: "US",
  registryModelId: "claude-sonnet-4-6",
};
const PUBLISHED_DEDICATED_ROW = {
  modelId: "qwen3.7-coder-plus",
  source: "dedicated",
  channels: ["code", "api"],
  name: "Qwen 3.7 Coder Plus",
  provider: "qwen",
  apiModelId: "qwen3.7-coder-plus",
  minimumPlan: "Pro",
  capabilities: { toolCalling: "parallel", structuredOutput: "strict_schema", imageInput: false, maxContextTokens: 256000, maxOutputTokens: 32000 },
  pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 5, creditWeight: 9, verifiedAt: "2026-11-01", sources: ["https://www.alibabacloud.com/help/en/model-studio/model-pricing"] },
  terms: { allowsResaleAndCodingAgent: true, url: "https://www.alibabacloud.com/help/en/terms", checkedAt: "2026-11-01" },
  retention: { url: "https://www.alibabacloud.com/help/en/privacy", checkedAt: "2026-11-01" },
  processingRegion: "Singapore",
};
const PUBLISHED_CHAT_CANONICAL =
  '{"apiModelId":"claude-sonnet-4-6","capabilities":{"imageInput":true,"maxContextTokens":1000000,"maxOutputTokens":64000,"structuredOutput":"forced_tool_use","toolCalling":"parallel"},"channels":["code","api"],"minimumPlan":"Pro","modelId":"claude-sonnet-4-6","name":"Claude Sonnet 4.6","pricing":{"creditWeight":6,"inputUsdPerMTok":3,"outputUsdPerMTok":15,"pricingVersion":"anthropic-claude-sonnet-4-6-2026-08-03","sources":[],"verifiedAt":"2026-08-03"},"processingRegion":"US","provider":"anthropic","registryModelId":"claude-sonnet-4-6","retention":{"checkedAt":"2026-11-10","url":"https://docs.anthropic.com/en/docs/data-retention"},"source":"chat","terms":{"allowsResaleAndCodingAgent":true,"checkedAt":"2026-11-10","url":"https://www.anthropic.com/legal/commercial-terms"}}';
const PUBLISHED_CONTENT_HASH = "d200a32907b71fa8ae51ca574c70054ea2d9d7d6fcfe6a9f384f63c5ae4f2c20";

test("rows published with provider conditions resolve to the same canonical row and hash as before", () => {
  const chatRow = resolve(link({ capabilities: { toolCalling: "parallel", structuredOutput: "forced_tool_use" }, channels: ["code", "api"] }), {
    terms: { anthropic: providerTerms() },
  }).row;
  const dedicatedRow = resolve(dedicatedWithOwnTerms({ channels: ["code", "api"] }), { modelId: "qwen3.7-coder-plus" }).row;
  // The canonical text and the hash are pinned to what the earlier code produced.
  assert.equal(canonicalJson(chatRow), PUBLISHED_CHAT_CANONICAL);
  assert.equal(canonicalJson(PUBLISHED_CHAT_ROW), PUBLISHED_CHAT_CANONICAL);
  assert.equal(catalogContentHash([chatRow, dedicatedRow]), PUBLISHED_CONTENT_HASH);
  assert.equal(catalogContentHash([PUBLISHED_CHAT_ROW, PUBLISHED_DEDICATED_ROW]), PUBLISHED_CONTENT_HASH);
  // The snapshot row schema still carries the three fields, and the row the managed path parses from a stored snapshot equals the resolved one.
  const parsedChat = codingCatalogRowSchema.parse(JSON.parse(JSON.stringify(PUBLISHED_CHAT_ROW)));
  const parsedDedicated = codingCatalogRowSchema.parse(JSON.parse(JSON.stringify(PUBLISHED_DEDICATED_ROW)));
  assert.equal(canonicalJson(parsedChat), canonicalJson(chatRow));
  assert.equal(canonicalJson(parsedDedicated), canonicalJson(dedicatedRow));
  assert.equal(catalogContentHash([parsedChat, parsedDedicated]), PUBLISHED_CONTENT_HASH);
  assert.equal(normalizedSnapshotContentHash({ models: [PUBLISHED_CHAT_ROW, PUBLISHED_DEDICATED_ROW] }), PUBLISHED_CONTENT_HASH);
  assert.deepEqual(snapshotPendingChanges([parsedChat, parsedDedicated], [chatRow, dedicatedRow]), []);
});

test("a row with no provider conditions publishes none, and a stored snapshot without them parses and hashes the same", () => {
  const row = resolve(link({ channels: ["code", "api"] })).row;
  assert.equal("terms" in row, false);
  assert.equal("retention" in row, false);
  assert.equal("processingRegion" in row, false);
  const stored = JSON.parse(JSON.stringify(row));
  assert.equal(canonicalJson(codingCatalogRowSchema.parse(stored)), canonicalJson(row));
  assert.equal(catalogContentHash([codingCatalogRowSchema.parse(stored)]), catalogContentHash([row]));
  assert.deepEqual(snapshotPendingChanges([codingCatalogRowSchema.parse(stored)], [row]), []);
});

test("a snapshot row published before links parses to the same row a dedicated entry resolves to today", () => {
  const profile = dedicatedWithOwnTerms();
  const legacyRow = { modelId: "qwen3.7-coder-plus", ...profile };
  const parsed = codingCatalogRowSchema.parse(legacyRow);
  assert.equal(parsed.source, "dedicated");
  assert.deepEqual(parsed.channels, ["code"]);
  const current = resolve(profile, { modelId: "qwen3.7-coder-plus" }).row;
  // The managed path's comparison (lib/codeManagedService.ts modelPair).
  assert.equal(canonicalJson(current), canonicalJson(parsed));
  // Its stored hash differs from the legacy one, but the legacy rows read
  // through today's schema hash the same, so the scheduled renewal still
  // extends that snapshot without a manual publish.
  assert.notEqual(catalogContentHash([current]), catalogContentHash([legacyRow]));
  assert.equal(normalizedSnapshotContentHash({ models: [legacyRow] }), catalogContentHash([current]));
  assert.equal(normalizedSnapshotContentHash({ models: [{ ...legacyRow, modelId: "not a model id" }] }), null);
  assert.equal(normalizedSnapshotContentHash(null), null);
  assert.deepEqual(snapshotPendingChanges([parsed], [current]), []);
  // A linked row round-trips through the snapshot schema unchanged.
  const linked = resolve(link({ channels: ["code", "api"] }), { terms: { anthropic: providerTerms() } }).row;
  assert.equal(canonicalJson(codingCatalogRowSchema.parse(JSON.parse(JSON.stringify(linked)))), canonicalJson(linked));
});

test("pending snapshot changes name added, removed and changed rows", () => {
  const a = resolve(link()).row;
  const b = resolve(dedicated(), { modelId: "qwen3.7-coder-plus" }).row;
  const aChanged = { ...a, pricing: { ...a.pricing, creditWeight: 12 } };
  assert.deepEqual(snapshotPendingChanges([a], [aChanged, b]), [
    { modelId: "claude-sonnet-4-6", kind: "changed" },
    { modelId: "qwen3.7-coder-plus", kind: "added" },
  ]);
  assert.deepEqual(snapshotPendingChanges([a, b], [b]), [{ modelId: "claude-sonnet-4-6", kind: "removed" }]);
});

test("coding candidates are active, listed chat models of a served usage class not in the catalogue yet", () => {
  const none = new Set();
  assert.equal(codingCandidateExclusion(chat(), none), null);
  assert.equal(codingCandidateExclusion(chat(), new Set(["claude-sonnet-4-6"])), "already_in_catalog");
  assert.equal(codingCandidateExclusion(chat({ enabled: false }), none), "disabled");
  assert.equal(codingCandidateExclusion(chat({ status: "coming-soon" }), none), "disabled");
  assert.equal(codingCandidateExclusion(chat({ status: "limited" }), none), null);
  assert.equal(codingCandidateExclusion(chat({ publiclyListed: false }), none), "not_listed");
  assert.equal(codingCandidateExclusion(chat({ catalogDeleted: true }), none), "deleted");
  assert.equal(codingCandidateExclusion(chat({ usageClass: "research" }), none), "usage_class:research");
  assert.equal(codingCandidateExclusion(chat({ usageClass: "deep-research" }), none), "usage_class:deep-research");
  // Frontier and apex are coding candidates too (owner decision 2026-11-22).
  for (const usageClass of ["standard", "advanced", "premium", "reasoning", "premium-reasoning", "frontier", "apex"]) {
    assert.equal(codingCandidateExclusion(chat({ usageClass }), none), null, usageClass);
  }
  // Frontier and apex only with credits the registry holds: the judge and the
  // coding API ask the same (chat_credits_missing, hasRegistryCredits).
  for (const usageClass of ["frontier", "apex"]) {
    assert.equal(codingCandidateExclusion(chat({ usageClass, registryCredits: false }), none), "chat_credits_missing", usageClass);
  }
  for (const usageClass of ["standard", "premium", "premium-reasoning"]) {
    assert.equal(codingCandidateExclusion(chat({ usageClass, registryCredits: false }), none), null, usageClass);
  }
  assert.equal(codingCandidateExclusion(chat({ id: "bad id with spaces" }), none), "invalid_id");
});

test("the coding API offers the rows of either source that list it, are still on and the plan reaches", () => {
  const rows = [
    resolve(link({ channels: ["code", "api"] })).row,
    resolve(link({ registryModelId: "gpt-6-luna", channels: ["code", "api"], minimumPlan: "Max" }), {
      modelId: "gpt-6-luna",
      chatModels: [chat({ id: "gpt-6-luna", provider: "anthropic" })],
    }).row,
    resolve(dedicated({ channels: ["code"] }), { modelId: "qwen3.7-coder-plus" }).row,
    // Saved with the CLI's own channel before the CLI moved onto the coding API.
    resolve(dedicated({ name: "Coder CLI", channels: ["cli"] }), { modelId: "qwen3.7-coder-cli" }).row,
  ];
  const ids = (plan, activeIds) => codingApiSnapshotRows(rows, { plan, activeIds }).map((row) => row.modelId).sort();
  const active = new Set(["claude-sonnet-4-6", "gpt-6-luna", "qwen3.7-coder-plus", "qwen3.7-coder-cli"]);
  assert.deepEqual(ids("Pro", active), ["claude-sonnet-4-6", "qwen3.7-coder-cli"]);
  assert.deepEqual(ids("Max", active), ["claude-sonnet-4-6", "gpt-6-luna", "qwen3.7-coder-cli"]);
  // A row turned off or held after publishing leaves at once.
  assert.deepEqual(ids("Max", new Set(["gpt-6-luna"])), ["gpt-6-luna"]);
  // A row offered to Code only is not on the coding API.
  assert.equal(ids("Max", active).includes("qwen3.7-coder-plus"), false);
  // "api", or the older "cli", is the coding API.
  assert.equal(onCodingApi(["code"]), false);
  assert.equal(onCodingApi(["api"]), true);
  assert.equal(onCodingApi(["code", "cli"]), true);
  // A plan the coding scale does not know reaches nothing.
  assert.equal(codingPlanReaches("Guest", "Free"), false);
  assert.equal(codingPlanReaches("Free", "Free"), true);
  assert.equal(codingPlanReaches("Pro", "Max"), false);
});

test("the coding API switch is off unless it is exactly true", () => {
  assert.equal(codingCatalogExternalChannelsEnabled({}), false);
  assert.equal(codingCatalogExternalChannelsEnabled({ CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED: "1" }), false);
  assert.equal(codingCatalogExternalChannelsEnabled({ CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED: "true" }), true);
});

import assert from "node:assert/strict";
import { resolve as resolvePath } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  catalogContentHash,
  codingActivationBlockers,
  codingCandidateExclusion,
  codingCatalogExternalChannelsEnabled,
  codingCatalogRowOf,
  codingCatalogRowSchema,
  codingStoredProfileSchema,
  externalChannelModelIds,
  judgeCodingModel,
  judgeCodingResolution,
  providerTermsDueOn,
  providerTermsExpired,
  resolveCodingEntry,
  snapshotPendingChanges,
} from "../lib/modelCatalogCore.ts";
import { externalApiChannelFor } from "../lib/externalApiCatalogCore.ts";

// The draft module builds its model client from lib/activeAiModel.ts, whose
// provider SDKs these pure answer checks never call.
const mod = (path) => pathToFileURL(resolvePath(import.meta.dirname, "..", path)).href;
mock.module(mod("lib/activeAiModel.ts"), { namedExports: { getActiveAiModel: () => null } });
const { codingCapabilitiesFromAnswer, providerTermsFromAnswer } = await import(mod("lib/modelCatalogDraftLlm.ts"));

// Chat links, provider conditions and the external channels of the coding
// catalogue (owner decision 2026-11-20).

const NOW = new Date("2026-11-20T00:00:00Z");
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
  terms: { allowsResaleAndCodingAgent: true, url: "https://www.alibabacloud.com/help/en/terms", checkedAt: "2026-11-01" },
  retention: { url: "https://www.alibabacloud.com/help/en/privacy", checkedAt: "2026-11-01" },
  processingRegion: "Singapore",
  ...overrides,
});

const resolve = (profile, { chatModels = [chat()], terms = { anthropic: providerTerms() }, modelId = "claude-sonnet-4-6", now = NOW } = {}) =>
  resolveCodingEntry({
    modelId,
    profile,
    chat: (id) => chatModels.find((model) => model.id === id) ?? null,
    providerTerms: (provider) => terms[provider] ?? null,
    now,
  });

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
  assert.equal(resolved.termsSource, "provider");
  assert.equal(row.terms.url, TERMS);
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
  assert.notEqual(canonicalJson(codingCatalogRowOf(moved)), canonicalJson(codingCatalogRowOf(resolve(link()).row)));
});

test("a stored link is only the link: inherited values are not accepted in it", () => {
  assert.equal(codingStoredProfileSchema.safeParse(link()).success, true);
  assert.equal(codingStoredProfileSchema.safeParse({ ...link(), name: "copied" }).success, false);
  assert.equal(codingStoredProfileSchema.safeParse({ ...link(), channels: [] }).success, false);
  assert.equal(codingStoredProfileSchema.safeParse({ ...link(), channels: ["code", "code"] }).success, false);
  // Channels are stored in one order whatever order they were picked in.
  assert.deepEqual(codingStoredProfileSchema.parse(link({ channels: ["cli", "code"] })).channels, ["code", "cli"]);
});

test("the judge refuses a link whose chat model is off, deleted, unpriced or missing", () => {
  const judge = (resolution) => judgeCodingResolution(resolution, (row) => judgeCodingModel(row, deps()));
  assert.deepEqual(judge(resolve(link())), { admitted: true });
  assert.ok(judge(resolve(link(), { chatModels: [chat({ enabled: false })] })).reasons.includes("chat_model_disabled"));
  assert.ok(judge(resolve(link(), { chatModels: [chat({ status: "disabled" })] })).reasons.includes("chat_model_disabled"));
  assert.ok(judge(resolve(link(), { chatModels: [chat({ catalogDeleted: true })] })).reasons.includes("chat_model_deleted"));
  assert.ok(judge(resolve(link(), { chatModels: [chat({ price: { ...chat().price, verified: false } })] })).reasons.includes("chat_price_unverified"));
  assert.deepEqual(judge(resolve(link(), { chatModels: [] })), { admitted: false, reasons: ["chat_model_missing"] });
  assert.deepEqual(judge(resolve(link(), { chatModels: [chat({ contextWindowTokens: null })] })), {
    admitted: false,
    reasons: ["chat_context_unknown"],
  });
  // Code's managed path refuses separately billed reasoning; the judge says so before activation.
  const reasoning = resolve(link(), { chatModels: [chat({ price: { ...chat().price, reasoningBilledSeparately: true } })] });
  assert.ok(judge(reasoning).reasons.includes("reasoning_cost_unbounded"));
  // An API-only link is not held to Code's managed-path limits.
  const apiOnly = resolve(link({ channels: ["api"] }), { chatModels: [chat({ price: { ...chat().price, reasoningBilledSeparately: true } })] });
  assert.equal(judge(apiOnly).admitted, true);
});

test("the judge refuses missing provider conditions, a low credit weight and no tool calling", () => {
  const judge = (resolution, floor = 5) => judgeCodingResolution(resolution, (row) => judgeCodingModel(row, deps(floor)));
  const noTerms = resolve(link(), { terms: {} });
  assert.equal(noTerms.row.terms, null);
  assert.equal(codingCatalogRowOf(noTerms.row), null);
  assert.ok(judge(noTerms).reasons.includes("provider_terms_missing"));
  assert.ok(judge(resolve(link()), 9).reasons.includes("credits_below_floor:9"));
  assert.equal(judge(resolve(link({ creditWeight: 9 })), 9).admitted, true);
  assert.ok(judge(resolve(link({ capabilities: { toolCalling: "none", structuredOutput: "json_mode" } }))).reasons.includes("no_tool_calling"));
  assert.ok(
    judge(resolve(link(), { terms: { anthropic: providerTerms({ allowsResaleAndCodingAgent: false }) } })).reasons.includes("terms_do_not_allow")
  );
  assert.ok(
    judge(resolve(link(), { terms: { anthropic: providerTerms({ termsUrl: "https://blog.example/terms" }) } })).reasons.includes(
      "terms_source_unofficial"
    )
  );
});

test("provider conditions past 90 days warn a serving model and block a new activation", () => {
  assert.equal(providerTermsDueOn("2026-08-12"), "2026-11-10");
  // Due on the 90th day after the check, from that day's start (UTC).
  assert.equal(providerTermsExpired("2026-08-23", NOW), false);
  assert.equal(providerTermsExpired("2026-08-22", NOW), true);
  assert.equal(providerTermsExpired("not-a-date", NOW), true);
  const expired = resolve(link(), { terms: { anthropic: providerTerms({ checkedAt: "2026-08-12" }) } });
  assert.deepEqual(expired.warnings, ["provider_terms_expired"]);
  // A warning, not a refusal: the judge still admits it.
  assert.equal(judgeCodingResolution(expired, (row) => judgeCodingModel(row, deps())).admitted, true);
  assert.deepEqual(codingActivationBlockers(expired), ["provider_terms_expired"]);
  assert.deepEqual(codingActivationBlockers(resolve(link())), []);
});

test("a dedicated row keeps its own terms until its provider has a record, then reads the record", () => {
  const own = resolve(dedicated(), { modelId: "qwen3.7-coder-plus", terms: {} });
  assert.equal(own.termsSource, "model");
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
  const provider = resolve(dedicated(), { modelId: "qwen3.7-coder-plus", terms: record });
  assert.equal(provider.termsSource, "provider");
  assert.equal(provider.row.terms.url, "https://www.alibabacloud.com/help/en/legal/terms");
  assert.equal(provider.row.processingRegion, "Singapore, US");
  // The external API runs chat models only: a dedicated row cannot list API or CLI.
  assert.ok(resolve(dedicated({ channels: ["code", "api"] }), { modelId: "qwen3.7-coder-plus", terms: {} }).refusals.includes("dedicated_code_only"));
});

test("a snapshot row published before links parses to the same row a dedicated entry resolves to today", () => {
  const profile = dedicated();
  const legacyRow = { modelId: "qwen3.7-coder-plus", ...profile };
  const parsed = codingCatalogRowSchema.parse(legacyRow);
  assert.equal(parsed.source, "dedicated");
  assert.deepEqual(parsed.channels, ["code"]);
  const current = codingCatalogRowOf(resolve(profile, { modelId: "qwen3.7-coder-plus", terms: {} }).row);
  // The managed path's comparison (lib/codeManagedService.ts modelPair).
  assert.equal(canonicalJson(current), canonicalJson(parsed));
  // Its hash does differ from the legacy one: the scheduled renewal waits for one publish.
  assert.notEqual(catalogContentHash([current]), catalogContentHash([legacyRow]));
  assert.deepEqual(snapshotPendingChanges([parsed], [current]), []);
  // A linked row round-trips through the snapshot schema unchanged.
  const linked = codingCatalogRowOf(resolve(link({ channels: ["code", "api"] })).row);
  assert.equal(canonicalJson(codingCatalogRowSchema.parse(JSON.parse(JSON.stringify(linked)))), canonicalJson(linked));
});

test("pending snapshot changes name added, removed and changed rows", () => {
  const a = codingCatalogRowOf(resolve(link()).row);
  const b = codingCatalogRowOf(resolve(dedicated(), { modelId: "qwen3.7-coder-plus", terms: {} }).row);
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
  for (const usageClass of ["standard", "advanced", "premium", "reasoning", "premium-reasoning"]) {
    assert.equal(codingCandidateExclusion(chat({ usageClass }), none), null, usageClass);
  }
  assert.equal(codingCandidateExclusion(chat({ id: "bad id with spaces" }), none), "invalid_id");
});

test("an external channel offers the chat links that list it, are still on and the plan reaches", () => {
  const rows = [
    codingCatalogRowOf(resolve(link({ channels: ["code", "api", "cli"] })).row),
    codingCatalogRowOf(resolve(link({ registryModelId: "gpt-6-luna", channels: ["code", "api"], minimumPlan: "Max" }), {
      modelId: "gpt-6-luna",
      chatModels: [chat({ id: "gpt-6-luna", provider: "anthropic" })],
    }).row),
    codingCatalogRowOf(resolve(dedicated({ channels: ["code"] }), { modelId: "qwen3.7-coder-plus", terms: {} }).row),
  ];
  const active = new Set(["claude-sonnet-4-6", "gpt-6-luna", "qwen3.7-coder-plus"]);
  assert.deepEqual([...externalChannelModelIds(rows, { channel: "api", plan: "Pro", activeIds: active })], ["claude-sonnet-4-6"]);
  assert.deepEqual([...externalChannelModelIds(rows, { channel: "api", plan: "Max", activeIds: active })].sort(), ["claude-sonnet-4-6", "gpt-6-luna"]);
  assert.deepEqual([...externalChannelModelIds(rows, { channel: "cli", plan: "Max", activeIds: active })], ["claude-sonnet-4-6"]);
  // A row turned off or held after publishing leaves at once.
  assert.deepEqual([...externalChannelModelIds(rows, { channel: "api", plan: "Max", activeIds: new Set(["gpt-6-luna"]) })], ["gpt-6-luna"]);
  // A dedicated row is never offered externally.
  assert.equal(externalChannelModelIds(rows, { channel: "api", plan: "Max", activeIds: active }).has("qwen3.7-coder-plus"), false);
});

test("the external channels switch is off unless it is exactly true, and the CLI names itself", () => {
  assert.equal(codingCatalogExternalChannelsEnabled({}), false);
  assert.equal(codingCatalogExternalChannelsEnabled({ CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED: "1" }), false);
  assert.equal(codingCatalogExternalChannelsEnabled({ CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED: "true" }), true);
  assert.equal(externalApiChannelFor("tomverse-cli/0.4.1"), "cli");
  assert.equal(externalApiChannelFor("claude-cli/2.1.278 (external, cli)"), "api");
  assert.equal(externalApiChannelFor(null), "api");
});

test("a capability draft reads an unknown answer as none, and a terms draft must cite pages it fetched", () => {
  const sources = ["https://docs.anthropic.com/en/docs/build-with-claude/tool-use"];
  const capabilities = codingCapabilitiesFromAnswer({ toolCalling: "parallel", structuredOutput: "made_up", note: " a  b " }, sources);
  assert.equal(capabilities.toolCalling, "parallel");
  assert.equal(capabilities.structuredOutput, "none");
  assert.equal(capabilities.note, "a b");
  assert.deepEqual(capabilities.sources, sources);
  const pages = [TERMS, RETENTION];
  const terms = providerTermsFromAnswer(
    { allowsResaleAndCodingAgent: true, termsUrl: TERMS, retentionUrl: RETENTION, processingRegion: "US", evidence: "Section 4." },
    "anthropic",
    pages
  );
  assert.equal(terms.allowsResaleAndCodingAgent, true);
  assert.equal(terms.evidence, "Section 4.");
  // A terms URL nobody fetched is not evidence of permission.
  const unread = providerTermsFromAnswer(
    { allowsResaleAndCodingAgent: true, termsUrl: "https://www.anthropic.com/other", retentionUrl: RETENTION, processingRegion: "US", evidence: "" },
    "anthropic",
    pages
  );
  assert.equal(unread.allowsResaleAndCodingAgent, false);
  assert.equal(unread.termsUrl, TERMS);
  assert.throws(
    () => providerTermsFromAnswer({ allowsResaleAndCodingAgent: true, termsUrl: TERMS, retentionUrl: "https://x.example/r", processingRegion: "US" }, "anthropic", pages),
    /draft_rejected/
  );
});

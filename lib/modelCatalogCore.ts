// Dynamic model catalogue: pure rules shared by the server, the admin API and
// the tests. No database, no environment, no framework.
//
// Three layers (owner decision 2026-10-19):
//   - code: providers, adapters, and these judge functions (never in the DB);
//   - verified data: prices and their verification, in append-only revisions;
//   - operations: enable/hold/sort, edited by an operator at runtime.
//
// A NULL column inherits the code profile; a value is an operator override.
// Whether a model may serve is decided here, from the resolved profile, never
// from a stored boolean alone: a row that says "enabled" for a model whose
// worst-case cost is unbounded is refused.

import { createHash } from "node:crypto";
import { z } from "zod";

import {
  billingTermsApplyTo,
  type ConfirmedImageBillingTerms,
  imageMeasuredOutputLimitBound,
  imageThinkingCapEnforced,
  imageThinkingCapMinimumMicroUsd,
  type ImageModelDisabledReason,
  type ImageModelOptionPrice,
  type ImageModelPriceVerification,
  type ImageModelProfile,
} from "@/lib/imageModelRegistry";
import { isSmartAdaptiveOnlyModel } from "@/lib/externalApiCatalogCore";
import { confirmedImageBillingTermsSchema } from "@/lib/imageBillingMeasurementCore";
import { IMAGE_ROUTING_NOTE_MAX_CHARS, IMAGE_USE_CASES, RUNTIME_IMAGE_PROVIDERS } from "@/lib/runtimeImageProviders";

export const MODEL_CATALOG_CATEGORIES = ["chat", "image", "coding", "video"] as const;
export type ModelCatalogCategory = (typeof MODEL_CATALOG_CATEGORIES)[number];

/** Categories with rows in ModelCatalogEntry; chat is a view, video has no policy yet. */
export const STORED_CATALOG_CATEGORIES = ["image", "coding"] as const;
export type StoredCatalogCategory = (typeof STORED_CATALOG_CATEGORIES)[number];

/** Who wrote a pending draft; only a model call today. */
export const CATALOG_DRAFT_SOURCES = ["llm"] as const;

/** Categories with a published snapshot: only coding (the Code client reads it). */
export const SNAPSHOT_CATALOG_CATEGORIES = ["coding"] as const;

export const isStoredCatalogCategory = (value: unknown): value is StoredCatalogCategory =>
  typeof value === "string" && (STORED_CATALOG_CATEGORIES as readonly string[]).includes(value);

export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;

/**
 * Official documentation hosts a price or terms source may cite, per provider.
 * A verification whose sources are elsewhere (a blog, a search summary) is not
 * a verification (image-generation policy section 12).
 */
export const OFFICIAL_SOURCE_HOSTS: Readonly<Record<string, readonly string[]>> = {
  openai: ["openai.com", "developers.openai.com", "platform.openai.com"],
  // The Claude API docs moved to platform.claude.com, which also serves the
  // Console (sign-in, workbench), so only its /docs/ path counts there.
  anthropic: ["www.anthropic.com", "anthropic.com", "docs.anthropic.com", "docs.claude.com", "www.claude.com", "platform.claude.com/docs/"],
  cohere: ["docs.cohere.com"],
  // Google moved the Gemini API docs to AI Studio in 2026-11 and ai.google.dev
  // now answers 301. AI Studio also serves user-built apps and shared prompts,
  // so only its /docs/ path counts as documentation.
  google: ["ai.google.dev", "cloud.google.com", "aistudio.google.com/docs/"],
  xai: ["docs.x.ai", "x.ai"],
  fal: ["fal.ai"],
  // bfl.ai also serves the playground and account pages, so only /pricing there.
  bfl: ["docs.bfl.ai", "bfl.ai/pricing"],
  deepseek: ["api-docs.deepseek.com"],
  mistral: ["docs.mistral.ai", "mistral.ai"],
  // platform.moonshot.ai answers 301 to platform.kimi.ai since 2026-11.
  moonshot: ["platform.moonshot.ai", "platform.kimi.ai"],
  // QwenCloud is Alibaba's Qwen API site. Its www host also serves sign-in and
  // a playground, so only /pricing/ there counts; docs.qwencloud.com is docs.
  qwen: ["www.alibabacloud.com", "help.aliyun.com", "docs.qwencloud.com", "www.qwencloud.com/pricing/"],
  zhipu: ["docs.z.ai"],
  minimax: ["platform.minimax.io"],
  groq: ["console.groq.com"],
  perplexity: ["docs.perplexity.ai"],
};

/**
 * The pricing pages a draft reads when the operator gives no URL, so the
 * operator does not have to look them up. Each one was checked to carry its
 * prices in the HTML (not loaded by script) and to fit the draft page limits.
 */
export const DEFAULT_PRICE_SOURCES: Readonly<Record<string, readonly string[]>> = {
  openai: ["https://developers.openai.com/api/docs/pricing", "https://developers.openai.com/api/docs/guides/image-generation"],
  google: ["https://aistudio.google.com/docs/pricing"],
  qwen: ["https://www.alibabacloud.com/help/en/model-studio/model-pricing"],
};

export const defaultPriceSources = (provider: string): readonly string[] =>
  Object.hasOwn(DEFAULT_PRICE_SOURCES, provider) ? DEFAULT_PRICE_SOURCES[provider] : [];

export type CodingCapabilitySources = { toolCalling: string; structuredOutput: string };

/**
 * The pages a coding link draft reads for tool calling and structured output,
 * one each per draft provider. Each was checked on 2026-11-20 to answer 200
 * without a redirect (the fetch refuses redirects), to carry its text in the
 * HTML or Markdown, and to fit the draft page limits. A docs move turns one
 * into fetch_failed; the operator can then enter the new page in the dialog.
 */
export const DEFAULT_CODING_CAPABILITY_SOURCES: Readonly<Record<string, CodingCapabilitySources>> = {
  openai: {
    toolCalling: "https://developers.openai.com/api/docs/guides/function-calling",
    structuredOutput: "https://developers.openai.com/api/docs/guides/structured-outputs",
  },
  anthropic: {
    toolCalling: "https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview.md",
    structuredOutput: "https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md",
  },
  cohere: {
    toolCalling: "https://docs.cohere.com/docs/tool-use-overview",
    structuredOutput: "https://docs.cohere.com/docs/structured-outputs",
  },
  google: {
    toolCalling: "https://aistudio.google.com/docs/function-calling",
    structuredOutput: "https://aistudio.google.com/docs/structured-output",
  },
  groq: {
    toolCalling: "https://console.groq.com/docs/tool-use/overview",
    structuredOutput: "https://console.groq.com/docs/structured-outputs",
  },
  xai: {
    toolCalling: "https://docs.x.ai/developers/tools/function-calling",
    structuredOutput: "https://docs.x.ai/developers/model-capabilities/text/structured-outputs",
  },
  // DeepSeek answers the slashless paths with a 302 to these.
  deepseek: {
    toolCalling: "https://api-docs.deepseek.com/guides/tool_calls/",
    structuredOutput: "https://api-docs.deepseek.com/guides/json_mode/",
  },
  mistral: {
    toolCalling: "https://docs.mistral.ai/inference/conversations/function-calling",
    structuredOutput: "https://docs.mistral.ai/inference/conversations/structured-output",
  },
  moonshot: {
    toolCalling: "https://platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls",
    structuredOutput: "https://platform.kimi.ai/docs/guide/use-json-mode-feature-of-kimi-api",
  },
  // MiniMax has no structured output guide; the chat API reference states response_format.
  minimax: {
    toolCalling: "https://platform.minimax.io/docs/guides/text-m3-function-call.md",
    structuredOutput: "https://platform.minimax.io/docs/api-reference/text-post.md",
  },
  qwen: {
    toolCalling: "https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling",
    structuredOutput: "https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output",
  },
  zhipu: {
    toolCalling: "https://docs.z.ai/guides/capabilities/function-calling",
    structuredOutput: "https://docs.z.ai/guides/capabilities/struct-output",
  },
  perplexity: {
    toolCalling: "https://docs.perplexity.ai/docs/agent-api/tools/custom-functions",
    structuredOutput: "https://docs.perplexity.ai/docs/agent-api/output-control",
  },
};

export const defaultCodingCapabilitySources = (provider: string): CodingCapabilitySources | null =>
  Object.hasOwn(DEFAULT_CODING_CAPABILITY_SOURCES, provider) ? DEFAULT_CODING_CAPABILITY_SOURCES[provider] : null;

/**
 * Exact hosts only: a subdomain wildcard would admit user-written pages
 * (community.openai.com) as "official", and this list is also the fetch
 * allowlist for LLM drafts. No port, https only. An entry with a path
 * ("host/path/") admits only URLs under that path on that host.
 */
export const isOfficialSourceUrl = (provider: string, url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.port !== "" || parsed.username || parsed.password) return false;
  if (!Object.hasOwn(OFFICIAL_SOURCE_HOSTS, provider)) return false;
  return OFFICIAL_SOURCE_HOSTS[provider].some((entry) => {
    const slash = entry.indexOf("/");
    if (slash === -1) return parsed.hostname === entry;
    return parsed.hostname === entry.slice(0, slash) && parsed.pathname.startsWith(entry.slice(slash));
  });
};

// --- schemas ---------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const imagePriceSchema = z
  .object({
    quality: z.enum(["low", "medium", "high"]),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536"]),
    credits: z.number().int().positive().max(10_000),
    outputCostMicroUsd: z.number().int().nonnegative().max(10_000_000),
  })
  .strict();

export const imagePriceListSchema = z
  .array(imagePriceSchema)
  .min(1)
  .max(9)
  .refine(
    (prices) => new Set(prices.map((p) => `${p.quality}|${p.size}`)).size === prices.length,
    "each quality and size appears once"
  );

export const imageVerificationSchema = z
  .object({
    verifiedAt: isoDate,
    sources: z.array(z.string().url()).min(1).max(10),
    thinkingCapMicroUsd: z.number().int().nonnegative().max(10_000_000).nullable(),
  })
  .strict();

/** One line for the image router on what a model is good and bad at. */
export const imageRoutingNoteSchema = z
  .string()
  .trim()
  .min(1)
  .max(IMAGE_ROUTING_NOTE_MAX_CHARS)
  // One line: the note is printed inside a list the router reads.
  .regex(/^[^\r\n]+$/);

/** What an operator may override on an image model that has a code profile. */
export const imageProfileOverrideSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    shortName: z.string().trim().min(1).max(40),
    disabledNote: z.string().trim().min(1).max(500),
    routingNote: imageRoutingNoteSchema,
    useCase: z.enum(IMAGE_USE_CASES),
  })
  .partial()
  .strict();
export type ImageProfileOverride = z.infer<typeof imageProfileOverrideSchema>;

/**
 * A whole image model added at runtime. Only for a provider whose adapter the
 * code already has; the request shape is the provider's, so a new model of an
 * existing provider needs no code.
 */
export const imageFullProfileSchema = z
  .object({
    provider: z.enum(RUNTIME_IMAGE_PROVIDERS),
    modelOwner: z.enum(RUNTIME_IMAGE_PROVIDERS).optional(),
    apiModelId: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(80),
    shortName: z.string().trim().min(1).max(40).optional(),
    lifecycle: z.enum(["stable", "preview"]),
    sizes: z.array(z.enum(["1024x1024", "1536x1024", "1024x1536"])).min(1),
    qualities: z.array(z.enum(["low", "medium", "high"])).min(1),
    latencyClass: z.enum(["fast", "balanced", "slow"]),
    provenance: z.array(z.enum(["c2pa", "synthid"])),
    outputMimeTypes: z.array(z.string().regex(/^image\/[a-z0-9.+-]+$/)).min(1),
    deliveryMimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    thinkingLevel: z.enum(["low", "medium", "high"]).optional(),
    disabledNote: z.string().trim().min(1).max(500).optional(),
    routingNote: imageRoutingNoteSchema.optional(),
    useCase: z.enum(IMAGE_USE_CASES).optional(),
  })
  .strict();
export type ImageFullProfile = z.infer<typeof imageFullProfileSchema>;

export const CODING_PLANS = ["Free", "Pro", "Max"] as const;
export type CodingPlan = (typeof CODING_PLANS)[number];
export const CODING_TOOL_CALLING = ["none", "basic", "parallel"] as const;
/**
 * Structured output as a new save writes it: supported or not (owner decision
 * 2026-11-22). Code's managed path and the Code judge only ask whether it is
 * "none" (lib/codeManagedService.ts modelPair, `no_structured_output`).
 */
export const CODING_STRUCTURED_OUTPUT_CHOICES = ["supported", "none"] as const;
export type CodingStructuredOutputChoice = (typeof CODING_STRUCTURED_OUTPUT_CHOICES)[number];
/**
 * Every value a stored row or a published snapshot may carry. The finer values
 * written before the two choices still parse, so those rows and snapshots keep
 * their canonicalJson and content hash; they read as supported. Nothing new
 * writes them.
 */
export const CODING_STRUCTURED_OUTPUT = ["none", "supported", "json_mode", "strict_schema", "forced_tool_use", "response_schema"] as const;

/** A stored or answered value as one of the two choices; anything unknown is the conservative "none". */
export const codingStructuredOutputChoice = (value: unknown): CodingStructuredOutputChoice =>
  typeof value === "string" && value !== "none" && (CODING_STRUCTURED_OUTPUT as readonly string[]).includes(value) ? "supported" : "none";

/**
 * The output cap a dedicated draft uses when the provider's pages state none
 * (owner decision 2026-11-22). Code's managed path and the coding API send it
 * as the provider output limit, and the credit floors price it, so the worst
 * turn stays inside it.
 */
export const CODING_DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

const usdPerMTok = z.number().nonnegative().max(1_000);

/**
 * Whether input-size tiers are in the order the pages price them: each tier's
 * largest input above the one before, and the open top tier (null) only last.
 */
const priceTiersAscend = (tiers: readonly { upToInputTokens: number | null }[]) =>
  tiers.every((tier, index) => {
    if (tier.upToInputTokens === null) return index === tiers.length - 1;
    if (index === 0) return true;
    const below = tiers[index - 1].upToInputTokens;
    return below !== null && tier.upToInputTokens > below;
  });

const priceTierListSchema = z
  .array(
    z
      .object({
        /** The tier's largest input in tokens; null for the open top tier. */
        upToInputTokens: z.number().int().positive().nullable(),
        inputUsdPerMTok: usdPerMTok,
        outputUsdPerMTok: usdPerMTok,
      })
      .strict()
  )
  .min(1)
  .max(8);

/**
 * The tier list a draft may write: in the order the pages price them. A list
 * out of order is refused at drafting, so no draft keeps or shows ranges that
 * cannot be meant. Write side only: a stored profile is read with the plain
 * list, so a row is never dropped from serving by a later, stricter check.
 */
export const codingPriceTiersSchema = priceTierListSchema.refine(
  priceTiersAscend,
  "tiers ascend by upToInputTokens and only the last is open (null)"
);

/**
 * Where a dedicated draft's values came from, beside its price sources: the
 * output cap read from the pages or the default above, and the input-size
 * price tiers the pages list (the profile's prices are the dearest tier's).
 * Kept in the stored profile only; the resolved and snapshot rows do not carry
 * it, so it moves no hash. The tier order is checked where a draft is made
 * (codingPriceTiersSchema), not when a stored profile is read.
 */
export const codingDraftBasisSchema = z
  .object({
    maxOutputTokens: z.enum(["documented", "default"]),
    priceTiers: priceTierListSchema.optional(),
  })
  .strict();
export type CodingDraftBasis = z.infer<typeof codingDraftBasisSchema>;

/**
 * Where a coding model is offered: Code's managed path ("code") and the coding
 * API ("api": /api/code/v1 and /api/code/anthropic, used by Claude Code, Codex,
 * Cursor and the tomverse CLI; owner decision 2026-11-21). "cli" was the
 * tomverse CLI's own channel before the CLI moved onto the coding API; a row
 * stored with it still parses and reads as the coding API (onCodingApi), so
 * no stored row or snapshot needs rewriting. The coding API reads this only
 * while CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED is on.
 */
export const CODING_CHANNELS = ["code", "api", "cli"] as const;
export type CodingChannel = (typeof CODING_CHANNELS)[number];

/** Whether a row's channels put it on the coding API ("api", or the older "cli"). */
export const onCodingApi = (channels: readonly string[]): boolean => channels.includes("api") || channels.includes("cli");

/** Channels in one fixed order, so the same choice always hashes the same. */
export const normalizeCodingChannels = (channels: readonly CodingChannel[]): CodingChannel[] =>
  CODING_CHANNELS.filter((channel) => channels.includes(channel));

export const codingChannelsSchema = z
  .array(z.enum(CODING_CHANNELS))
  .min(1)
  .max(CODING_CHANNELS.length)
  .refine((channels) => new Set(channels).size === channels.length, "each channel appears once")
  .transform(normalizeCodingChannels);

/** A coding model the Code client may use in managed mode. */
export const codingProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    provider: z.string().trim().min(1).max(40),
    apiModelId: z.string().trim().min(1).max(120),
    minimumPlan: z.enum(CODING_PLANS),
    capabilities: z
      .object({
        toolCalling: z.enum(CODING_TOOL_CALLING),
        structuredOutput: z.enum(CODING_STRUCTURED_OUTPUT),
        imageInput: z.boolean(),
        maxContextTokens: z.number().int().positive(),
        maxOutputTokens: z.number().int().positive(),
      })
      .strict(),
    pricing: z
      .object({
        inputUsdPerMTok: z.number().nonnegative().max(1_000),
        outputUsdPerMTok: z.number().nonnegative().max(1_000),
        creditWeight: z.number().int().positive().max(1_000),
        verifiedAt: isoDate,
        sources: z.array(z.string().url()).min(1).max(10),
      })
      .strict(),
    // Provider conditions are no longer judged or collected (owner decision
    // 2026-11-21). A row stored or published with them still parses, and a
    // snapshot row that carries them hashes as it did; a new row omits them.
    terms: z
      .object({
        allowsResaleAndCodingAgent: z.boolean(),
        url: z.string().url(),
        checkedAt: isoDate,
      })
      .strict()
      .optional(),
    retention: z.object({ url: z.string().url(), checkedAt: isoDate }).strict().optional(),
    processingRegion: z.string().trim().min(2).max(40).optional(),
    /** A draft's basis for its output cap and prices (absent on rows drafted before it). */
    basis: codingDraftBasisSchema.optional(),
  })
  .strict();
export type CodingProfile = z.infer<typeof codingProfileSchema>;

/**
 * What the operator may change in a coding draft before applying it: the
 * display name, the plan that sees the model and the credit weight. Prices
 * and capabilities are what the cited pages say, so they are not editable; a
 * different answer is a new draft.
 */
export const codingDraftEditSchema = z
  .object({
    name: codingProfileSchema.shape.name.optional(),
    minimumPlan: codingProfileSchema.shape.minimumPlan.optional(),
    creditWeight: codingProfileSchema.shape.pricing.shape.creditWeight.optional(),
  })
  .strict();
export type CodingDraftEdit = z.infer<typeof codingDraftEditSchema>;

/** The draft with the operator's edits, and each field that changed (for the audit row). */
export const applyCodingDraftEdits = (
  draft: CodingProfile,
  edit: CodingDraftEdit
): { profile: CodingProfile; edits: { field: keyof CodingDraftEdit; from: string | number; to: string | number }[] } => {
  const edits: { field: keyof CodingDraftEdit; from: string | number; to: string | number }[] = [];
  if (edit.name !== undefined && edit.name !== draft.name) edits.push({ field: "name", from: draft.name, to: edit.name });
  if (edit.minimumPlan !== undefined && edit.minimumPlan !== draft.minimumPlan) {
    edits.push({ field: "minimumPlan", from: draft.minimumPlan, to: edit.minimumPlan });
  }
  if (edit.creditWeight !== undefined && edit.creditWeight !== draft.pricing.creditWeight) {
    edits.push({ field: "creditWeight", from: draft.pricing.creditWeight, to: edit.creditWeight });
  }
  return {
    profile: {
      ...draft,
      name: edit.name ?? draft.name,
      minimumPlan: edit.minimumPlan ?? draft.minimumPlan,
      // Applying is a save: a draft stored before the two choices is written as one of them.
      capabilities: { ...draft.capabilities, structuredOutput: codingStructuredOutputChoice(draft.capabilities.structuredOutput) },
      pricing: { ...draft.pricing, creditWeight: edit.creditWeight ?? draft.pricing.creditWeight },
    },
    edits,
  };
};

// --- coding: stored rows and chat links ---------------------------------------
//
// A coding row is one of two kinds (owner decision 2026-11-20):
//   - dedicated: a model chat does not have; the row carries its whole profile
//     (codingProfileSchema), as every coding row did before;
//   - chat: a link to a ModelRegistryEntry. Name, provider, API model id,
//     prices, context, output limit and image input are read from the chat
//     registry every time the catalogue is resolved, never copied; the row holds
//     only what is the coding catalogue's own.
// Provider conditions (terms, retention, region) are not a coding admission
// rule (owner decision 2026-11-21): chat models are added without them. Where a
// provider record (CodingProviderTerms, no longer written) or a dedicated row's
// own fields exist they are still carried into the resolved row, unjudged, so
// a snapshot row published with them compares as it did.

/**
 * A dedicated row's credits on the coding API, when the operator charges more
 * there than the chat rule's minimum (owner decision 2026-11-21). Absent -- the
 * default, and every row stored before it -- the coding API charges that
 * minimum, worked out when a request is priced (lib/codingRowRuntime.ts
 * codingApiCredit); it is never stored, so a row without it hashes as before.
 * `pricing.creditWeight` stays Code's managed-path credits.
 */
/** The most a coding API credit may be, override or floor (lib/codingRowRuntime.ts codingApiCreditFloor). */
export const CODING_API_CREDIT_WEIGHT_MAX = 1_000;

export const codingApiCreditWeightSchema = z.number().int().positive().max(CODING_API_CREDIT_WEIGHT_MAX);

/** A dedicated row: the whole profile, plus where it is offered (Code only until set). */
export const codingDedicatedProfileSchema = codingProfileSchema
  .extend({
    source: z.literal("dedicated").optional(),
    channels: codingChannelsSchema.optional(),
    apiCreditWeight: codingApiCreditWeightSchema.optional(),
  })
  .strict();
export type CodingDedicatedProfile = z.infer<typeof codingDedicatedProfileSchema>;

export const CODING_EVIDENCE_MAX_SOURCES = 3;

/** A chat link: the registry id and the values chat does not have. */
export const codingLinkedProfileSchema = z
  .object({
    source: z.literal("chat"),
    registryModelId: z.string().regex(MODEL_ID_PATTERN),
    capabilities: z
      .object({
        toolCalling: z.enum(CODING_TOOL_CALLING),
        structuredOutput: z.enum(CODING_STRUCTURED_OUTPUT),
      })
      .strict(),
    /** Absent: the chat model's plan (Guest reads as Free). */
    minimumPlan: z.enum(CODING_PLANS).optional(),
    /** Absent: the chat model's credit weight. Never below the coding floor to serve. */
    creditWeight: z.number().int().positive().max(1_000).optional(),
    channels: codingChannelsSchema,
    /** Where the two capability values came from: the chat registry now; an LLM draft's pages on a link made before. */
    evidence: z
      .object({
        sources: z.array(z.string().url()).max(CODING_EVIDENCE_MAX_SOURCES),
        draftedAt: isoDate,
        toolCalling: z.enum(CODING_TOOL_CALLING),
        structuredOutput: z.enum(CODING_STRUCTURED_OUTPUT),
        note: z.string().trim().max(600).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CodingLinkedProfile = z.infer<typeof codingLinkedProfileSchema>;

export const codingStoredProfileSchema = z.union([codingLinkedProfileSchema, codingDedicatedProfileSchema]);
export type CodingStoredProfile = z.infer<typeof codingStoredProfileSchema>;

/**
 * A stored coding profile as a write saves it: structured output as one of the
 * two choices. An older value a write still carries (a direct PATCH, or a row
 * saved for another field) is saved as "supported", the value it reads as, so
 * changing another field of an older row is never refused for it. Only a write
 * goes through here: a row nobody writes keeps its value, and reading one and
 * the snapshot hash are unchanged. `rewritten` names each value changed, for
 * the audit row.
 */
export const codingProfileForWrite = (
  profile: CodingStoredProfile
): { profile: CodingStoredProfile; rewritten: { field: string; from: string; to: CodingStructuredOutputChoice }[] } => {
  const rewritten: { field: string; from: string; to: CodingStructuredOutputChoice }[] = [];
  const choice = (field: string, value: (typeof CODING_STRUCTURED_OUTPUT)[number]) => {
    const to = codingStructuredOutputChoice(value);
    if (to !== value) rewritten.push({ field, from: value, to });
    return to;
  };
  if (profile.source === "chat") {
    const capabilities = { ...profile.capabilities, structuredOutput: choice("capabilities.structuredOutput", profile.capabilities.structuredOutput) };
    const evidence = profile.evidence && { ...profile.evidence, structuredOutput: choice("evidence.structuredOutput", profile.evidence.structuredOutput) };
    return { profile: { ...profile, capabilities, ...(evidence ? { evidence } : {}) }, rewritten };
  }
  const capabilities = { ...profile.capabilities, structuredOutput: choice("capabilities.structuredOutput", profile.capabilities.structuredOutput) };
  return { profile: { ...profile, capabilities }, rewritten };
};

/**
 * One resolved coding model: what a snapshot carries and what the managed
 * path compares a snapshot row against (canonicalJson). Inherited values are
 * resolved in. A row published before links existed has no `source` or
 * `channels`; it reads as a dedicated row offered to Code, which is what it was.
 */
export const codingCatalogRowSchema = z
  .object({
    modelId: z.string().regex(MODEL_ID_PATTERN),
    source: z.enum(["dedicated", "chat"]).default("dedicated"),
    registryModelId: z.string().regex(MODEL_ID_PATTERN).optional(),
    channels: codingChannelsSchema.default(["code"]),
    /** A dedicated row's coding API credits, when set (codingDedicatedProfileSchema). */
    apiCreditWeight: codingApiCreditWeightSchema.optional(),
    name: codingProfileSchema.shape.name,
    provider: codingProfileSchema.shape.provider,
    apiModelId: codingProfileSchema.shape.apiModelId,
    minimumPlan: codingProfileSchema.shape.minimumPlan,
    capabilities: codingProfileSchema.shape.capabilities,
    pricing: z
      .object({
        inputUsdPerMTok: z.number().nonnegative().max(1_000),
        outputUsdPerMTok: z.number().nonnegative().max(1_000),
        creditWeight: z.number().int().positive().max(1_000),
        verifiedAt: isoDate,
        // A chat link's price is the chat registry's (versioned, checked by
        // check:model-pricing), so it names a pricing version and no page.
        sources: z.array(z.string().url()).max(10),
        pricingVersion: z.string().min(1).max(120).optional(),
      })
      .strict(),
    terms: codingProfileSchema.shape.terms,
    retention: codingProfileSchema.shape.retention,
    processingRegion: codingProfileSchema.shape.processingRegion,
  })
  .strict();
export type CodingCatalogRow = z.output<typeof codingCatalogRowSchema>;

/** A row as the judge sees it (a draft profile too): what is priced and offered, never provider conditions. */
export type CodingJudgeInput = Omit<CodingCatalogRow, "modelId" | "source" | "channels" | "registryModelId" | "apiCreditWeight">;
export type CodingResolvedRow = CodingCatalogRow;

/**
 * What an operator applied for one provider before provider conditions were
 * dropped (CodingProviderTerms.terms). Read only, so rows that carried them
 * keep their published content; nothing writes it any more.
 */
export const codingProviderTermsSchema = z
  .object({
    allowsResaleAndCodingAgent: z.boolean(),
    termsUrl: z.string().url(),
    retentionUrl: z.string().url(),
    processingRegion: z.string().trim().min(2).max(40),
    checkedAt: isoDate,
    sources: z.array(z.string().url()).min(1).max(CODING_EVIDENCE_MAX_SOURCES),
    /** The clauses the draft read, in a sentence or two, for the operator comparing it. */
    evidence: z.string().trim().max(600).optional(),
  })
  .strict();
export type CodingProviderTerms = z.infer<typeof codingProviderTermsSchema>;

/**
 * A chat registry model as the coding catalogue reads it. Built on the server
 * from the runtime registry and the chat price resolver (lib/modelCatalog.ts
 * chatModelFacts); the rules below take it as data.
 */
export type ChatModelFacts = {
  id: string;
  name: string;
  provider: string;
  apiModelId: string;
  /** Chat's plan on the coding scale: Guest and Free read as Free. */
  minimumPlan: "Free" | "Pro";
  usageClass: string;
  /** What chat charges: the registry's own credit weight, or its class default when the registry holds none. */
  creditWeight: number;
  /**
   * Whether the chat registry holds a positive whole credit weight for this
   * model (hasRegistryCredits, lib/externalApiCatalogCore.ts), rather than
   * `creditWeight` being its class default. A frontier or apex model is a
   * coding candidate, and served, only with one (chat_credits_missing).
   */
  registryCredits: boolean;
  enabled: boolean;
  status: string;
  publiclyListed: boolean;
  catalogDeleted: boolean;
  contextWindowTokens: number | null;
  /** The output cap chat asks for (not the provider's ceiling). */
  maxOutputTokens: number;
  imageInput: boolean;
  /** At the long-context tier for the whole window: the worst a coding turn can be priced at. */
  price: {
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
    pricingVersion: string;
    effectiveDate: string;
    /** False for the conservative class fallback: a price nobody verified. */
    verified: boolean;
    reasoningBilledSeparately: boolean;
  };
};

/**
 * Providers Code's managed path refuses outright: inference hosts and
 * aggregators need their own destination pin, and Perplexity's search fees are
 * not represented by token-only rows (lib/codeManagedService.ts modelPair).
 */
export const CODE_MANAGED_UNBOUNDED_PROVIDERS: readonly string[] = ["openrouter", "deepinfra", "together", "sail", "perplexity"];

export type CodingResolution = {
  source: "dedicated" | "chat" | null;
  /** Null when the row cannot be read at all; `problem` says why. */
  row: CodingResolvedRow | null;
  problem: string | null;
  /**
   * Refusals the row's values alone cannot show (the linked chat model's
   * state). A chat link's are split by channel in judgeCodingChannels.
   */
  refusals: string[];
  /** A chat link whose chat model has no context window: its row carries a placeholder, and Code refuses it. */
  contextUnknown: boolean;
  stored: CodingStoredProfile | null;
};

const PLAN_RANK: Record<CodingPlan, number> = { Free: 0, Pro: 1, Max: 2 };

/** Whether an account on `plan` reaches a model's minimum; a plan this scale does not know reaches nothing. */
export const codingPlanReaches = (plan: string, minimumPlan: CodingPlan): boolean =>
  Object.hasOwn(PLAN_RANK, plan) && PLAN_RANK[plan as CodingPlan] >= PLAN_RANK[minimumPlan];

/**
 * Resolve one stored coding row against the chat registry (and the provider
 * records that still carry conditions into the row). Pure: the caller supplies
 * both lookups.
 */
export const resolveCodingEntry = (input: {
  modelId: string;
  profile: unknown;
  chat: (registryModelId: string) => ChatModelFacts | null;
  providerTerms: (provider: string) => CodingProviderTerms | null;
}): CodingResolution => {
  const empty = (problem: string, stored: CodingStoredProfile | null = null, source: CodingResolution["source"] = null): CodingResolution => ({
    source,
    row: null,
    problem,
    refusals: [],
    contextUnknown: false,
    stored,
  });
  if (input.profile === null || input.profile === undefined) return empty("no_profile");
  const parsed = codingStoredProfileSchema.safeParse(input.profile);
  if (!parsed.success) return empty("invalid_profile");
  const stored = parsed.data;
  const refusals: string[] = [];

  if (stored.source === "chat") {
    const chat = input.chat(stored.registryModelId);
    if (!chat) return empty("chat_model_missing", stored, "chat");
    // Code needs the window (its credit floor assumes all of it); the coding API runs the chat
    // model under chat's own input limit and does not. The row of an unknown window carries
    // the output cap as a placeholder so it still publishes for the coding API, and Code
    // refuses it (chat_context_unknown, judgeCodingChannels).
    const contextUnknown = chat.contextWindowTokens === null;
    if (contextUnknown) refusals.push("chat_context_unknown");
    if (chat.catalogDeleted) refusals.push("chat_model_deleted");
    else if (!chat.enabled || (chat.status !== "enabled" && chat.status !== "limited")) refusals.push("chat_model_disabled");
    if (!chat.price.verified) refusals.push("chat_price_unverified");
    // The coding API serves a frontier or apex model only at credits the chat
    // registry holds for it (isExternalApiServableModel), so the judge refuses
    // the link on the same condition rather than admit it at a class default.
    if (chatCreditsMissing(chat)) refusals.push("chat_credits_missing");
    if (chat.price.reasoningBilledSeparately) refusals.push("reasoning_cost_unbounded");
    if (CODE_MANAGED_UNBOUNDED_PROVIDERS.includes(chat.provider)) refusals.push("provider_cost_unbounded");
    return {
      source: "chat",
      row: {
        modelId: input.modelId,
        source: "chat",
        registryModelId: stored.registryModelId,
        channels: stored.channels,
        name: chat.name,
        provider: chat.provider,
        apiModelId: chat.apiModelId,
        minimumPlan: stored.minimumPlan ?? chat.minimumPlan,
        capabilities: {
          toolCalling: stored.capabilities.toolCalling,
          structuredOutput: stored.capabilities.structuredOutput,
          imageInput: chat.imageInput,
          maxContextTokens: chat.contextWindowTokens ?? chat.maxOutputTokens,
          maxOutputTokens: chat.maxOutputTokens,
        },
        pricing: {
          inputUsdPerMTok: chat.price.inputUsdPerMTok,
          outputUsdPerMTok: chat.price.outputUsdPerMTok,
          creditWeight: stored.creditWeight ?? chat.creditWeight,
          verifiedAt: chat.price.effectiveDate,
          sources: [],
          pricingVersion: chat.price.pricingVersion,
        },
        ...conditionsOf(input.providerTerms(chat.provider)),
      },
      problem: null,
      refusals,
      contextUnknown,
      stored,
    };
  }

  // A dedicated row runs on its own row's prices on the coding API too
  // (lib/codingRowRuntime.ts), so a provider whose cost a token row cannot
  // bound is refused there as Code's managed path refuses it.
  const channels = stored.channels ?? (["code"] as CodingChannel[]);
  if (onCodingApi(channels) && CODE_MANAGED_UNBOUNDED_PROVIDERS.includes(stored.provider)) refusals.push("provider_cost_unbounded");
  const providerTerms = input.providerTerms(stored.provider);
  return {
    source: "dedicated",
    row: {
      modelId: input.modelId,
      source: "dedicated",
      channels,
      ...(stored.apiCreditWeight === undefined ? {} : { apiCreditWeight: stored.apiCreditWeight }),
      name: stored.name,
      provider: stored.provider,
      apiModelId: stored.apiModelId,
      minimumPlan: stored.minimumPlan,
      capabilities: stored.capabilities,
      pricing: stored.pricing,
      // A provider record, applied earlier, stands in for the row's own fields.
      ...(providerTerms
        ? conditionsOf(providerTerms)
        : {
            ...(stored.terms ? { terms: stored.terms } : {}),
            ...(stored.retention ? { retention: stored.retention } : {}),
            ...(stored.processingRegion ? { processingRegion: stored.processingRegion } : {}),
          }),
    },
    problem: null,
    refusals,
    contextUnknown: false,
    stored,
  };
};

/** The condition fields a provider record puts on a row; none when the provider has no record. */
const conditionsOf = (terms: CodingProviderTerms | null) =>
  terms
    ? {
        terms: { allowsResaleAndCodingAgent: terms.allowsResaleAndCodingAgent, url: terms.termsUrl, checkedAt: terms.checkedAt },
        retention: { url: terms.retentionUrl, checkedAt: terms.checkedAt },
        processingRegion: terms.processingRegion,
      }
    : {};

/**
 * The two capability values of a chat link, from what the chat registry
 * already knows (owner decision 2026-11-21). The coding candidates are the
 * classes the external API serves, and that API offers every model with tool
 * calling (`capabilities.tools`, lib/externalApiCatalogCore.ts), so a candidate
 * supports it. The registry records nothing about structured output, so that
 * stays at the conservative "none" until the operator sets it on the link.
 */
export const registryCodingCapabilities = (): CodingLinkedProfile["capabilities"] => ({
  toolCalling: "basic",
  structuredOutput: "none",
});

/**
 * Usage classes a chat model may have to be offered as a coding candidate: the
 * external API's servable classes, and frontier and apex (owner decision
 * 2026-11-22), which the coding API's Smart Adaptive sends the hardest work to
 * and a client may name there. Research classes need the application's own
 * search loop and are never candidates.
 */
export const CODING_CANDIDATE_USAGE_CLASSES: readonly string[] = ["standard", "advanced", "premium", "reasoning", "premium-reasoning", "frontier", "apex"];

/**
 * A frontier or apex chat model the chat registry holds no credit weight for:
 * its `creditWeight` is only the class default nobody set, and the coding API
 * never serves it (hasRegistryCredits, lib/externalApiCatalogCore.ts).
 */
const chatCreditsMissing = (chat: Pick<ChatModelFacts, "usageClass" | "registryCredits">) =>
  isSmartAdaptiveOnlyModel(chat) && chat.registryCredits !== true;

/**
 * Why a chat model is not a coding candidate, or null when it is one:
 * enabled, listed, not deleted, a usage class the API serves, credits the
 * registry holds where the class needs them (frontier, apex), an id the
 * catalogue accepts, and no coding row of that id yet.
 */
export const codingCandidateExclusion = (chat: ChatModelFacts, codingIds: ReadonlySet<string>): string | null => {
  if (codingIds.has(chat.id)) return "already_in_catalog";
  if (chat.catalogDeleted) return "deleted";
  if (!chat.enabled || (chat.status !== "enabled" && chat.status !== "limited")) return "disabled";
  if (!chat.publiclyListed) return "not_listed";
  if (!CODING_CANDIDATE_USAGE_CLASSES.includes(chat.usageClass)) return `usage_class:${chat.usageClass}`;
  if (chatCreditsMissing(chat)) return "chat_credits_missing";
  if (!MODEL_ID_PATTERN.test(chat.id)) return "invalid_id";
  return null;
};

/**
 * The snapshot rows the coding API may offer while the switch is on: rows of
 * either source that list the coding API, whose coding row is still on and not
 * held now, at a plan that reaches the row's minimum. A chat link runs as its
 * chat registry model; a dedicated row runs as its own row
 * (lib/codingCatalogChannels.ts).
 */
export const codingApiSnapshotRows = (
  rows: readonly CodingCatalogRow[],
  input: { plan: CodingPlan; activeIds: ReadonlySet<string> }
): CodingCatalogRow[] =>
  rows.filter(
    (row) => onCodingApi(row.channels) && input.activeIds.has(row.modelId) && codingPlanReaches(input.plan, row.minimumPlan)
  );

/**
 * The coding API reads the coding snapshot only while this is "true". Off --
 * the default -- the coding API offers and runs exactly what the general API
 * does (the chat registry), so a client moved to the new address keeps working.
 * The general API never reads the coding catalogue.
 */
export const CODING_CATALOG_EXTERNAL_CHANNELS_ENV = "CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED";

export const codingCatalogExternalChannelsEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env[CODING_CATALOG_EXTERNAL_CHANNELS_ENV] === "true";

export type SnapshotPendingChange = { modelId: string; kind: "added" | "removed" | "changed" };

/** What the next publish would change: rows the judges admit now against the newest snapshot's rows. */
export const snapshotPendingChanges = (
  published: readonly CodingCatalogRow[],
  current: readonly CodingCatalogRow[]
): SnapshotPendingChange[] => {
  const before = new Map(published.map((row) => [row.modelId, canonicalJson(row)]));
  const after = new Map(current.map((row) => [row.modelId, canonicalJson(row)]));
  const changes: SnapshotPendingChange[] = [];
  for (const [modelId, json] of after) {
    const old = before.get(modelId);
    if (old === undefined) changes.push({ modelId, kind: "added" });
    else if (old !== json) changes.push({ modelId, kind: "changed" });
  }
  for (const modelId of before.keys()) if (!after.has(modelId)) changes.push({ modelId, kind: "removed" });
  return changes.sort((a, b) => (a.modelId < b.modelId ? -1 : 1));
};

// --- confirmed billing terms -------------------------------------------------

export { confirmedImageBillingTermsSchema };

export type BillingTermsRowInput = {
  id: string;
  provider: string;
  apiModelId: string;
  terms: unknown;
  createdAt: Date;
};

export const billingTermsKey = (provider: string, apiModelId: string) => `${provider}\u0000${apiModelId}`;
const termsKey = billingTermsKey;

/**
 * The latest confirmed terms per provider model that parse and that the
 * provider's request can hold. A later row replaces an earlier one; a row
 * that does not parse is skipped rather than reviving the one before it.
 */
export const latestBillingTerms = (
  rows: readonly BillingTermsRowInput[]
): Map<string, ConfirmedImageBillingTerms | null> => {
  const latest = new Map<string, BillingTermsRowInput>();
  for (const row of rows) {
    const key = termsKey(row.provider, row.apiModelId);
    const current = latest.get(key);
    if (!current || row.createdAt.getTime() >= current.createdAt.getTime()) latest.set(key, row);
  }
  const out = new Map<string, ConfirmedImageBillingTerms | null>();
  for (const [key, row] of latest) {
    const parsed = confirmedImageBillingTermsSchema.safeParse(row.terms);
    const terms = parsed.success ? ({ ...parsed.data, confirmationId: row.id } as ConfirmedImageBillingTerms) : null;
    out.set(key, billingTermsApplyTo(row.provider, terms));
  }
  return out;
};

/**
 * The model with its confirmed terms. A runtime Google model (not in the code
 * seed) is sent the confirmed output limit with no thinking level, so the
 * request is the measured one; a code model's request stays the code's, and
 * the judge refuses terms it does not match.
 */
export const withImageBillingTerms = <M extends ImageModelProfile>(
  model: M,
  terms: ReadonlyMap<string, ConfirmedImageBillingTerms | null> | undefined,
  options: { runtime: boolean }
): M => {
  const confirmed = terms?.get(termsKey(model.provider, model.apiModelId)) ?? null;
  if (!confirmed) return model;
  const next: M = { ...model, billingTerms: confirmed };
  if (options.runtime && confirmed.kind === "measured_output_limit") {
    next.maxOutputTokens = confirmed.maxOutputTokens;
    delete next.thinkingLevel;
  }
  return next;
};

// --- image resolution -------------------------------------------------------

export type CatalogRowInput = {
  modelId: string;
  enabled: boolean | null;
  holdReason: string | null;
  sortOrder: number | null;
  profile: unknown;
};

export type PriceRevisionInput = {
  modelId: string;
  pricingVersion: string;
  prices: unknown;
  verification: unknown;
  effectiveFrom: Date;
  /** Breaks a tie between revisions with the same effectiveFrom: the later write wins everywhere. */
  createdAt?: Date;
};

export type ImageAdmission = { admitted: true } | { admitted: false; reasons: readonly string[] };

type ImageExecutionFields = Pick<
  ImageModelProfile,
  "provider" | "apiModelId" | "maxOutputTokens" | "thinkingLevel" | "deliveryMimeType"
>;

/**
 * What an image request sends to the provider besides the prompt. Frozen into
 * the reservation: a runtime model's profile can be edited after the quote,
 * and the settlement prices from the reservation's snapshot, so a request
 * built from the edited profile would spend money the ledger never sees.
 */
export const imageExecutionProfile = (model: ImageExecutionFields) => ({
  provider: model.provider,
  apiModelId: model.apiModelId,
  maxOutputTokens: model.maxOutputTokens ?? null,
  thinkingLevel: model.thinkingLevel ?? null,
  deliveryMimeType: model.deliveryMimeType ?? null,
});

/**
 * Null when the model would still be called exactly as reserved; otherwise
 * why it may not be called. A snapshot written before this field existed has
 * nothing to compare and is not refused.
 */
export const imageExecutionDrift = (snapshot: unknown, model: ImageExecutionFields | null): string | null => {
  const frozen = (snapshot as { executionProfile?: unknown } | null)?.executionProfile;
  if (!frozen || typeof frozen !== "object") return null;
  if (!model) return "model_missing";
  const current = imageExecutionProfile(model);
  for (const [key, value] of Object.entries(current)) {
    if ((frozen as Record<string, unknown>)[key] !== value) return `${key}_changed`;
  }
  return null;
};

/**
 * Whether an image model may serve, from its resolved profile. Every condition
 * of image-generation policy section 12 that code can check:
 * a finite worst case, credits at or above the mathematical floor, a dated
 * verification from the provider's own documentation, and a provider budget.
 */
export const judgeImageModel = (
  model: ImageModelProfile,
  deps: {
    minimumCredits: (model: ImageModelProfile, price: ImageModelOptionPrice) => number | null;
    providerBudgetReady: (provider: string) => boolean;
  }
): ImageAdmission => {
  const reasons: string[] = [];
  if (model.prices.length === 0) reasons.push("no_prices");
  if (!model.priceVerification.verifiedAt) reasons.push("price_unverified");
  const sources = model.priceVerification.sources;
  if (sources.length === 0) reasons.push("no_price_sources");
  for (const source of sources) {
    if (!isOfficialSourceUrl(model.provider, source)) {
      reasons.push(`unofficial_source:${source}`);
    }
  }
  // A stated cap counts only where the request can hold it: a revision that
  // writes a number for a provider billing thinking per uncapped token has
  // stated a cost, not bounded one, and a cap below a flat surcharge the
  // request incurs anyway understates it.
  if (!imageThinkingCapEnforced(model)) {
    reasons.push("worst_case_cost_unbounded");
    const cap = model.priceVerification.thinkingCapMicroUsd;
    const minimum = imageThinkingCapMinimumMicroUsd(model.provider, model.apiModelId, model.billingTerms);
    if (cap !== null && minimum !== null && cap < minimum) {
      reasons.push(`thinking_cap_below_minimum:${minimum}`);
    }
    // A measured Google model is bounded only for the request that was measured.
    const bound = imageMeasuredOutputLimitBound(model);
    if (bound && (model.maxOutputTokens !== bound.maxOutputTokens || model.thinkingLevel)) {
      reasons.push(`measured_request_required:max_output_tokens_${bound.maxOutputTokens}_no_thinking_level`);
    }
  } else {
    // Confirmed image tokens hold the price as well as the thinking: an option
    // priced below its measured image tokens at the confirmed image rate is a
    // price older than the measurement, refused until a new draft is applied.
    // Per option for an OpenAI count; one count for every option on Google
    // (each size is requested at the 1K tier).
    const measured = billingTermsApplyTo(model.provider, model.billingTerms);
    for (const price of model.prices) {
      const tokens =
        measured?.kind === "tokens_per_image"
          ? measured.tokens.find((row) => row.quality === price.quality && row.size === price.size)?.tokens
          : measured?.kind === "measured_output_limit"
            ? measured.imageTokensPerImage
            : undefined;
      const rate =
        measured?.kind === "tokens_per_image" || measured?.kind === "measured_output_limit" ? measured.imageOutputUsdPerMTok : 0;
      if (tokens !== undefined && price.outputCostMicroUsd < Math.ceil(tokens * rate)) {
        reasons.push(`price_below_measured_cost:${price.quality}/${price.size}`);
      }
    }
    for (const price of model.prices) {
      const floor = deps.minimumCredits(model, price);
      if (floor === null || price.credits < floor) {
        reasons.push(`credits_below_floor:${price.quality}/${price.size}`);
      }
    }
  }
  if (!deps.providerBudgetReady(model.provider)) reasons.push("provider_budget_missing");
  return reasons.length === 0 ? { admitted: true } : { admitted: false, reasons };
};

/** One option's credit floor; null when the worst case is unbounded. */
export type ImageOptionFloor = { quality: string; size: string; floor: number | null };

/**
 * What an operator sees before applying an image price draft: each option's
 * credit floor, and what the judge would say at the draft's prices. Budget is
 * left out as at revision time (`createImagePriceRevision`): it is an
 * enable-time question. Null when the draft is not a price revision.
 */
export const reviewImageDraft = (
  model: ImageModelProfile,
  draft: { prices: readonly ImageModelOptionPrice[]; verification: ImageModelPriceVerification },
  deps: { minimumCredits: (model: ImageModelProfile, price: ImageModelOptionPrice) => number | null }
): { floors: ImageOptionFloor[]; reasons: readonly string[] } => {
  const candidate: ImageModelProfile = {
    ...model,
    disabledReason: null,
    prices: draft.prices,
    priceVerification: draft.verification,
  };
  const admission = judgeImageModel(candidate, { minimumCredits: deps.minimumCredits, providerBudgetReady: () => true });
  return {
    floors: draft.prices.map((price) => ({
      quality: price.quality,
      size: price.size,
      floor: deps.minimumCredits(candidate, price),
    })),
    reasons: admission.admitted ? [] : admission.reasons,
  };
};

export const imageCreditOverrideSchema = z
  .array(
    z
      .object({
        quality: z.enum(["low", "medium", "high"]),
        size: z.enum(["1024x1024", "1536x1024", "1024x1536"]),
        credits: z.number().int().positive().max(10_000),
      })
      .strict()
  )
  .max(9);
export type ImageCreditOverride = z.infer<typeof imageCreditOverrideSchema>[number];

/**
 * The draft's prices with the operator's credits. Only credits change: the
 * output cost is what the cited documentation says, and an option the draft
 * did not price cannot be added here. Returns the refused options otherwise.
 */
export const applyImageCreditOverrides = <P extends { quality: string; size: string; credits: number }>(
  prices: readonly P[],
  overrides: readonly ImageCreditOverride[]
): { ok: true; prices: P[]; edits: { quality: string; size: string; from: number; to: number }[] } | { ok: false; unknown: string[] } => {
  const byKey = new Map(overrides.map((override) => [`${override.quality}|${override.size}`, override.credits]));
  const known = new Set(prices.map((price) => `${price.quality}|${price.size}`));
  const unknown = [...byKey.keys()].filter((key) => !known.has(key));
  if (unknown.length > 0) return { ok: false, unknown };
  const edits: { quality: string; size: string; from: number; to: number }[] = [];
  const next = prices.map((price) => {
    const credits = byKey.get(`${price.quality}|${price.size}`);
    if (credits === undefined || credits === price.credits) return price;
    edits.push({ quality: price.quality, size: price.size, from: price.credits, to: credits });
    return { ...price, credits };
  });
  return { ok: true, prices: next, edits };
};

/**
 * The draft's version, or the first "-2", "-3", ... after it that no revision
 * of this model has used: a second draft applied the same day otherwise hits
 * pricing_version_reused. Stays within the 80-character version limit.
 */
export const freePricingVersion = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1_000; n += 1) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, 80 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
};

/** The latest revision per model whose effectiveFrom has passed. */
export const effectiveRevisions = (
  revisions: readonly PriceRevisionInput[],
  now: Date
): Map<string, PriceRevisionInput> => {
  const byModel = new Map<string, PriceRevisionInput>();
  for (const revision of revisions) {
    if (revision.effectiveFrom.getTime() > now.getTime()) continue;
    const current = byModel.get(revision.modelId);
    const later =
      !current ||
      revision.effectiveFrom.getTime() > current.effectiveFrom.getTime() ||
      (revision.effectiveFrom.getTime() === current.effectiveFrom.getTime() &&
        ((revision.createdAt?.getTime() ?? 0) > (current.createdAt?.getTime() ?? 0) ||
          ((revision.createdAt?.getTime() ?? 0) === (current.createdAt?.getTime() ?? 0) &&
            revision.pricingVersion > current.pricingVersion)));
    if (later) byModel.set(revision.modelId, revision);
  }
  return byModel;
};

const applyRevision = (
  model: ImageModelProfile,
  revision: PriceRevisionInput | undefined
): ImageModelProfile | null => {
  if (!revision) return model;
  const prices = imagePriceListSchema.safeParse(revision.prices);
  const verification = imageVerificationSchema.safeParse(revision.verification);
  // A malformed revision cannot price anything: the model is withheld rather
  // than served at its older code price under a newer version label.
  if (!prices.success || !verification.success) return null;
  return {
    ...model,
    prices: prices.data as readonly ImageModelOptionPrice[],
    pricingVersion: revision.pricingVersion,
    priceVerification: verification.data as ImageModelPriceVerification,
  };
};

export type ResolvedImageCatalog = {
  models: readonly ImageModelProfile[];
  /** Rows that could not be applied, by model id, for the admin surface. */
  problems: readonly { modelId: string; problem: string }[];
};

/**
 * Code seed + DB rows + effective price revisions -> the image catalogue.
 *
 * - `enabled: null` inherits the code profile's disabledReason;
 * - `enabled: false` or a hold reason is an operational hold;
 * - `enabled: true` serves only if `judgeImageModel` admits the resolved model;
 *   otherwise the first refusal becomes the disabled reason.
 */
export const resolveImageCatalog = (input: {
  seed: readonly ImageModelProfile[];
  rows: readonly CatalogRowInput[];
  revisions: readonly PriceRevisionInput[];
  now: Date;
  judge: (model: ImageModelProfile) => ImageAdmission;
  /** Confirmed billing terms (ImageModelBillingTerms rows); absent reads the code tables alone. */
  billingTerms?: readonly BillingTermsRowInput[];
}): ResolvedImageCatalog => {
  const problems: { modelId: string; problem: string }[] = [];
  const rowsById = new Map(input.rows.map((row) => [row.modelId, row]));
  const revisions = effectiveRevisions(input.revisions, input.now);
  const seedIds = new Set(input.seed.map((model) => model.id));
  const terms = latestBillingTerms(input.billingTerms ?? []);

  const bases: { model: ImageModelProfile; order: number }[] = input.seed.map((model, index) => ({
    model: withImageBillingTerms(model, terms, { runtime: false }),
    order: index,
  }));
  for (const row of input.rows) {
    if (seedIds.has(row.modelId)) continue;
    const full = imageFullProfileSchema.safeParse(row.profile);
    if (!full.success) {
      problems.push({ modelId: row.modelId, problem: "invalid_full_profile" });
      continue;
    }
    if (!revisions.has(row.modelId)) {
      problems.push({ modelId: row.modelId, problem: "no_price_revision" });
      continue;
    }
    bases.push({
      model: withImageBillingTerms(
        {
          id: row.modelId,
          ...full.data,
          disabledReason: "price_unverified",
          prices: [],
          pricingVersion: "unpriced",
          priceVerification: { verifiedAt: null, sources: [], thinkingCapMicroUsd: null },
        } as ImageModelProfile,
        terms,
        { runtime: true }
      ),
      order: input.seed.length + bases.length,
    });
  }

  const resolved: { model: ImageModelProfile; order: number }[] = [];
  for (const { model: base, order } of bases) {
    const row = rowsById.get(base.id);
    let model = base;
    if (row && seedIds.has(base.id) && row.profile !== null && row.profile !== undefined) {
      const override = imageProfileOverrideSchema.safeParse(row.profile);
      if (override.success) model = { ...model, ...override.data };
      else problems.push({ modelId: base.id, problem: "invalid_override" });
    }
    const revision = revisions.get(base.id);
    const priced = applyRevision(model, revision);
    if (!priced) {
      problems.push({ modelId: base.id, problem: "invalid_price_revision" });
      continue;
    }
    model = priced;

    let disabledReason: ImageModelDisabledReason | null = model.disabledReason;
    if (row?.holdReason || row?.enabled === false) {
      disabledReason = "operational_hold";
    } else {
      const wouldServe = row?.enabled === true || disabledReason === null;
      // The code seed as committed is checked by check:image-pricing. Anything
      // an operator added -- a row, a price revision, a whole model -- is
      // judged here before it can serve, so a revision priced below the floor
      // never serves just because the row said "inherit".
      // Confirmed billing terms (ImageModelBillingTerms) count too: they can
      // move a serving seed's worst case without a row or a revision.
      const operatorTouched = Boolean(row) || Boolean(revision) || !seedIds.has(base.id) || Boolean(model.billingTerms);
      if (wouldServe && operatorTouched) {
        const admission = input.judge({ ...model, disabledReason: null });
        disabledReason = admission.admitted ? null : reasonFor(admission.reasons);
      }
    }
    // A hold reason is an operator note: it stays on the admin surface and is
    // not sent to browsers as the model's public disabledNote.
    resolved.push({
      model: { ...model, disabledReason },
      order: row?.sortOrder ?? order,
    });
  }
  resolved.sort((a, b) => a.order - b.order);
  return { models: resolved.map((entry) => entry.model), problems };
};

const reasonFor = (reasons: readonly string[]): ImageModelDisabledReason => {
  if (reasons.includes("worst_case_cost_unbounded")) return "worst_case_cost_unbounded";
  if (reasons.some((r) => r.startsWith("price") || r.startsWith("no_price") || r.startsWith("unofficial"))) {
    return "price_unverified";
  }
  return "operational_hold";
};

// --- coding ------------------------------------------------------------------

export type CodingAdmission = { admitted: true } | { admitted: false; reasons: readonly string[] };

/**
 * Whether a coding model may be offered in managed mode
 * (TomverseCode product-strategy 17.6, docs/policy/code-task-cost-guardrails.md 6).
 * Provider conditions (terms, retention, region) are not judged (owner
 * decision 2026-11-21): chat models are added without them. What is judged is
 * the credit floor, a known provider with an established data destination,
 * official price sources and tool calling.
 */
export const judgeCodingModel = (
  profile: CodingJudgeInput,
  deps: {
    knownProvider: (provider: string) => boolean;
    providerDestinationEstablished: (provider: string) => boolean;
    /** The credits the worst task turn costs at this price, or null when it cannot be bounded. */
    creditFloor: (profile: CodingJudgeInput) => number | null;
  }
): CodingAdmission => {
  const reasons: string[] = [];
  const floor = deps.creditFloor(profile);
  if (floor === null) reasons.push("credit_floor_unbounded");
  else if (profile.pricing.creditWeight < floor) reasons.push(`credits_below_floor:${floor}`);
  if (!deps.knownProvider(profile.provider)) reasons.push("unknown_provider");
  if (!deps.providerDestinationEstablished(profile.provider)) reasons.push("provider_destination_unproven");
  for (const source of profile.pricing.sources) {
    if (!isOfficialSourceUrl(profile.provider, source)) reasons.push(`unofficial_price_source:${source}`);
  }
  if (profile.capabilities.toolCalling === "none") reasons.push("no_tool_calling");
  return reasons.length === 0 ? { admitted: true } : { admitted: false, reasons };
};

/**
 * What only Code's managed path needs of a chat link: a credit weight above the
 * worst turn with the whole context window as input, that window, separately
 * billed reasoning bounded, and a structured output to read a plan with. The
 * coding API runs a chat link as its chat model, under chat's input limit and
 * chat's credits, so none of this stands in its way (owner decision 2026-11-21).
 */
const CODE_ONLY_REASONS: readonly string[] = [
  "credit_floor_unbounded",
  "credits_below_floor",
  "chat_context_unknown",
  "reasoning_cost_unbounded",
  "no_structured_output",
];
const reasonName = (reason: string) => reason.split(":")[0];

export type CodingChannelJudgement = {
  /** Admitted when the row passes on at least one channel it is offered on. */
  admission: CodingAdmission;
  /** One channel's answer; null when the row is not offered there (or cannot be read). */
  code: CodingAdmission | null;
  api: CodingAdmission | null;
  /** The stored channels the row passes on, in their stored order: what a snapshot row lists and a channel serves. */
  effectiveChannels: CodingChannel[];
};

const admissionOf = (reasons: readonly string[]): CodingAdmission =>
  reasons.length === 0 ? { admitted: true } : { admitted: false, reasons: [...new Set(reasons)] };

/**
 * The judge's answer per channel for a resolved entry, with the refusals only
 * the resolution can see.
 *
 * A dedicated row has one answer for every channel it is offered on (the coding
 * API prices it by its own rule, lib/codingRowRuntime.ts). A chat link is judged
 * per channel: the coding API needs the chat side to pass, a known provider with
 * an established data destination, tool calling and a bounded provider cost;
 * Code needs all of that and CODE_ONLY_REASONS too. A row that passes on one
 * channel is offered there only.
 */
export const judgeCodingChannels = (
  resolution: Pick<CodingResolution, "source" | "row" | "problem" | "refusals">,
  judge: (row: CodingJudgeInput) => CodingAdmission
): CodingChannelJudgement => {
  const row = resolution.row;
  if (!row) {
    return { admission: { admitted: false, reasons: [resolution.problem ?? "no_profile"] }, code: null, api: null, effectiveChannels: [] };
  }
  const base = judge(row);
  const all = [...(base.admitted ? [] : base.reasons), ...resolution.refusals];
  const onCode = row.channels.includes("code");
  const onApi = onCodingApi(row.channels);
  const chatLink = resolution.source === "chat";
  const codeReasons = chatLink && row.capabilities.structuredOutput === "none" ? [...all, "no_structured_output"] : all;
  const code = onCode ? admissionOf(codeReasons) : null;
  const api = onApi ? admissionOf(chatLink ? all.filter((reason) => !CODE_ONLY_REASONS.includes(reasonName(reason))) : all) : null;
  const effectiveChannels = row.channels.filter((channel) => {
    const answer = channel === "code" ? code : api;
    return answer?.admitted === true;
  });
  if (effectiveChannels.length > 0) return { admission: { admitted: true }, code, api, effectiveChannels };
  const reasons = [...(code && !code.admitted ? code.reasons : []), ...(api && !api.admitted ? api.reasons : [])];
  return { admission: admissionOf(reasons), code, api, effectiveChannels };
};

/** Video has no activation policy yet: every video model is refused. */
export const judgeVideoModel = (): { admitted: false; reasons: readonly string[] } => ({
  admitted: false,
  reasons: ["no_activation_policy"],
});

// --- snapshots ---------------------------------------------------------------

/** Stable JSON: object keys sorted, so the hash names the content, not the order it was built in. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
};

export const catalogContentHash = (rows: readonly CodingCatalogRow[]): string =>
  createHash("sha256")
    .update(canonicalJson([...rows].sort((a, b) => (a.modelId < b.modelId ? -1 : 1))))
    .digest("hex");

/**
 * The hash of a stored snapshot's rows read through today's row schema, so a
 * snapshot written before a field gained a default compares as the content it
 * still is. Null when any row no longer parses (that content did change).
 */
export const normalizedSnapshotContentHash = (payload: unknown): string | null => {
  const models = (payload as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  const rows: CodingCatalogRow[] = [];
  for (const model of models) {
    const parsed = codingCatalogRowSchema.safeParse(model);
    if (!parsed.success) return null;
    rows.push(parsed.data);
  }
  return catalogContentHash(rows);
};

export const SNAPSHOT_COVERAGE_DAYS = 30;

export const snapshotCoverageUntil = (now: Date): Date =>
  new Date(now.getTime() + SNAPSHOT_COVERAGE_DAYS * 24 * 60 * 60 * 1000);

/** A snapshot past its coverage cannot price anything: fail closed. */
export const snapshotIsCurrent = (coverageUntil: Date, now: Date): boolean =>
  coverageUntil.getTime() > now.getTime();

/** With less coverage than this left, an unchanged snapshot is due a new version. */
export const SNAPSHOT_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type SnapshotRenewalDecision =
  | "no_snapshot"
  | "content_changed"
  | "not_due"
  | "renew";

/**
 * Whether the scheduled job may extend the newest snapshot's coverage.
 *
 * Only a renewal of identical content is automatic: `currentHash` is the hash
 * of what the judges admit right now, so a model an operator turned on or off,
 * a price or a hold that moved, or an admission that lapsed all differ from the
 * snapshot and wait for a person to publish. The first snapshot is a person's
 * too. An expired snapshot with unchanged content is still renewed -- the
 * content is judged current today, which is all coverage claims.
 */
export const decideSnapshotRenewal = (
  latest: { contentHash: string; coverageUntil: Date; normalizedHash?: string | null } | null,
  currentHash: string,
  now: Date
): SnapshotRenewalDecision => {
  if (!latest) return "no_snapshot";
  // A snapshot published before a row gained defaulted fields (links added
  // `source` and `channels`) hashes differently from the same content today;
  // its rows read through the current schema are what the managed path
  // compares, so that hash counts as the same content too.
  if (latest.contentHash !== currentHash && latest.normalizedHash !== currentHash) return "content_changed";
  return latest.coverageUntil.getTime() - now.getTime() > SNAPSHOT_RENEWAL_WINDOW_MS
    ? "not_due"
    : "renew";
};

// --- quote binding -----------------------------------------------------------

/**
 * Which requested models were quoted at a price version the server no longer
 * charges. An empty list means the quote still holds. A model the client sent
 * no version for is not checked (older clients).
 */
export const stalePricingVersions = (
  expected: Readonly<Record<string, string>> | undefined,
  current: (modelId: string) => string | null
): string[] => {
  if (!expected) return [];
  return Object.entries(expected)
    .filter(([modelId, version]) => current(modelId) !== version)
    .map(([modelId]) => modelId);
};

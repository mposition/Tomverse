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
import { confirmedImageBillingTermsSchema } from "@/lib/imageBillingMeasurementCore";
import { RUNTIME_IMAGE_PROVIDERS } from "@/lib/runtimeImageProviders";

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
  anthropic: ["www.anthropic.com", "anthropic.com", "docs.anthropic.com", "docs.claude.com", "www.claude.com"],
  // Google moved the Gemini API docs to AI Studio in 2026-11 and ai.google.dev
  // now answers 301. AI Studio also serves user-built apps and shared prompts,
  // so only its /docs/ path counts as documentation.
  google: ["ai.google.dev", "cloud.google.com", "aistudio.google.com/docs/"],
  xai: ["docs.x.ai", "x.ai"],
  fal: ["fal.ai"],
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

/** What an operator may override on an image model that has a code profile. */
export const imageProfileOverrideSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    shortName: z.string().trim().min(1).max(40),
    disabledNote: z.string().trim().min(1).max(500),
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
  })
  .strict();
export type ImageFullProfile = z.infer<typeof imageFullProfileSchema>;

/** A coding model the Code client may use in managed mode. */
export const codingProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    provider: z.string().trim().min(1).max(40),
    apiModelId: z.string().trim().min(1).max(120),
    minimumPlan: z.enum(["Free", "Pro", "Max"]),
    capabilities: z
      .object({
        toolCalling: z.enum(["none", "basic", "parallel"]),
        structuredOutput: z.enum(["none", "json_mode", "strict_schema", "forced_tool_use", "response_schema"]),
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
    terms: z
      .object({
        allowsResaleAndCodingAgent: z.boolean(),
        url: z.string().url(),
        checkedAt: isoDate,
      })
      .strict(),
    retention: z.object({ url: z.string().url(), checkedAt: isoDate }).strict(),
    processingRegion: z.string().trim().min(2).max(40),
  })
  .strict();
export type CodingProfile = z.infer<typeof codingProfileSchema>;

/**
 * What the operator may change in a coding draft before applying it: the
 * display name, the plan that sees the model and the credit weight. Prices,
 * capabilities and the terms and retention evidence are what the cited pages
 * say, so they are not editable; a different answer is a new draft.
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
      pricing: { ...draft.pricing, creditWeight: edit.creditWeight ?? draft.pricing.creditWeight },
    },
    edits,
  };
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
 * Terms and retention evidence are required; absence is refusal.
 */
export const judgeCodingModel = (
  profile: CodingProfile,
  deps: {
    knownProvider: (provider: string) => boolean;
    providerDestinationEstablished: (provider: string) => boolean;
    /** The credits the worst task turn costs at this price, or null when it cannot be bounded. */
    creditFloor: (profile: CodingProfile) => number | null;
  }
): CodingAdmission => {
  const reasons: string[] = [];
  const floor = deps.creditFloor(profile);
  if (floor === null) reasons.push("credit_floor_unbounded");
  else if (profile.pricing.creditWeight < floor) reasons.push(`credits_below_floor:${floor}`);
  if (!deps.knownProvider(profile.provider)) reasons.push("unknown_provider");
  if (!deps.providerDestinationEstablished(profile.provider)) reasons.push("provider_destination_unproven");
  if (!profile.terms.allowsResaleAndCodingAgent) reasons.push("terms_do_not_allow");
  if (!isOfficialSourceUrl(profile.provider, profile.terms.url)) reasons.push("terms_source_unofficial");
  if (!isOfficialSourceUrl(profile.provider, profile.retention.url)) reasons.push("retention_source_unofficial");
  for (const source of profile.pricing.sources) {
    if (!isOfficialSourceUrl(profile.provider, source)) reasons.push(`unofficial_price_source:${source}`);
  }
  if (profile.capabilities.toolCalling === "none") reasons.push("no_tool_calling");
  return reasons.length === 0 ? { admitted: true } : { admitted: false, reasons };
};

export type CodingCatalogRow = { modelId: string } & CodingProfile;

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
  latest: { contentHash: string; coverageUntil: Date } | null,
  currentHash: string,
  now: Date
): SnapshotRenewalDecision => {
  if (!latest) return "no_snapshot";
  if (latest.contentHash !== currentHash) return "content_changed";
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

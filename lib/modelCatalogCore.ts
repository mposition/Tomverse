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

import type {
  ImageModelDisabledReason,
  ImageModelOptionPrice,
  ImageModelPriceVerification,
  ImageModelProfile,
} from "@/lib/imageModelRegistry";

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
  google: ["ai.google.dev", "cloud.google.com"],
  xai: ["docs.x.ai", "x.ai"],
  fal: ["fal.ai"],
  deepseek: ["api-docs.deepseek.com"],
  mistral: ["docs.mistral.ai", "mistral.ai"],
  moonshot: ["platform.moonshot.ai"],
  qwen: ["www.alibabacloud.com", "help.aliyun.com"],
  zhipu: ["docs.z.ai"],
  minimax: ["platform.minimax.io"],
  groq: ["console.groq.com"],
  perplexity: ["docs.perplexity.ai"],
};

/**
 * Exact hosts only: a subdomain wildcard would admit user-written pages
 * (community.openai.com) as "official", and this list is also the fetch
 * allowlist for LLM drafts. No port, https only.
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
  return OFFICIAL_SOURCE_HOSTS[provider].includes(parsed.hostname);
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
    provider: z.enum(["openai", "google", "xai", "fal"]),
    modelOwner: z.enum(["openai", "google", "xai", "fal"]).optional(),
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
  if (model.priceVerification.thinkingCapMicroUsd === null) {
    reasons.push("worst_case_cost_unbounded");
  } else {
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
}): ResolvedImageCatalog => {
  const problems: { modelId: string; problem: string }[] = [];
  const rowsById = new Map(input.rows.map((row) => [row.modelId, row]));
  const revisions = effectiveRevisions(input.revisions, input.now);
  const seedIds = new Set(input.seed.map((model) => model.id));

  const bases: { model: ImageModelProfile; order: number }[] = input.seed.map((model, index) => ({
    model,
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
      model: {
        id: row.modelId,
        ...full.data,
        disabledReason: "price_unverified",
        prices: [],
        pricingVersion: "unpriced",
        priceVerification: { verifiedAt: null, sources: [], thinkingCapMicroUsd: null },
      } as ImageModelProfile,
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
      const operatorTouched = Boolean(row) || Boolean(revision) || !seedIds.has(base.id);
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

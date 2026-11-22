// Server side of the dynamic model catalogue: reads ModelCatalogEntry rows and
// price revisions, resolves them against the code seed with the judges in
// lib/modelCatalogCore.ts, and publishes the Code client's coding snapshot.
//
// If the database cannot be read the image catalogue stays the code seed
// (lib/imageModelRegistry.ts), so an outage never serves an unpriced model.
import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import { hasRegistryCredits } from "@/lib/externalApiCatalogCore";
import {
  IMAGE_MODEL_REGISTRY,
  minimumCreditsForImageOption,
  setActiveImageModelCatalog,
  type ImageModelProfile,
} from "@/lib/imageModelRegistry";
import { resolveImageProviderBudget } from "@/lib/imageProviderBudget";
import {
  CODING_API_CREDIT_WEIGHT_MAX,
  SNAPSHOT_RENEWAL_WINDOW_MS,
  catalogContentHash,
  codingCatalogRowSchema,
  codingProviderTermsSchema,
  decideSnapshotRenewal,
  normalizedSnapshotContentHash,
  judgeCodingModel,
  judgeCodingChannels,
  judgeImageModel,
  resolveCodingEntry,
  resolveImageCatalog,
  snapshotCoverageUntil,
  type ChatModelFacts,
  type CodingAdmission,
  type CodingCatalogRow,
  type CodingChannel,
  type CodingJudgeInput,
  type CodingProviderTerms,
  type CodingResolvedRow,
  type ImageAdmission,
  type ResolvedImageCatalog,
  type SnapshotRenewalDecision,
} from "@/lib/modelCatalogCore";
import { suggestCreditFloor } from "@/lib/modelAdoptionDraft";
import { COST_PER_CREDIT_CEILING_MICRO_USD } from "@/lib/chatCostGuardrails";
import { writeModelCatalogRenewalSystemAudit } from "@/lib/modelCatalogRenewalSystemAudit";
import { resolveModelPricing } from "@/lib/modelPricing";
import { isAiProvider } from "@/lib/modelRegistryShared";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";
import { providerDestinationIsEstablished } from "@/lib/providerDataDestinations";
import { getInputCreditMultiplier, getModelUsageProfile, type AiModel, type AiProvider } from "@/lib/models";

const IMAGE_CATALOG_TTL_MS = 15_000;

export const imageProviderBudgetReady = (provider: string): boolean =>
  resolveImageProviderBudget(process.env, {
    production: process.env.NODE_ENV === "production",
    provider: provider as ImageModelProfile["provider"],
  }).limits !== null;

export const judgeImage = (model: ImageModelProfile): ImageAdmission =>
  judgeImageModel(model, {
    minimumCredits: minimumCreditsForImageOption,
    providerBudgetReady: imageProviderBudgetReady,
  });

/**
 * Credits the worst coding turn costs at a profile's price, from the chat
 * catalogue's own rule (suggestCreditFloor). A coding task can fill the whole
 * context window, so the worst input is the model's context, not chat's 128k;
 * Anthropic's cache write premium is the input multiplier there.
 */
export const codingCreditFloor = (profile: Pick<CodingJudgeInput, "pricing" | "capabilities" | "provider">): number | null => {
  const worstCaseInputTokens = profile.capabilities.maxContextTokens;
  const floor = suggestCreditFloor({
    inputUsdPerMillionTokens: profile.pricing.inputUsdPerMTok,
    outputUsdPerMillionTokens: profile.pricing.outputUsdPerMTok,
    maxOutputTokens: profile.capabilities.maxOutputTokens,
    inputPriceMultiplier: profile.provider === "anthropic" ? 1.25 : 1,
    worstCaseInputTokens,
  });
  if ("credits" in floor) return floor.credits;
  // Above every chat class (80 credits at most): Code charges any whole number
  // of credits up to CODING_API_CREDIT_WEIGHT_MAX, so the floor is the same
  // cover worked out directly -- the fewest credits whose cover at that input
  // band meets the worst turn -- rather than refused (owner decision
  // 2026-11-22). Above the maximum it still cannot be worked out.
  if (floor.reason !== "above_every_class" || floor.worstCaseMicroUsd === null) return null;
  const coverPerCredit = getInputCreditMultiplier(worstCaseInputTokens) * COST_PER_CREDIT_CEILING_MICRO_USD;
  const credits = Math.ceil(Math.ceil(floor.worstCaseMicroUsd) / coverPerCredit);
  return credits > CODING_API_CREDIT_WEIGHT_MAX ? null : credits;
};

export const judgeCoding = (row: CodingJudgeInput): CodingAdmission =>
  judgeCodingModel(row, {
    knownProvider: isAiProvider,
    providerDestinationEstablished: (provider) =>
      isAiProvider(provider) && providerDestinationIsEstablished(provider as AiProvider),
    creditFloor: codingCreditFloor,
  });

/** Every confirmed billing terms row; the core keeps the latest per provider model. */
export const loadImageBillingTermRows = (
  client: Pick<Prisma.TransactionClient, "imageModelBillingTerms"> = prisma
) =>
  client.imageModelBillingTerms.findMany({
    select: { id: true, provider: true, apiModelId: true, terms: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

export const loadImageCatalog = async (now = new Date()): Promise<ResolvedImageCatalog> => {
  const [rows, revisions, billingTerms] = await Promise.all([
    prisma.modelCatalogEntry.findMany({ where: { category: "image" } }),
    prisma.modelCatalogPriceRevision.findMany({
      where: { category: "image", effectiveFrom: { lte: now } },
      orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }],
    }),
    loadImageBillingTermRows(),
  ]);
  return resolveImageCatalog({
    seed: IMAGE_MODEL_REGISTRY,
    rows,
    revisions,
    now,
    judge: judgeImage,
    billingTerms,
  });
};

let cached: { at: number; models: readonly ImageModelProfile[] } | null = null;
let inFlight: Promise<readonly ImageModelProfile[]> | null = null;
let generation = 0;

/**
 * Resolve the image catalogue and make it the one the registry lookups read.
 * Cached briefly so a burst of requests reads the database once; an operator's
 * change is live within IMAGE_CATALOG_TTL_MS (on this instance, at the next
 * refresh after the write invalidated the cache).
 *
 * A failed read keeps the last catalogue this process resolved: falling back
 * to the code seed would quietly lift an operator's hold. The seed is served
 * only if the database has never been read.
 */
export const refreshImageModelCatalog = async (
  options: { force?: boolean } = {}
): Promise<readonly ImageModelProfile[]> => {
  if (isE2EDatabaseDisabled()) return IMAGE_MODEL_REGISTRY;
  const now = Date.now();
  if (!options.force && cached && now - cached.at < IMAGE_CATALOG_TTL_MS) {
    setActiveImageModelCatalog(cached.models);
    return cached.models;
  }
  if (inFlight && !options.force) return inFlight;
  const started = generation;
  const load = (async () => {
    try {
      const { models } = await loadImageCatalog(new Date(now));
      // An invalidation during this read means the result may predate a
      // write: it is neither cached nor installed over a fresher catalogue.
      if (started !== generation) return models;
      cached = { at: now, models };
      setActiveImageModelCatalog(models);
      return models;
    } catch (error) {
      const kept = cached?.models ?? IMAGE_MODEL_REGISTRY;
      console.error(
        JSON.stringify({
          event: "model_catalog_image_read_failed",
          served: cached ? "last_resolved" : "code_seed",
          error: error instanceof Error ? error.message : "unknown",
        })
      );
      setActiveImageModelCatalog(kept);
      return kept;
    } finally {
      inFlight = null;
    }
  })();
  inFlight = load;
  return load;
};

export const invalidateImageModelCatalog = () => {
  generation += 1;
  if (cached) cached = { ...cached, at: 0 };
  inFlight = null;
};

// --- coding ------------------------------------------------------------------

/** Cost sources that are the conservative class fallback, i.e. a price nobody verified. */
const UNVERIFIED_COST_SOURCES = new Set(["conservative_fallback", "conservative_fallback_env_override"]);

/**
 * One chat registry model as the coding catalogue reads it. The price is the
 * one chat resolves at the long-context tier for the whole window -- what a
 * coding turn that fills the window is priced at -- so the coding floor and the
 * managed path's own pricing check see the same worst case.
 */
export const chatModelFacts = (model: AiModel): ChatModelFacts => {
  const context = model.contextWindowTokens ?? null;
  const pricing = resolveModelPricing(model, { estimatedPromptTokens: context ?? 0 });
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    apiModelId: model.apiModel,
    minimumPlan: model.minimumPlan === "Pro" ? "Pro" : "Free",
    usageClass: model.usageClass,
    creditWeight: getModelUsageProfile(model).credits,
    // The same condition the coding API serves frontier and apex models on.
    registryCredits: hasRegistryCredits(model),
    enabled: model.enabled,
    status: model.status,
    publiclyListed: model.publiclyListed !== false,
    catalogDeleted: model.catalogDeleted === true,
    contextWindowTokens: context,
    maxOutputTokens: pricing.maxOutputTokens,
    imageInput: model.inputCapabilities?.image === true,
    price: {
      inputUsdPerMTok: pricing.inputUsdPerMillionTokens,
      outputUsdPerMTok: pricing.outputUsdPerMillionTokens,
      pricingVersion: pricing.pricingVersion,
      effectiveDate: pricing.effectiveDate,
      verified: !UNVERIFIED_COST_SOURCES.has(pricing.costSource),
      reasoningBilledSeparately: pricing.reasoningTokenBilling === "billed_separately",
    },
  };
};

/** Every chat registry model, deleted ones included (a link to one is refused, not lost). */
export const loadChatModelFacts = async (): Promise<ChatModelFacts[]> =>
  (await getRuntimeModels({ includeCatalogDeleted: true })).map(chatModelFacts);

/**
 * A provider's conditions as applied before they were dropped as an admission
 * rule (owner decision 2026-11-21). Read only: a row of that provider still
 * carries them into its snapshot row, unjudged, so published content holds.
 */
export type CodingProviderTermsRecord = {
  provider: string;
  /** Null when nothing was applied, or the stored record does not parse. */
  terms: CodingProviderTerms | null;
};

export const loadCodingProviderTerms = async (
  client: Pick<Prisma.TransactionClient, "codingProviderTerms"> = prisma
): Promise<CodingProviderTermsRecord[]> =>
  (await client.codingProviderTerms.findMany({ orderBy: { provider: "asc" } })).map((row) => {
    const parsed = row.terms === null ? null : codingProviderTermsSchema.safeParse(row.terms);
    return { provider: row.provider, terms: parsed?.success ? parsed.data : null };
  });

export type CodingCatalogEntry = {
  modelId: string;
  enabled: boolean | null;
  holdReason: string | null;
  source: "dedicated" | "chat" | null;
  /** The resolved model (inherited values read in); null when the row cannot be read. */
  profile: CodingResolvedRow | null;
  problem: string | null;
  /** Admitted when the row passes on at least one channel it is offered on. */
  admission: CodingAdmission | null;
  /** Each channel's own answer (null: not offered there, or unreadable). A chat link can pass the coding API and not Code. */
  channelAdmission: { code: CodingAdmission | null; api: CodingAdmission | null };
  /** The stored channels the row passes on. */
  effectiveChannels: CodingChannel[];
  /** A chat link whose chat model has no context window (Code refuses it). */
  contextUnknown: boolean;
  /** The stored row (a dedicated profile, or a chat link's own values). */
  stored: unknown;
  draft: unknown;
  draftCreatedAt: Date | null;
};

export type CodingCatalogContext = {
  chat: readonly ChatModelFacts[];
  providerTerms: readonly CodingProviderTermsRecord[];
};

/** The lookups resolveCodingEntry takes, from loaded chat facts and provider records. */
export const codingLookups = (context: CodingCatalogContext) => {
  const chatById = new Map(context.chat.map((facts) => [facts.id, facts]));
  const termsByProvider = new Map(context.providerTerms.flatMap((record) => (record.terms ? [[record.provider, record.terms] as const] : [])));
  return {
    chat: (id: string) => chatById.get(id) ?? null,
    providerTerms: (provider: string) => termsByProvider.get(provider) ?? null,
  };
};

export const resolveCodingRow = (
  row: { modelId: string; enabled: boolean | null; holdReason: string | null; profile: unknown; draft: unknown; draftCreatedAt: Date | null },
  lookups: ReturnType<typeof codingLookups>
): CodingCatalogEntry => {
  const resolution = resolveCodingEntry({ modelId: row.modelId, profile: row.profile, ...lookups });
  const judgement = resolution.row || resolution.problem !== "no_profile" ? judgeCodingChannels(resolution, judgeCoding) : null;
  return {
    modelId: row.modelId,
    enabled: row.enabled,
    holdReason: row.holdReason,
    source: resolution.source,
    profile: resolution.row,
    problem: resolution.problem,
    admission: judgement?.admission ?? null,
    channelAdmission: { code: judgement?.code ?? null, api: judgement?.api ?? null },
    effectiveChannels: judgement?.effectiveChannels ?? [],
    contextUnknown: resolution.contextUnknown,
    stored: row.profile,
    draft: row.draft,
    draftCreatedAt: row.draftCreatedAt ?? null,
  };
};

/**
 * Every coding row, resolved: chat links read the chat registry now. `context`
 * lets a caller that already loaded the registry (the admin read) avoid a
 * second read.
 */
export const loadCodingCatalog = async (
  client: Pick<Prisma.TransactionClient, "modelCatalogEntry" | "codingProviderTerms"> = prisma,
  options: { context?: CodingCatalogContext } = {}
): Promise<CodingCatalogEntry[]> => {
  const [rows, context] = await Promise.all([
    client.modelCatalogEntry.findMany({
      where: { category: "coding" },
      orderBy: [{ sortOrder: "asc" }, { modelId: "asc" }],
    }),
    options.context ??
      Promise.all([loadChatModelFacts(), loadCodingProviderTerms(client)]).then(([chat, providerTerms]) => ({ chat, providerTerms })),
  ]);
  const lookups = codingLookups(context);
  return rows.map((row) => resolveCodingRow(row, lookups));
};

/**
 * Rows a snapshot may carry: enabled, not held, valid, admitted on at least one
 * channel -- the resolved values, inherited ones included. A row lists only the
 * channels it passes on (owner decision 2026-11-21): a chat link that fails
 * Code's rules but passes the coding API's is published for the coding API
 * alone, so Code's managed path, which compares this row with its snapshot row
 * and needs `code` in it, keeps Code's rules. A row that passes on every
 * channel it lists is returned as it resolved, so its published content does
 * not move.
 */
export const servableCodingRows = (entries: readonly CodingCatalogEntry[]): CodingCatalogRow[] =>
  entries.flatMap((entry) => {
    if (entry.enabled !== true || entry.holdReason || !entry.profile || entry.admission?.admitted !== true) return [];
    const channels = entry.effectiveChannels;
    return [channels.length === entry.profile.channels.length ? entry.profile : { ...entry.profile, channels }];
  });

/** A snapshot's rows that parse; a row published before links existed reads as a dedicated Code row. */
export const parseSnapshotRows = (models: readonly unknown[]): CodingCatalogRow[] =>
  models.flatMap((model) => {
    const parsed = codingCatalogRowSchema.safeParse(model);
    return parsed.success ? [parsed.data] : [];
  });

export type PublishedSnapshot = {
  version: number;
  contentHash: string;
  coverageUntil: Date;
  publishedAt: Date;
  models: CodingCatalogRow[];
};

const toPublished = (row: {
  version: number;
  contentHash: string;
  coverageUntil: Date;
  publishedAt: Date;
  payload: Prisma.JsonValue;
}): PublishedSnapshot => ({
  version: row.version,
  contentHash: row.contentHash,
  coverageUntil: row.coverageUntil,
  publishedAt: row.publishedAt,
  models: ((row.payload as { models?: CodingCatalogRow[] })?.models ?? []) as CodingCatalogRow[],
});

export const latestCodingSnapshot = async (): Promise<PublishedSnapshot | null> => {
  const row = await prisma.modelCatalogSnapshot.findFirst({
    where: { category: "coding" },
    orderBy: { version: "desc" },
  });
  return row ? toPublished(row) : null;
};

/**
 * Publish the admitted coding rows as a new immutable snapshot. Unchanged
 * content republishes nothing and returns the existing version.
 */
export const publishCodingSnapshot = async (input: {
  session: Session;
  request?: Request;
  now?: Date;
}): Promise<{ snapshot: PublishedSnapshot; created: boolean }> => {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    // Same lock as the scheduled renewal, taken before the catalogue and the
    // newest version are read, so a person and the job cannot each add a
    // version for one state, and a change committed while this waited is seen.
    await takeAuditChainLock(tx);
    const models = servableCodingRows(await loadCodingCatalog(tx));
    const contentHash = catalogContentHash(models);
    const latest = await tx.modelCatalogSnapshot.findFirst({
      where: { category: "coding" },
      orderBy: { version: "desc" },
    });
    // Same content as the newest snapshot and more than a week of coverage
    // left: nothing to publish. Otherwise a new version renews the coverage.
    if (
      latest &&
      latest.contentHash === contentHash &&
      latest.coverageUntil.getTime() - now.getTime() > SNAPSHOT_RENEWAL_WINDOW_MS
    ) {
      return { snapshot: toPublished(latest), created: false };
    }
    const created = await tx.modelCatalogSnapshot.create({
      data: {
        category: "coding",
        contentHash,
        payload: { models } as unknown as Prisma.InputJsonValue,
        coverageUntil: snapshotCoverageUntil(now),
        publishedById: input.session.user?.id ?? null,
      },
    });
    await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: "model_catalog.snapshot_published",
      targetType: "ModelCatalogSnapshot",
      targetId: String(created.version),
      summary: `Published coding catalogue snapshot v${created.version} (${models.length} models).`,
      metadata: { version: created.version, contentHash: created.contentHash, modelCount: models.length },
      tx,
    });
    return { snapshot: toPublished(created), created: true };
  });
};

/**
 * The scheduled job's renewal of the Code client's snapshot (Maintenance Cron).
 * Publishes a new version of the same content with a fresh coverage window when
 * the newest snapshot is within a week of its end -- or past it -- and the rows
 * the judges admit now hash to exactly that snapshot's. Anything else is left
 * to a person: a model enabled or held, a price or admission that moved, or no
 * snapshot at all returns its decision and writes nothing.
 *
 * Concurrent runs, or a run beside a manual publish, serialise on the audit
 * chain lock before the catalogue and the newest version are read; the loser
 * sees the renewed coverage and does nothing, so one state never gets two
 * versions.
 */
export const renewCodingSnapshotIfUnchanged = async (
  input: { now?: Date } = {}
): Promise<{
  decision: SnapshotRenewalDecision;
  version: number | null;
  coverageUntil: Date | null;
}> => {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    // The catalogue is read after the lock, in this transaction: a change an
    // operator committed while the job waited for it is part of what is judged,
    // so identical-looking content from before that change is never extended.
    await takeAuditChainLock(tx);
    const models = servableCodingRows(await loadCodingCatalog(tx));
    const contentHash = catalogContentHash(models);
    const latest = await tx.modelCatalogSnapshot.findFirst({
      where: { category: "coding" },
      orderBy: { version: "desc" },
    });
    const decision = decideSnapshotRenewal(
      latest ? { ...latest, normalizedHash: normalizedSnapshotContentHash(latest.payload) } : null,
      contentHash,
      now
    );
    if (decision !== "renew" || !latest) {
      return {
        decision,
        version: latest?.version ?? null,
        coverageUntil: latest?.coverageUntil ?? null,
      };
    }
    const created = await tx.modelCatalogSnapshot.create({
      data: {
        category: "coding",
        contentHash,
        payload: { models } as unknown as Prisma.InputJsonValue,
        coverageUntil: snapshotCoverageUntil(now),
        publishedById: null,
      },
    });
    await writeModelCatalogRenewalSystemAudit(tx, {
      targetId: String(created.version),
      summary: `Renewed coding catalogue snapshot v${latest.version} as v${created.version} (same content, ${models.length} models).`,
      metadata: {
        version: created.version,
        renewedFromVersion: latest.version,
        contentHash: created.contentHash,
        modelCount: models.length,
        previousCoverageUntil: latest.coverageUntil.toISOString(),
        coverageUntil: created.coverageUntil.toISOString(),
      },
    });
    return { decision, version: created.version, coverageUntil: created.coverageUntil };
  });
};

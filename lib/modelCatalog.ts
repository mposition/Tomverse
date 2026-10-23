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
import {
  IMAGE_MODEL_REGISTRY,
  minimumCreditsForImageOption,
  setActiveImageModelCatalog,
  type ImageModelProfile,
} from "@/lib/imageModelRegistry";
import { resolveImageProviderBudget } from "@/lib/imageProviderBudget";
import {
  SNAPSHOT_RENEWAL_WINDOW_MS,
  catalogContentHash,
  codingProfileSchema,
  decideSnapshotRenewal,
  judgeCodingModel,
  judgeImageModel,
  resolveImageCatalog,
  snapshotCoverageUntil,
  type CodingAdmission,
  type CodingCatalogRow,
  type CodingProfile,
  type ImageAdmission,
  type ResolvedImageCatalog,
  type SnapshotRenewalDecision,
} from "@/lib/modelCatalogCore";
import { suggestCreditFloor } from "@/lib/modelAdoptionDraft";
import { writeModelCatalogRenewalSystemAudit } from "@/lib/modelCatalogRenewalSystemAudit";
import { isAiProvider } from "@/lib/modelRegistryShared";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";
import { providerDestinationIsEstablished } from "@/lib/providerDataDestinations";
import type { AiProvider } from "@/lib/models";

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
export const codingCreditFloor = (profile: CodingProfile): number | null => {
  const floor = suggestCreditFloor({
    inputUsdPerMillionTokens: profile.pricing.inputUsdPerMTok,
    outputUsdPerMillionTokens: profile.pricing.outputUsdPerMTok,
    maxOutputTokens: profile.capabilities.maxOutputTokens,
    inputPriceMultiplier: profile.provider === "anthropic" ? 1.25 : 1,
    worstCaseInputTokens: profile.capabilities.maxContextTokens,
  });
  return "credits" in floor ? floor.credits : null;
};

export const judgeCoding = (row: CodingCatalogRow): CodingAdmission =>
  judgeCodingModel(row, {
    knownProvider: isAiProvider,
    providerDestinationEstablished: (provider) =>
      isAiProvider(provider) && providerDestinationIsEstablished(provider as AiProvider),
    creditFloor: codingCreditFloor,
  });

export const loadImageCatalog = async (now = new Date()): Promise<ResolvedImageCatalog> => {
  const [rows, revisions] = await Promise.all([
    prisma.modelCatalogEntry.findMany({ where: { category: "image" } }),
    prisma.modelCatalogPriceRevision.findMany({
      where: { category: "image", effectiveFrom: { lte: now } },
      orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }],
    }),
  ]);
  return resolveImageCatalog({
    seed: IMAGE_MODEL_REGISTRY,
    rows,
    revisions,
    now,
    judge: judgeImage,
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

export type CodingCatalogEntry = {
  modelId: string;
  enabled: boolean | null;
  holdReason: string | null;
  profile: CodingCatalogRow | null;
  problem: string | null;
  admission: CodingAdmission | null;
  draft: unknown;
};

export const loadCodingCatalog = async (
  client: Pick<Prisma.TransactionClient, "modelCatalogEntry"> = prisma
): Promise<CodingCatalogEntry[]> => {
  const rows = await client.modelCatalogEntry.findMany({
    where: { category: "coding" },
    orderBy: [{ sortOrder: "asc" }, { modelId: "asc" }],
  });
  return rows.map((row) => {
    const parsed = codingProfileSchema.safeParse(row.profile);
    const profile = parsed.success ? { modelId: row.modelId, ...parsed.data } : null;
    return {
      modelId: row.modelId,
      enabled: row.enabled,
      holdReason: row.holdReason,
      profile,
      problem: row.profile === null ? "no_profile" : parsed.success ? null : "invalid_profile",
      admission: profile ? judgeCoding(profile) : null,
      draft: row.draft,
    };
  });
};

/** Rows a snapshot may carry: enabled, not held, valid, admitted. */
export const servableCodingRows = (entries: readonly CodingCatalogEntry[]): CodingCatalogRow[] =>
  entries
    .filter(
      (entry) =>
        entry.enabled === true &&
        !entry.holdReason &&
        entry.profile !== null &&
        entry.admission?.admitted === true
    )
    .map((entry) => entry.profile as CodingCatalogRow);

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
    const decision = decideSnapshotRenewal(latest, contentHash, now);
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

// --- chat (view) -------------------------------------------------------------

export type ChatCatalogViewRow = {
  modelId: string;
  name: string;
  provider: string;
  enabled: boolean;
  status: string;
  publiclyListed: boolean;
  minimumPlan: string;
};

/** Chat models stay in ModelRegistryEntry; this is the catalogue's read-only view of them. */
export const loadChatCatalogView = async (): Promise<ChatCatalogViewRow[]> =>
  (await getRuntimeModels()).map((model) => ({
    modelId: model.id,
    name: model.name,
    provider: model.provider,
    enabled: model.enabled,
    status: model.status,
    publiclyListed: model.publiclyListed !== false,
    minimumPlan: model.minimumPlan,
  }));

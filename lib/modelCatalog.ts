// Server side of the dynamic model catalogue: reads ModelCatalogEntry rows and
// price revisions, resolves them against the code seed with the judges in
// lib/modelCatalogCore.ts, and publishes the Code client's coding snapshot.
//
// If the database cannot be read the image catalogue stays the code seed
// (lib/imageModelRegistry.ts), so an outage never serves an unpriced model.
import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import {
  IMAGE_MODEL_REGISTRY,
  minimumCreditsForImageOption,
  setActiveImageModelCatalog,
  type ImageModelProfile,
} from "@/lib/imageModelRegistry";
import { resolveImageProviderBudget } from "@/lib/imageProviderBudget";
import {
  catalogContentHash,
  codingProfileSchema,
  judgeCodingModel,
  judgeImageModel,
  resolveImageCatalog,
  snapshotCoverageUntil,
  type CodingAdmission,
  type CodingCatalogRow,
  type ImageAdmission,
  type ResolvedImageCatalog,
} from "@/lib/modelCatalogCore";
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

export const judgeCoding = (row: CodingCatalogRow): CodingAdmission =>
  judgeCodingModel(row, {
    knownProvider: isAiProvider,
    providerDestinationEstablished: (provider) =>
      isAiProvider(provider) && providerDestinationIsEstablished(provider as AiProvider),
  });

export const loadImageCatalog = async (now = new Date()): Promise<ResolvedImageCatalog> => {
  const [rows, revisions] = await Promise.all([
    prisma.modelCatalogEntry.findMany({ where: { category: "image" } }),
    prisma.modelCatalogPriceRevision.findMany({
      where: { category: "image", effectiveFrom: { lte: now } },
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

/**
 * Resolve the image catalogue and make it the one the registry lookups read.
 * Cached briefly so a burst of requests reads the database once; an operator's
 * change is live within IMAGE_CATALOG_TTL_MS.
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
  try {
    const { models } = await loadImageCatalog(new Date(now));
    cached = { at: now, models };
    setActiveImageModelCatalog(models);
    return models;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "model_catalog_image_read_failed",
        served: "code_seed",
        error: error instanceof Error ? error.message : "unknown",
      })
    );
    setActiveImageModelCatalog(IMAGE_MODEL_REGISTRY);
    return IMAGE_MODEL_REGISTRY;
  }
};

export const invalidateImageModelCatalog = () => {
  cached = null;
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

export const loadCodingCatalog = async (): Promise<CodingCatalogEntry[]> => {
  const rows = await prisma.modelCatalogEntry.findMany({
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
  const models = servableCodingRows(await loadCodingCatalog());
  const contentHash = catalogContentHash(models);
  return prisma.$transaction(async (tx) => {
    const latest = await tx.modelCatalogSnapshot.findFirst({
      where: { category: "coding" },
      orderBy: { version: "desc" },
    });
    // Same content as the newest snapshot and more than a week of coverage
    // left: nothing to publish. Otherwise a new version renews the coverage.
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    if (
      latest &&
      latest.contentHash === contentHash &&
      latest.coverageUntil.getTime() - now.getTime() > weekMs
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

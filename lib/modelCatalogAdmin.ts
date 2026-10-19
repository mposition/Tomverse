// Operator writes to the dynamic model catalogue. Every write commits with its
// audit row in one transaction, and turning a model on is refused unless the
// category's judge admits the resolved model.
import "server-only";

import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { z } from "zod";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { IMAGE_MODEL_REGISTRY } from "@/lib/imageModelRegistry";
import { invalidateImageModelCatalog, judgeCoding, judgeImage } from "@/lib/modelCatalog";
import {
  codingProfileSchema,
  imageFullProfileSchema,
  imagePriceListSchema,
  imageProfileOverrideSchema,
  imageVerificationSchema,
  isOfficialSourceUrl,
  MODEL_ID_PATTERN,
  resolveImageCatalog,
  type StoredCatalogCategory,
} from "@/lib/modelCatalogCore";
import { prisma } from "@/lib/prisma";

export class CatalogRefusal extends Error {
  constructor(
    readonly code: string,
    readonly reasons: readonly string[] = [],
    readonly status = 409
  ) {
    super(code);
  }
}

export const catalogEntryPatchSchema = z
  .object({
    enabled: z.boolean().nullable().optional(),
    holdReason: z.string().trim().min(1).max(500).nullable().optional(),
    sortOrder: z.number().int().min(0).max(10_000).nullable().optional(),
    profile: z.unknown().optional(),
  })
  .strict();
export type CatalogEntryPatch = z.infer<typeof catalogEntryPatchSchema>;

const validateProfile = (category: StoredCatalogCategory, modelId: string, profile: unknown) => {
  if (profile === null || profile === undefined) return profile;
  if (category === "coding") {
    const parsed = codingProfileSchema.safeParse(profile);
    if (!parsed.success) throw new CatalogRefusal("invalid_profile", parsed.error.issues.map((i) => i.path.join(".")), 400);
    return parsed.data;
  }
  const hasSeed = IMAGE_MODEL_REGISTRY.some((model) => model.id === modelId);
  const parsed = (hasSeed ? imageProfileOverrideSchema : imageFullProfileSchema).safeParse(profile);
  if (!parsed.success) throw new CatalogRefusal("invalid_profile", parsed.error.issues.map((i) => i.path.join(".")), 400);
  return parsed.data;
};

/** Would this image model serve if `enabled: true` were written? */
const imageAdmissionAfter = async (
  tx: Prisma.TransactionClient,
  modelId: string,
  next: { holdReason: string | null; sortOrder: number | null; profile: unknown }
) => {
  const now = new Date();
  const [rows, revisions] = await Promise.all([
    tx.modelCatalogEntry.findMany({ where: { category: "image" } }),
    tx.modelCatalogPriceRevision.findMany({ where: { category: "image", effectiveFrom: { lte: now } } }),
  ]);
  const others = rows.filter((row) => row.modelId !== modelId);
  let admission: { admitted: boolean; reasons?: readonly string[] } = { admitted: false, reasons: ["unknown_model"] };
  const { models } = resolveImageCatalog({
    seed: IMAGE_MODEL_REGISTRY,
    rows: [...others, { modelId, enabled: true, holdReason: next.holdReason, sortOrder: next.sortOrder, profile: next.profile }],
    revisions,
    now,
    judge: (model) => {
      const result = judgeImage(model);
      if (model.id === modelId) admission = result;
      return result;
    },
  });
  if (!models.some((model) => model.id === modelId)) {
    return { admitted: false, reasons: ["unknown_model_or_no_price_revision"] };
  }
  return admission;
};

export const updateCatalogEntry = async (input: {
  category: StoredCatalogCategory;
  modelId: string;
  patch: CatalogEntryPatch;
  session: Session;
  request?: Request;
}) => {
  const { category, modelId, patch, session } = input;
  if (!MODEL_ID_PATTERN.test(modelId)) throw new CatalogRefusal("invalid_model_id", [], 400);
  const profile = "profile" in patch ? validateProfile(category, modelId, patch.profile) : undefined;

  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.modelCatalogEntry.findUnique({
      where: { category_modelId: { category, modelId } },
    });
    const next = {
      enabled: patch.enabled === undefined ? (before?.enabled ?? null) : patch.enabled,
      holdReason: patch.holdReason === undefined ? (before?.holdReason ?? null) : patch.holdReason,
      sortOrder: patch.sortOrder === undefined ? (before?.sortOrder ?? null) : patch.sortOrder,
      profile: profile === undefined ? (before?.profile ?? null) : profile,
    };

    // Turning a model on (or keeping it on while changing what it is) needs the judge.
    if (next.enabled === true && !next.holdReason) {
      if (category === "image") {
        const admission = await imageAdmissionAfter(tx, modelId, next);
        if (!admission.admitted) throw new CatalogRefusal("not_admitted", admission.reasons ?? []);
      } else {
        const parsed = codingProfileSchema.safeParse(next.profile);
        if (!parsed.success) throw new CatalogRefusal("not_admitted", ["no_valid_profile"]);
        const admission = judgeCoding({ modelId, ...parsed.data });
        if (!admission.admitted) throw new CatalogRefusal("not_admitted", admission.reasons);
      }
    }

    const data = {
      enabled: next.enabled,
      holdReason: next.holdReason,
      sortOrder: next.sortOrder,
      profile: next.profile === null ? Prisma.DbNull : (next.profile as Prisma.InputJsonValue),
      updatedById: session.user?.id ?? null,
      updatedByEmail: session.user?.email ?? null,
    };
    const row = await tx.modelCatalogEntry.upsert({
      where: { category_modelId: { category, modelId } },
      create: { category, modelId, ...data },
      update: data,
    });
    await writeAdminAuditLog({
      session,
      request: input.request,
      action: "model_catalog.entry_updated",
      targetType: "ModelCatalogEntry",
      targetId: `${category}:${modelId}`,
      summary: `Updated ${category} catalogue entry ${modelId}.`,
      metadata: {
        category,
        modelId,
        before: before ? { enabled: before.enabled, holdReason: before.holdReason, sortOrder: before.sortOrder } : null,
        after: { enabled: next.enabled, holdReason: next.holdReason, sortOrder: next.sortOrder },
        profileChanged: profile !== undefined,
      },
      tx,
    });
    return row;
  });
  if (category === "image") invalidateImageModelCatalog();
  return result;
};

export const priceRevisionSchema = z
  .object({
    pricingVersion: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,80}$/),
    prices: imagePriceListSchema,
    verification: imageVerificationSchema,
    effectiveFrom: z.string().datetime().optional(),
  })
  .strict();

/**
 * Append a price revision. Not retroactive: effectiveFrom defaults to now and
 * may not be in the past. Sources must be the provider's own documentation.
 */
export const createImagePriceRevision = async (input: {
  modelId: string;
  revision: z.infer<typeof priceRevisionSchema>;
  session: Session;
  request?: Request;
  now?: Date;
}) => {
  const now = input.now ?? new Date();
  const { modelId, revision, session } = input;
  if (!MODEL_ID_PATTERN.test(modelId)) throw new CatalogRefusal("invalid_model_id", [], 400);
  const effectiveFrom = revision.effectiveFrom ? new Date(revision.effectiveFrom) : now;
  if (effectiveFrom.getTime() < now.getTime() - 60_000) {
    throw new CatalogRefusal("retroactive_price", [], 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.modelCatalogEntry.findUnique({
      where: { category_modelId: { category: "image", modelId } },
    });
    const seed = IMAGE_MODEL_REGISTRY.find((model) => model.id === modelId);
    const fullProfile = seed ? null : imageFullProfileSchema.safeParse(row?.profile);
    const provider = seed?.provider ?? (fullProfile?.success ? fullProfile.data.provider : null);
    if (!provider) throw new CatalogRefusal("unknown_model", [], 404);
    const unofficial = revision.verification.sources.filter((url) => !isOfficialSourceUrl(provider, url));
    if (unofficial.length > 0) throw new CatalogRefusal("unofficial_source", unofficial, 400);
    if (seed && seed.pricingVersion === revision.pricingVersion) {
      throw new CatalogRefusal("pricing_version_reused", [], 409);
    }
    const duplicate = await tx.modelCatalogPriceRevision.findUnique({
      where: {
        category_modelId_pricingVersion: { category: "image", modelId, pricingVersion: revision.pricingVersion },
      },
    });
    if (duplicate) throw new CatalogRefusal("pricing_version_reused", [], 409);

    const created = await tx.modelCatalogPriceRevision.create({
      data: {
        category: "image",
        modelId,
        pricingVersion: revision.pricingVersion,
        prices: revision.prices as Prisma.InputJsonValue,
        verification: revision.verification as Prisma.InputJsonValue,
        effectiveFrom,
        actorId: session.user?.id ?? null,
        actorEmail: session.user?.email ?? null,
      },
    });
    await writeAdminAuditLog({
      session,
      request: input.request,
      action: "model_catalog.price_revision_created",
      targetType: "ModelCatalogPriceRevision",
      targetId: created.id,
      summary: `New image price ${revision.pricingVersion} for ${modelId}, effective ${effectiveFrom.toISOString()}.`,
      metadata: {
        modelId,
        pricingVersion: revision.pricingVersion,
        effectiveFrom: effectiveFrom.toISOString(),
        previousPricingVersion: seed?.pricingVersion ?? null,
        prices: revision.prices,
        verification: revision.verification,
      },
      tx,
    });
    return created;
  });
  invalidateImageModelCatalog();
  return result;
};

/**
 * Turn a model-written draft into data, after a person looked at it.
 * Coding: the draft becomes the profile (still off until enabled).
 * Image: the draft's prices become a new price revision.
 */
export const applyCatalogDraft = async (input: {
  category: StoredCatalogCategory;
  modelId: string;
  session: Session;
  request?: Request;
}) => {
  const row = await prisma.modelCatalogEntry.findUnique({
    where: { category_modelId: { category: input.category, modelId: input.modelId } },
  });
  if (!row?.draft) throw new CatalogRefusal("no_draft", [], 404);
  if (input.category === "coding") {
    const parsed = codingProfileSchema.safeParse(row.draft);
    if (!parsed.success) throw new CatalogRefusal("invalid_draft", parsed.error.issues.map((i) => i.path.join(".")), 400);
    await updateCatalogEntry({
      category: "coding",
      modelId: input.modelId,
      patch: { profile: parsed.data },
      session: input.session,
      request: input.request,
    });
  } else {
    const parsed = priceRevisionSchema.safeParse(row.draft);
    if (!parsed.success) throw new CatalogRefusal("invalid_draft", parsed.error.issues.map((i) => i.path.join(".")), 400);
    await createImagePriceRevision({
      modelId: input.modelId,
      revision: parsed.data,
      session: input.session,
      request: input.request,
    });
  }
  await prisma.modelCatalogEntry.update({
    where: { category_modelId: { category: input.category, modelId: input.modelId } },
    data: { draft: Prisma.DbNull, draftSource: null, draftCreatedAt: null },
  });
};

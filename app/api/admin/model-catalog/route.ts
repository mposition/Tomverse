export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { IMAGE_MODEL_REGISTRY, type ImageModelProfile, minimumCreditsForImageOption } from "@/lib/imageModelRegistry";
import {
  codingCreditFloor,
  imageProviderBudgetReady,
  judgeCoding,
  judgeImage,
  latestCodingSnapshot,
  loadChatCatalogView,
  loadCodingCatalog,
  loadImageCatalog,
  publishCodingSnapshot,
} from "@/lib/modelCatalog";
import {
  applyCatalogDraft,
  CatalogRefusal,
  catalogPatchBodySchema,
  createImagePriceRevision,
  priceRevisionSchema,
  storeCatalogDraft,
  updateCatalogEntry,
} from "@/lib/modelCatalogAdmin";
import {
  codingDraftEditSchema,
  codingProfileSchema,
  defaultPriceSources,
  imageCreditOverrideSchema,
  imageFullProfileSchema,
  judgeVideoModel,
  MODEL_ID_PATTERN,
  OFFICIAL_SOURCE_HOSTS,
  reviewImageDraft,
  STORED_CATALOG_CATEGORIES,
} from "@/lib/modelCatalogCore";
import {
  catalogDraftLlmFromEnv,
  DraftRefusal,
  fetchOfficialPage,
  MAX_DRAFT_SOURCES,
  MODEL_CATALOG_DRAFT_LLM_MODEL_ENV,
} from "@/lib/modelCatalogDraftLlm";
import { prisma } from "@/lib/prisma";
import { AI_PROVIDERS } from "@/lib/modelRegistryShared";
import {
  RUNTIME_IMAGE_PROVIDERS,
  RUNTIME_IMAGE_QUALITIES,
  RUNTIME_IMAGE_SIZES,
  runtimeImageProfileTemplate,
} from "@/lib/runtimeImageProviders";

// The dynamic model catalogue (image and coding; chat is a read-only view of
// the model registry; video has no activation policy yet). Every write commits
// with its audit row and turning a model on runs the category's judge
// (lib/modelCatalogCore.ts).

const refusalResponse = (error: unknown) => {
  if (error instanceof CatalogRefusal) {
    return NextResponse.json({ error: error.code, reasons: error.reasons }, { status: error.status });
  }
  if (error instanceof DraftRefusal) {
    return NextResponse.json({ error: error.code, detail: error.detail }, { status: 422 });
  }
  return apiSecurityResponse(error);
};

/** A saved runtime profile as an unpriced model, for reviewing its draft; null when it does not parse. */
const runtimeImageBase = (modelId: string, profile: unknown): ImageModelProfile | null => {
  const parsed = imageFullProfileSchema.safeParse(profile);
  if (!parsed.success) return null;
  return {
    id: modelId,
    ...parsed.data,
    disabledReason: null,
    prices: [],
    pricingVersion: "unpriced",
    priceVerification: { verifiedAt: null, sources: [], thinkingCapMicroUsd: null },
  } as unknown as ImageModelProfile;
};

/** Floors and the judge's answer at a stored image draft's prices, or null. */
const reviewDraft = (base: ImageModelProfile | null, draft: unknown) => {
  const parsed = priceRevisionSchema.safeParse(draft);
  if (!base || !parsed.success) return null;
  return reviewImageDraft(base, parsed.data as never, { minimumCredits: minimumCreditsForImageOption });
};

/** A stored coding draft's floor and what the judge would say at its values, or null when it does not parse. */
const reviewCodingDraft = (modelId: string, draft: unknown) => {
  const parsed = codingProfileSchema.safeParse(draft);
  if (!parsed.success) return null;
  const admission = judgeCoding({ modelId, ...parsed.data });
  return { floor: codingCreditFloor(parsed.data), reasons: admission.admitted ? [] : [...admission.reasons] };
};

/** Providers a coding draft can read: known to the code, with official documentation hosts. */
const CODING_DRAFT_PROVIDERS = AI_PROVIDERS.filter((provider) => Object.hasOwn(OFFICIAL_SOURCE_HOSTS, provider));

const adminSession = async (write: boolean) => {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return { response: NextResponse.json({ error: "Not found." }, { status: 404 }) } as const;
  }
  if (write && !hasAdminPermission(session, "ops:write")) {
    return { response: NextResponse.json({ error: "Forbidden." }, { status: 403 }) } as const;
  }
  return { session } as const;
};

export async function GET(req: Request) {
  try {
    const auth = await adminSession(false);
    if ("response" in auth) return auth.response;
    await consumeApiRateLimit(req, auth.session.user.id, "admin-model-catalog", { minute: 30, day: 1_000 });

    const [image, imageRows, revisions, coding, chat, snapshot] = await Promise.all([
      loadImageCatalog(),
      prisma.modelCatalogEntry.findMany({ where: { category: "image" } }),
      prisma.modelCatalogPriceRevision.findMany({
        where: { category: "image" },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      loadCodingCatalog(),
      loadChatCatalogView(),
      latestCodingSnapshot(),
    ]);
    const rowById = new Map(imageRows.map((row) => [row.modelId, row]));
    const seedIds = new Set(IMAGE_MODEL_REGISTRY.map((model) => model.id));

    return NextResponse.json({
      image: {
        models: image.models.map((model) => {
          const row = rowById.get(model.id);
          return {
            id: model.id,
            name: model.name,
            provider: model.provider,
            apiModelId: model.apiModelId,
            sizes: model.sizes,
            qualities: model.qualities,
            source: seedIds.has(model.id) ? "code" : "catalog",
            enabled: row?.enabled ?? null,
            holdReason: row?.holdReason ?? null,
            sortOrder: row?.sortOrder ?? null,
            disabledReason: model.disabledReason,
            pricingVersion: model.pricingVersion,
            prices: model.prices,
            priceVerification: model.priceVerification,
            // What the judge would say if this model were turned on now.
            admissionIfEnabled: judgeImage({ ...model, disabledReason: null }),
            providerBudgetReady: imageProviderBudgetReady(model.provider),
            floors: model.prices.map((price) => ({
              quality: price.quality,
              size: price.size,
              floor: minimumCreditsForImageOption(model, price),
            })),
            draft: row?.draft ?? null,
            draftCreatedAt: row?.draftCreatedAt ?? null,
            draftReview: reviewDraft(model, row?.draft),
          };
        }),
        problems: image.problems,
        // Rows the catalogue could not resolve yet -- a runtime model whose
        // profile is saved but has no price revision, or a draft on its own --
        // so the panel can finish them instead of only naming the problem.
        pending: imageRows
          .filter((row) => !image.models.some((model) => model.id === row.modelId))
          .map((row) => ({
            modelId: row.modelId,
            profile: row.profile,
            draft: row.draft ?? null,
            draftCreatedAt: row.draftCreatedAt ?? null,
            draftReview: reviewDraft(runtimeImageBase(row.modelId, row.profile), row.draft),
            problem: image.problems.find((p) => p.modelId === row.modelId)?.problem ?? null,
          })),
        revisions,
        // What the add form offers: providers the code can call, the pricing
        // page a draft reads when the URL is left empty, and the hosts a URL may use.
        providers: RUNTIME_IMAGE_PROVIDERS.map((provider) => ({
          provider,
          defaultSources: defaultPriceSources(provider),
          hosts: OFFICIAL_SOURCE_HOSTS[provider] ?? [],
        })),
      },
      coding: {
        models: coding.map((entry) => ({
          ...entry,
          // The floor the judge holds the credit weight to, at the stored profile's prices.
          floor: entry.profile ? codingCreditFloor(entry.profile) : null,
          draftReview: reviewCodingDraft(entry.modelId, entry.draft),
        })),
        snapshot,
        // What the add form offers: a draft reads up to three official pages
        // (price, terms, retention); the price page may default.
        providers: CODING_DRAFT_PROVIDERS.map((provider) => ({
          provider,
          defaultSources: defaultPriceSources(provider),
          hosts: OFFICIAL_SOURCE_HOSTS[provider] ?? [],
        })),
      },
      chat: { models: chat, editable: false, editAt: "/admin/models?tab=registry" },
      video: { models: [], policy: judgeVideoModel() },
      draftLlm: {
        configured: Boolean(process.env[MODEL_CATALOG_DRAFT_LLM_MODEL_ENV]?.trim()),
        env: MODEL_CATALOG_DRAFT_LLM_MODEL_ENV,
      },
    });
  } catch (error) {
    return refusalResponse(error) ?? NextResponse.json({ error: "Catalog read failed." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await adminSession(true);
    if ("response" in auth) return auth.response;
    await consumeApiRateLimit(req, auth.session.user.id, "admin-model-catalog-write", { minute: 20, day: 300 });
    const body = await readLimitedJson(req, 32 * 1024, catalogPatchBodySchema);
    const { category, modelId, ...patch } = body;
    const row = await updateCatalogEntry({ category, modelId, patch, session: auth.session, request: req });
    return NextResponse.json({ ok: true, row });
  } catch (error) {
    return refusalResponse(error) ?? NextResponse.json({ error: "Catalog update failed." }, { status: 500 });
  }
}

const postBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("price_revision"),
    modelId: z.string().regex(MODEL_ID_PATTERN),
    revision: priceRevisionSchema,
  }),
  z.object({
    action: z.literal("draft"),
    category: z.enum(STORED_CATALOG_CATEGORIES),
    modelId: z.string().regex(MODEL_ID_PATTERN),
    provider: z.string().min(1).max(40),
    apiModelId: z.string().min(1).max(120),
    // Empty means the provider's default pricing pages.
    sourceUrls: z.array(z.string().url()).max(MAX_DRAFT_SOURCES),
    // The add form's choices for a runtime image model's profile.
    profile: z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        sizes: z.array(z.enum(RUNTIME_IMAGE_SIZES)).min(1).max(RUNTIME_IMAGE_SIZES.length).optional(),
        qualities: z.array(z.enum(RUNTIME_IMAGE_QUALITIES)).min(1).max(RUNTIME_IMAGE_QUALITIES.length).optional(),
      })
      .strict()
      .optional(),
  }),
  z.object({
    action: z.literal("apply_draft"),
    category: z.enum(STORED_CATALOG_CATEGORIES),
    modelId: z.string().regex(MODEL_ID_PATTERN),
    // Image: the operator's credits for options the draft priced. Costs and
    // sources stay the draft's; the revision is judged at these credits.
    creditOverrides: imageCreditOverrideSchema.optional(),
    // Coding: the operator's name, minimum plan and credit weight (at or
    // above the floor). Prices and evidence stay the draft's.
    codingEdit: codingDraftEditSchema.optional(),
  }),
  z.object({ action: z.literal("publish_snapshot") }),
]);

export async function POST(req: Request) {
  try {
    const auth = await adminSession(true);
    if ("response" in auth) return auth.response;
    await consumeApiRateLimit(req, auth.session.user.id, "admin-model-catalog-write", { minute: 20, day: 300 });
    const body = await readLimitedJson(req, 64 * 1024, postBodySchema);
    const session = auth.session;

    if (body.action === "price_revision") {
      const revision = await createImagePriceRevision({ modelId: body.modelId, revision: body.revision, session, request: req });
      return NextResponse.json({ ok: true, revision });
    }
    if (body.action === "apply_draft") {
      await applyCatalogDraft({
        category: body.category,
        modelId: body.modelId,
        creditOverrides: body.creditOverrides,
        codingEdit: body.codingEdit,
        session,
        request: req,
      });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "publish_snapshot") {
      const result = await publishCodingSnapshot({ session, request: req });
      return NextResponse.json({ ok: true, ...result });
    }

    // draft: one LLM call, only when the owner configured a model for it.
    const llm = await catalogDraftLlmFromEnv();
    if (!llm) {
      return NextResponse.json(
        { error: "draft_llm_not_configured", env: MODEL_CATALOG_DRAFT_LLM_MODEL_ENV },
        { status: 409 }
      );
    }
    // A runtime image model gets its request profile from the same form, so
    // the operator can apply the draft without saving a profile first.
    const imageProfile =
      body.category === "image" && !IMAGE_MODEL_REGISTRY.some((model) => model.id === body.modelId)
        ? runtimeImageProfileTemplate(body.provider, body.apiModelId, body.profile)
        : undefined;
    // Checked before the paid call, so a bad form fails for free.
    if (imageProfile !== undefined && !imageFullProfileSchema.safeParse(imageProfile).success) {
      return NextResponse.json({ error: "invalid_profile", detail: body.provider }, { status: 400 });
    }
    const sourceUrls = body.sourceUrls.length > 0 ? body.sourceUrls : defaultPriceSources(body.provider);
    if (sourceUrls.length === 0) return NextResponse.json({ error: "no_default_source", detail: body.provider }, { status: 422 });
    const pages = [];
    for (const url of sourceUrls) pages.push(await fetchOfficialPage(body.provider, url));
    const draft =
      body.category === "image"
        ? await llm.draftImagePrices({ provider: body.provider, apiModelId: body.apiModelId, pages })
        : await llm.draftCodingProfile({ provider: body.provider, apiModelId: body.apiModelId, pages });
    await storeCatalogDraft({ category: body.category, modelId: body.modelId, draft, imageProfile, session, request: req });
    return NextResponse.json({ ok: true, draft });
  } catch (error) {
    return refusalResponse(error) ?? NextResponse.json({ error: "Catalog action failed." }, { status: 500 });
  }
}

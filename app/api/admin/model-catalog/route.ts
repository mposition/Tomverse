export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { IMAGE_MODEL_REGISTRY } from "@/lib/imageModelRegistry";
import {
  imageProviderBudgetReady,
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
import { judgeVideoModel, MODEL_ID_PATTERN, STORED_CATALOG_CATEGORIES } from "@/lib/modelCatalogCore";
import {
  catalogDraftLlmFromEnv,
  DraftRefusal,
  fetchOfficialPage,
  MAX_DRAFT_SOURCES,
  MODEL_CATALOG_DRAFT_LLM_MODEL_ENV,
} from "@/lib/modelCatalogDraftLlm";
import { prisma } from "@/lib/prisma";

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
            draft: row?.draft ?? null,
          };
        }),
        problems: image.problems,
        revisions,
      },
      coding: { models: coding, snapshot },
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
    sourceUrls: z.array(z.string().url()).min(1).max(MAX_DRAFT_SOURCES),
  }),
  z.object({
    action: z.literal("apply_draft"),
    category: z.enum(STORED_CATALOG_CATEGORIES),
    modelId: z.string().regex(MODEL_ID_PATTERN),
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
      await applyCatalogDraft({ category: body.category, modelId: body.modelId, session, request: req });
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
    const pages = [];
    for (const url of body.sourceUrls) pages.push(await fetchOfficialPage(body.provider, url));
    const draft =
      body.category === "image"
        ? await llm.draftImagePrices({ provider: body.provider, apiModelId: body.apiModelId, pages })
        : await llm.draftCodingProfile({ provider: body.provider, apiModelId: body.apiModelId, pages });
    await storeCatalogDraft({ category: body.category, modelId: body.modelId, draft, session, request: req });
    return NextResponse.json({ ok: true, draft });
  } catch (error) {
    return refusalResponse(error) ?? NextResponse.json({ error: "Catalog action failed." }, { status: 500 });
  }
}

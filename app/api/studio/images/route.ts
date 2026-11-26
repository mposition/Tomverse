export const dynamic = "force-dynamic";
export const maxDuration = 968;

import { after } from "next/server";
import { z } from "zod";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { isImageGenerationEnabledCached } from "@/lib/appSettings";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { chatErrorResponse } from "@/lib/chatSecurity";
import { CATALOG_IMAGE_SIZES, RECRAFT_API_MODEL, RECRAFT_SIZE } from "@/lib/directRasterModels";
import { imageEditEnabled } from "@/lib/imageEditSource";
import { imageGroupMaxModels } from "@/lib/imageGroupLimits";
import { IMAGE_PHOTO_TOOL_CONTRACTS } from "@/lib/imagePhotoTools";
import { processImageGenerationGroup, requestImageGeneration } from "@/lib/imageGenerationService";
import { DEFAULT_IMAGE_MODEL_ID, getImageModel, getImageModelPrice, imageEditCredits, listEnabledImageModels } from "@/lib/imageModelRegistry";
import { resolveActiveImageProviderBudgets } from "@/lib/imageProviderBudget";
import { MessageAttachmentBindError } from "@/lib/messageAttachmentStorage";
import { refreshImageModelCatalog } from "@/lib/modelCatalog";
import { prisma } from "@/lib/prisma";
import { studioAvailable } from "@/lib/studioAvailability";
import { bindStudioImageUpload } from "@/lib/studioImageReference";
import { STUDIO_IMAGE_USE_CASES, type StudioImageUseCase } from "@/lib/studioTools";

const sizeSchema = z.enum(CATALOG_IMAGE_SIZES);
const useCaseSchema = z.enum(STUDIO_IMAGE_USE_CASES);
const routePreferencesSchema = z.record(z.string(), z.unknown());
const modelOrderSchema = z.array(z.string().min(1));
const qualities = ["medium", "high", "low"] as const;
const requestSchema = z.object({
  useCase: useCaseSchema.optional(),
  prompt: z.string().trim().min(1).max(4_000),
  size: sizeSchema,
  requestedSize: sizeSchema.optional(),
  squareFallback: z.boolean().optional(),
  uploadId: z.string().trim().min(1).max(100).optional(),
  idempotencyKey: z.uuid(),
  modelId: z.string().min(1).max(120),
  pricingVersion: z.string().min(1).max(120),
  quality: z.enum(qualities).optional(),
  credits: z.number().int().positive().optional(),
  // A feature served by several tools at once echoes each tool's quote.
  targets: z.array(z.object({
    modelId: z.string().min(1).max(120),
    pricingVersion: z.string().min(1).max(120),
    credits: z.number().int().positive(),
  }).strict()).min(1).max(4).optional(),
}).strict();

const unavailable = () => Response.json({ code: "STUDIO_GENERATION_UNAVAILABLE" }, { status: 503 });
const authenticated = async (req: Request) => {
  const auth = await resolveChatRouteSession(req);
  if (auth.response) return auth.response;
  const user = auth.session?.user;
  if (!user?.id || !user.email) return Response.json({ code: "AUTH_REQUIRED" }, { status: 401 });
  return { id: user.id, email: user.email };
};
const studioImagesEnabled = () => studioAvailable() && process.env.STUDIO_IMAGE_GENERATION_ENABLED === "true";

function studioModelPreference(useCase?: StudioImageUseCase): string[] {
  const config = process.env.STUDIO_IMAGE_ROUTE_PREFERENCES;
  if (!useCase || !config) return [];
  try {
    const routes = routePreferencesSchema.safeParse(JSON.parse(config)).data;
    return modelOrderSchema.safeParse(routes?.[useCase]).data ?? [];
  } catch {
    return [];
  }
}

async function studioQuote(size: z.infer<typeof sizeSchema>, edit: boolean, useCase?: StudioImageUseCase, squareFallback = false) {
  if (edit && !imageEditEnabled()) return null;
  await refreshImageModelCatalog();
  const budgeted = new Set(resolveActiveImageProviderBudgets().filter(row => row.resolved.limits).map(row => row.provider));
  if (useCase === "transparent-png") {
    // A cut-out keeps the photo's own pixels, which only a background remover
    // does: no image generator stands in for one. What to keep is a matter of
    // taste, so every remover that is on answers and the user picks.
    const targets = !edit ? [] : IMAGE_PHOTO_TOOL_CONTRACTS.flatMap(({ modelId }) => {
      const tool = getImageModel(modelId);
      const price = tool && budgeted.has(tool.provider) ? getImageModelPrice(tool.id, "medium", size) : null;
      const credits = tool && price ? imageEditCredits(tool, price) : null;
      return tool && credits ? [{ modelId: tool.id, model: tool.name, credits, pricingVersion: tool.pricingVersion }] : [];
    }).slice(0, imageGroupMaxModels());
    return targets.length === 0 ? null : {
      modelId: targets[0].modelId, model: targets.map(target => target.model).join(" + "),
      credits: targets.reduce((sum, target) => sum + target.credits, 0),
      quality: "medium" as const, size, pricingVersion: targets[0].pricingVersion, useCase, targets,
    };
  }
  const models = listEnabledImageModels().filter(model => budgeted.has(model.provider));
  const quotesAt = (outputSize: typeof size) => models.flatMap(model => {
    for (const quality of qualities) {
      const price = getImageModelPrice(model.id, quality, outputSize);
      if (!price) continue;
      const credits = edit ? imageEditCredits(model, price) : price.credits;
      if (credits) return [{
        modelId: model.id, model: model.name, credits, quality, size: outputSize, pricingVersion: model.pricingVersion, useCase,
        ...(outputSize !== size ? { requestedSize: size, squareFallback } : {}),
      }];
    }
    return [];
  });
  const quotes = quotesAt(size);
  const squareQuotes = squareFallback && size !== "1024x1024" ? quotesAt("1024x1024") : [];
  if (useCase === "real-sticker-pack" || useCase === "real-sticker") {
    // Use the exact photo-edit configuration evaluated for both packs and replacements.
    const square = size === "1024x1024" ? quotes : squareQuotes;
    return edit ? square.find(quote => quote.modelId === "gpt-image-2.6-sunburst" && quote.quality === "medium") ?? null : null;
  }
  for (const id of studioModelPreference(useCase)) {
    const preferred = quotes.find(quote => quote.modelId === id) ?? squareQuotes.find(quote => quote.modelId === id);
    if (preferred) return preferred;
    if (id === RECRAFT_API_MODEL && size !== RECRAFT_SIZE) {
      const native = quotesAt(RECRAFT_SIZE).find(quote => quote.modelId === id);
      if (native) return native;
    }
  }
  // Without a verified feature preference, keep the requested shape if it is available.
  const compatible = quotes.length > 0 ? quotes : squareQuotes;
  return compatible.find(quote => quote.modelId === DEFAULT_IMAGE_MODEL_ID) ??
    compatible.find(quote => quote.quality === "medium") ?? compatible[0] ?? null;
}

export async function GET(req: Request) {
  try {
    const user = await authenticated(req);
    if (user instanceof Response) return user;
    if (!studioImagesEnabled() || !(await isImageGenerationEnabledCached())) return unavailable();
    await consumeApiRateLimit(req, user.id, "studio-image-quote", { minute: 60, day: 1_000 });
    const params = new URL(req.url).searchParams;
    const size = sizeSchema.safeParse(params.get("size"));
    if (!size.success) return Response.json({ code: "IMAGE_OPTION_NOT_SUPPORTED" }, { status: 400 });
    const useCase = useCaseSchema.optional().safeParse(params.get("useCase") ?? undefined);
    if (!useCase.success) return Response.json({ code: "STUDIO_USE_CASE_NOT_SUPPORTED" }, { status: 400 });
    const quote = await studioQuote(
      size.data, params.get("edit") === "true", useCase.data, params.get("squareFallback") === "true",
    );
    return quote ? Response.json(quote, { headers: { "Cache-Control": "no-store" } }) : unavailable();
  } catch (error) {
    return apiSecurityResponse(error) ?? unavailable();
  }
}

export async function POST(req: Request) {
  try {
    const user = await authenticated(req);
    if (user instanceof Response) return user;
    if (!studioImagesEnabled()) return unavailable();
    await consumeApiRateLimit(req, user.id, "image-generation", { minute: 6, day: 500 });
    const body = await readLimitedJson(req, 24 * 1024, requestSchema);
    // A completed reservation is a receipt even if the quote has changed.
    const receipt = await prisma.imageGenerationGroup.findUnique({
      where: { userId_groupIdempotencyKey: { userId: user.id, groupIdempotencyKey: body.idempotencyKey } },
      select: { id: true },
    });
    if (receipt) return Response.json({ groupId: receipt.id });

    const quote = await studioQuote(body.requestedSize ?? body.size, Boolean(body.uploadId), body.useCase, body.squareFallback);
    // Open tabs from the previous release only know the versioned Medium
    // quote. Feature-routed submissions always echo the exact quote.
    const legacyMedium = body.useCase === undefined && body.quality === undefined && body.credits === undefined;
    const quoted = quote && "targets" in quote ? quote.targets : undefined;
    const sameTargets = quoted
      ? body.targets?.length === quoted.length && quoted.every((target, index) =>
        target.modelId === body.targets?.[index].modelId && target.pricingVersion === body.targets[index].pricingVersion &&
        target.credits === body.targets[index].credits)
      : body.targets === undefined;
    if (!quote || !sameTargets || quote.modelId !== body.modelId || quote.pricingVersion !== body.pricingVersion ||
        quote.size !== body.size ||
        (legacyMedium ? quote.quality !== "medium" : quote.quality !== body.quality || quote.credits !== body.credits)) {
      return Response.json({ code: "STUDIO_QUOTE_CHANGED" }, { status: 409 });
    }
    const { uploadId } = body;
    const result = await requestImageGeneration({
      userId: user.id,
      prompt: body.prompt,
      quality: quote.quality,
      size: body.size,
      idempotencyKey: body.idempotencyKey,
      // Only the quote above names a photo tool: the ids are this feature's own, never the caller's.
      ...(quoted ? {
        modelIds: quoted.map(target => target.modelId),
        expectedPricingVersions: Object.fromEntries(quoted.map(target => [target.modelId, target.pricingVersion])),
        photoTools: quoted.map(target => target.modelId),
      } : {
        modelIds: [body.modelId],
        expectedPricingVersions: { [body.modelId]: body.pricingVersion },
      }),
      ...(uploadId ? {
        editSource: {
          bindAttachment: (tx, conversationId) => bindStudioImageUpload(tx, {
            userId: user.id, email: user.email, conversationId, uploadId, prompt: body.prompt,
          }),
        },
      } : {}),
    });
    if (!result.reused && result.status === "pending") {
      after(() => processImageGenerationGroup([result.generationId]).catch(() => {
        console.error("Studio image processing failed", { generationId: result.generationId });
      }));
    }
    return Response.json({ groupId: result.groupId }, { status: result.reused ? 200 : 202 });
  } catch (error) {
    if (error instanceof MessageAttachmentBindError) {
      return Response.json({ code: "STUDIO_INVALID_REFERENCE" }, { status: 400 });
    }
    return chatErrorResponse(error) ?? apiSecurityResponse(error) ?? unavailable();
  }
}

export const dynamic = "force-dynamic";
export const maxDuration = 968;

import { after } from "next/server";
import { z } from "zod";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { isImageGenerationEnabledCached } from "@/lib/appSettings";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { chatErrorResponse } from "@/lib/chatSecurity";
import { imageEditEnabled } from "@/lib/imageEditSource";
import { processImageGenerationGroup, requestImageGeneration } from "@/lib/imageGenerationService";
import { DEFAULT_IMAGE_MODEL_ID, getImageModelPrice, imageEditCredits, listEnabledImageModels } from "@/lib/imageModelRegistry";
import { MessageAttachmentBindError } from "@/lib/messageAttachmentStorage";
import { refreshImageModelCatalog } from "@/lib/modelCatalog";
import { prisma } from "@/lib/prisma";
import { studioAvailable } from "@/lib/studioAvailability";
import { bindStudioImageUpload } from "@/lib/studioImageReference";

const sizeSchema = z.enum(["1024x1024", "1536x1024", "1024x1536"]);
const requestSchema = z.object({
  prompt: z.string().trim().min(1).max(4_000),
  size: sizeSchema,
  uploadId: z.string().trim().min(1).max(100).optional(),
  idempotencyKey: z.uuid(),
  modelId: z.string().min(1).max(120),
  pricingVersion: z.string().min(1).max(120),
}).strict();

const quality = "medium";
const unavailable = () => Response.json({ code: "STUDIO_GENERATION_UNAVAILABLE" }, { status: 503 });
const authenticated = async (req: Request) => {
  const auth = await resolveChatRouteSession(req);
  if (auth.response) return auth.response;
  const user = auth.session?.user;
  if (!user?.id || !user.email) return Response.json({ code: "AUTH_REQUIRED" }, { status: 401 });
  return { id: user.id, email: user.email };
};
const studioImagesEnabled = () => studioAvailable() && process.env.STUDIO_IMAGE_GENERATION_ENABLED === "true";

async function studioQuote(size: z.infer<typeof sizeSchema>, edit: boolean) {
  if (edit && !imageEditEnabled()) return null;
  await refreshImageModelCatalog();
  const eligible = listEnabledImageModels().flatMap(model => {
    const price = getImageModelPrice(model.id, quality, size);
    if (!price) return [];
    const credits = edit ? imageEditCredits(model, price) : price.credits;
    return credits ? [{ modelId: model.id, model: model.name, credits, pricingVersion: model.pricingVersion }] : [];
  });
  return eligible.find(option => option.modelId === DEFAULT_IMAGE_MODEL_ID) ?? eligible[0] ?? null;
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
    const quote = await studioQuote(size.data, params.get("edit") === "true");
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

    const quote = await studioQuote(body.size, Boolean(body.uploadId));
    if (!quote || quote.modelId !== body.modelId || quote.pricingVersion !== body.pricingVersion) {
      return Response.json({ code: "STUDIO_QUOTE_CHANGED" }, { status: 409 });
    }
    const { uploadId } = body;
    const result = await requestImageGeneration({
      userId: user.id,
      prompt: body.prompt,
      quality,
      size: body.size,
      idempotencyKey: body.idempotencyKey,
      modelIds: [body.modelId],
      expectedPricingVersions: { [body.modelId]: body.pricingVersion },
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

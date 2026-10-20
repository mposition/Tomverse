export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { isImageGenerationEnabledCached } from "@/lib/appSettings";
import { effectivePlanModelLimit, getUserBillingPlan, planAllowsFeature } from "@/lib/billingEntitlements";
import { assertUserOperationalAccess } from "@/lib/chatSecurity";
import { refreshImageModelCatalog } from "@/lib/modelCatalog";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { reviewEasyEnabled, routeReviewPrompt } from "@/lib/reviewRouting";
import { REVIEW_MAX_PROVIDERS, reviewRoutingCandidates } from "@/lib/reviewRoutingCore";

const schema = z.object({
  text: z.string().trim().min(1).max(8_000), context: z.string().max(1_200).default(""),
  providers: z.array(z.string().min(1).max(40)).min(1).max(REVIEW_MAX_PROVIDERS)
    .refine(values => new Set(values).size === values.length),
  hasImages: z.boolean().default(false),
  requestedKind: z.literal("image").optional(),
}).strict();

export async function POST(req: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    if (!reviewEasyEnabled()) return NextResponse.json({ error: "EASY_UNAVAILABLE" }, { status: 503, headers });
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "SIGN_IN_REQUIRED" }, { status: 401, headers });
    const userId = session.user.id;
    await assertUserOperationalAccess(userId);
    await consumeApiRateLimit(req, userId, "review-routing", { minute: 20, day: 500 });
    const body = await readLimitedJson(req, 48 * 1024, schema);
    const [plan, models] = await Promise.all([getUserBillingPlan(userId), getRuntimeModels()]);
    if (body.providers.length > effectivePlanModelLimit(plan)) {
      return NextResponse.json({ error: "MODEL_LIMIT_EXCEEDED" }, { status: 400, headers });
    }
    const imagesAvailable = await isImageGenerationEnabledCached() && planAllowsFeature(plan, "imageGeneration");
    if (body.requestedKind === "image" && !imagesAvailable) {
      return NextResponse.json({ error: "IMAGE_UNAVAILABLE" }, { status: 403, headers });
    }
    const imageModels = await refreshImageModelCatalog();
    const candidates = reviewRoutingCandidates({ providers: body.providers, models, imageModels, plan: plan.tier, hasImages: body.hasImages });
    if (body.providers.some(provider => !candidates.text.some(model => model.provider === provider))) {
      return NextResponse.json({ error: "PROVIDER_UNAVAILABLE" }, { status: 400, headers });
    }
    const decision = await routeReviewPrompt({ ...body, models, candidates });
    if (decision?.kind === "image" && decision.choices.some(choice => choice.modelId) && !imagesAvailable) {
      return NextResponse.json({ error: "IMAGE_UNAVAILABLE" }, { status: 403, headers });
    }
    return decision ? NextResponse.json(decision, { headers })
      : NextResponse.json({ error: "ROUTING_UNAVAILABLE" }, { status: 503, headers });
  } catch (error) {
    return apiSecurityResponse(error) ?? NextResponse.json({ error: "ROUTING_UNAVAILABLE" }, { status: 503, headers });
  }
}

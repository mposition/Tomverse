export const dynamic = "force-dynamic";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { effectivePlanModelLimit, getUserBillingPlan, planAllowsFeature } from "@/lib/billingEntitlements";
import { isAssistantProfilesEnabled, isImageGenerationEnabledCached } from "@/lib/appSettings";
import { refreshImageModelCatalog } from "@/lib/modelCatalog";
import { imageModelOwner } from "@/lib/imageModelRegistry";
import { imageGroupMaxModels } from "@/lib/imageGroupLimits";
import { reviewEasyEnabled } from "@/lib/reviewRouting";
import { consumeApiRateLimit, apiSecurityResponse } from "@/lib/apiSecurity";

export async function GET(request: Request) {
  try {
  const authentication = await resolveChatRouteSession(request);
  if (authentication.response) return authentication.response;
  if (!authentication.session?.user?.id) return Response.json({ code: "SIGN_IN_REQUIRED" }, { status: 401 });
  await consumeApiRateLimit(request, authentication.session.user.id, "native-capabilities-read", { minute: 60, day: 5000 });
  const [plan, assistants, imageEnabled, catalog] = await Promise.all([getUserBillingPlan(authentication.session.user.id), isAssistantProfilesEnabled(), isImageGenerationEnabledCached(), refreshImageModelCatalog()]);
  const images = { enabled: imageEnabled && planAllowsFeature(plan, "imageGeneration"), maxModels: imageGroupMaxModels(), models: catalog.filter(model => !model.disabledReason).map(model => ({
    id: model.id, name: model.name, provider: imageModelOwner(model), pricingVersion: model.pricingVersion,
    prices: model.prices.map(price => ({ quality: price.quality, size: price.size, credits: price.credits })),
  })) };
  return Response.json({ reviewEasy: reviewEasyEnabled(), maxModels: effectivePlanModelLimit(plan), assistants, plan: plan.tier, images }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiSecurityResponse(error) ?? Response.json({ code: "NATIVE_PARITY_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}

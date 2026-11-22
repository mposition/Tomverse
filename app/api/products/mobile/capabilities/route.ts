export const dynamic = "force-dynamic";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { effectivePlanModelLimit, getUserBillingPlan, planAllowsFeature } from "@/lib/billingEntitlements";
import { getOperationalFeatureFlags, isAssistantProfilesEnabled, isAssistantKnowledgeEnabled, isExternalImportEnabled, isImageGenerationEnabledCached } from "@/lib/appSettings";
import { generatedArtifactRevisionEnabled } from "@/lib/generatedArtifactRevisionCore";
import { refreshImageModelCatalog } from "@/lib/modelCatalog";
import { imageModelOwner } from "@/lib/imageModelRegistry";
import { imageGroupMaxModels } from "@/lib/imageGroupLimits";
import { imageEditEnabled } from "@/lib/imageEditSource";
import { chatImageTriageModelId } from "@/lib/chatImageIntent";
import { researchPreviewFeatures } from "@/lib/researchPreviewFeatures";
import { reviewEasyEnabled } from "@/lib/reviewRouting";
import { consumeApiRateLimit, apiSecurityResponse } from "@/lib/apiSecurity";

export async function GET(request: Request) {
  try {
  const authentication = await resolveChatRouteSession(request);
  if (authentication.response) return authentication.response;
  if (!authentication.session?.user?.id) return Response.json({ code: "SIGN_IN_REQUIRED" }, { status: 401 });
  await consumeApiRateLimit(request, authentication.session.user.id, "native-capabilities-read", { minute: 60, day: 5000 });
  const workspaceEnabled = process.env.TOMVERSE_NATIVE_CHAT_ENABLED === "true" && process.env.TOMVERSE_NATIVE_PARITY_ENABLED === "true" && process.env.TOMVERSE_NATIVE_WORKSPACE_ENABLED === "true";
  const [plan, assistants, knowledge, externalImport, imageEnabled, catalog, triageModelId, flags] = await Promise.all([getUserBillingPlan(authentication.session.user.id), isAssistantProfilesEnabled(), workspaceEnabled ? isAssistantKnowledgeEnabled() : false, workspaceEnabled ? isExternalImportEnabled() : false, isImageGenerationEnabledCached(), refreshImageModelCatalog(), chatImageTriageModelId(), getOperationalFeatureFlags()]);
  const workspace = { assistantEditing: workspaceEnabled && assistants, assistantKnowledge: workspaceEnabled && knowledge, externalImport: workspaceEnabled && externalImport };
  // The same three conditions the web composer asks before it checks a photo.
  const chatImageEdits = imageEnabled && planAllowsFeature(plan, "imageGeneration") && triageModelId !== null && imageEditEnabled();
  const images = { enabled: imageEnabled && planAllowsFeature(plan, "imageGeneration"), maxModels: imageGroupMaxModels(), models: catalog.filter(model => !model.disabledReason).map(model => ({
    id: model.id, name: model.name, provider: imageModelOwner(model), pricingVersion: model.pricingVersion,
    prices: model.prices.map(price => ({ quality: price.quality, size: price.size, credits: price.credits })),
  })) };
  const researchFeatures = researchPreviewFeatures();
  const researchPreview = { enabled: researchFeatures.nativeStart, pageReading: researchFeatures.pageReading, durableRuns: researchFeatures.durableRuns };
  return Response.json({ reviewAnalysis: { crossReview: true, quickSummary: true }, researchPreview, generatedFileRevisions: generatedArtifactRevisionEnabled() && flags.attachmentsEnabled && plan.allowAttachments, historyFeatures: { sharing: plan.allowSharing, downloads: plan.allowDownloads }, historyActions: true, projectWorkspace: process.env.TOMVERSE_NATIVE_PARITY_ENABLED === "true" && process.env.TOMVERSE_NATIVE_PROJECT_WORKSPACE_ENABLED === "true", conversationTitles: true, accountUsage: true, chatImageTurns: true, chatImageEdits,reviewEasy: reviewEasyEnabled(), maxModels: effectivePlanModelLimit(plan), assistants, workspace, plan: plan.tier, images }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiSecurityResponse(error) ?? Response.json({ code: "NATIVE_PARITY_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}

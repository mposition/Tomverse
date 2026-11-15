import { z } from "zod";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { getOperationalFeatureFlags } from "@/lib/appSettings";
import { resolveModelPricing } from "@/lib/modelPricing";
import { getWebSearchCapability } from "@/lib/webSearchCapability";
import { resolveWebSearchBackendReadiness } from "@/lib/webSearchBackendRuntime";
import { refreshSearchQueryCeilingBreaches } from "@/lib/webSearchCeilingBreachStore";
import { reserveTurnSearchCost } from "@/lib/webSearchNativeCostReservation";
import { getWebSearchSurchargeCredits } from "@/lib/webSearchCredits";
import { decideResearchPreviewAdmission, researchPreviewGate } from "@/lib/researchPreviewAdmission";
import { createResearchPreviewBudget } from "@/lib/researchPreviewBudget";
import { researchPreviewInputEstimate, researchPreviewLocale } from "@/lib/researchPreviewPrompt";
import { researchPreviewFeatures } from "@/lib/researchPreviewFeatures";

const schema = z.object({
  conversationId: z.string().min(1).max(64).optional(),
  selectionMode: z.enum(["manual", "auto"]).optional(),
  assistantProfileId: z.string().min(1).max(64).nullable().optional(),
  modelId: z.string().min(1).max(100),
  question: z.string().trim().min(1).max(4000),
}).strict();

const reply = (value: unknown) => Response.json(value, { headers: { "Cache-Control": "no-store" } });
const storedModelIds = (value: unknown): string[] => {
  let parsed = value;
  for (let i = 0; i < 2 && typeof parsed === "string"; i++) {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
};

/** Read-only offer; no provider request, context retrieval or financial hold. */
export async function POST(request: Request) {
  try {
    if (process.env.RESEARCH_PREVIEW_ENABLED !== "true") return reply({ offered: false, reason: "disabled" });
    if (request.headers.has("authorization") && !researchPreviewFeatures().nativeStart) return reply({ offered: false, reason: "disabled" });
    const authentication = await resolveChatRouteSession(request);
    if (authentication.response) return authentication.response;
    const userId = authentication.session?.user?.id;
    if (!userId) return reply({ offered: false, reason: "authentication_required" });
    const account = await prisma.user.findUnique({ where: { id: userId }, select: { accountStatus: true } });
    if (!account || account.accountStatus !== "active") return reply({ offered: false, reason: "authentication_required" });
    await consumeApiRateLimit(request, userId, "research-preview-offer", { minute: 120, day: 5000 });
    const payload = await readLimitedJson(request, 20 * 1024, schema);
    const [conversation, models, plan, flags] = await Promise.all([
      payload.conversationId ? prisma.conversation.findFirst({
        where: { id: payload.conversationId, userId },
        select: {
          id: true, password: true, kind: true, productKey: true, selectionMode: true,
          selectedModels: true, assistantProfileVersionId: true,
        },
      }) : Promise.resolve(null),
      getRuntimeModels(), getUserBillingPlan(userId), getOperationalFeatureFlags(),
    ]);
    const model = models.find((candidate) => candidate.id === payload.modelId) ?? null;
    let profileTools: { webSearch: boolean; deepResearch: boolean } | null = null;
    if (!payload.conversationId && payload.assistantProfileId) {
      const profile = await prisma.assistantProfile.findFirst({
        where: { id: payload.assistantProfileId, userId },
        select: { currentVersion: { select: { toolPolicy: true } } },
      });
      if (!profile?.currentVersion) return reply({ offered: false, reason: "profile_restricted" });
      const policy = profile.currentVersion.toolPolicy as Record<string, unknown> | undefined;
      profileTools = { webSearch: policy?.webSearch === true, deepResearch: policy?.deepResearch === true };
    }
    if (conversation?.assistantProfileVersionId) {
      // Read the restriction only; profile instructions/knowledge are never retrieved.
      const version = await prisma.assistantProfileVersion.findFirst({
        where: { id: conversation.assistantProfileVersionId, userId }, select: { toolPolicy: true },
      });
      const policy = version?.toolPolicy as Record<string, unknown> | undefined;
      profileTools = { webSearch: policy?.webSearch === true, deepResearch: policy?.deepResearch === true };
    }
    await refreshSearchQueryCeilingBreaches();
    const backendReadiness = resolveWebSearchBackendReadiness();
    const decision = decideResearchPreviewAdmission({
      signedIn: true, plan: plan.tier,
      conversationAvailable: payload.conversationId ? Boolean(conversation) : true,
      conversationLocked: Boolean(conversation && !hasConversationUnlockGrant(request, userId, conversation.id, conversation.password)),
      productKey: payload.conversationId ? conversation?.productKey ?? null : "chat", kind: payload.conversationId ? conversation?.kind ?? null : "chat",
      selectionMode: payload.conversationId ? conversation?.selectionMode ?? null : payload.selectionMode ?? null,
      selectedModelIds: payload.conversationId ? storedModelIds(conversation?.selectedModels) : [payload.modelId], model, backendReadiness, profileTools,
      gateEnabled: flags.aiChatEnabled && Boolean(model && researchPreviewGate(model)),
      modelOutputTokenCap: model ? resolveModelPricing(model).maxOutputTokens : 0,
    });
    if (!decision.offered || !model) return reply(decision);
    const capability = getWebSearchCapability(model);
    const searchReservation = reserveTurnSearchCost({ model, capability, appManagedSearchEnabled: true, nativeSearchEnabled: false });
    if (!searchReservation.ok) return reply({ offered: false, reason: "search_unavailable" });
    const features = researchPreviewFeatures();
    const budget = createResearchPreviewBudget({
      pageReadingEnabled: features.pageReading,
      accessKind: "user", model,
      input: researchPreviewInputEstimate({ question: payload.question, locale: researchPreviewLocale(request.headers.get("accept-language")), currentDate: new Date().toISOString().slice(0, 10) }),
      webSearchSurchargeCredits: getWebSearchSurchargeCredits("always", capability, backendReadiness), searchReservation,
    });
    return reply({ ...decision, estimatedCredits: budget.usageCredits, features: { pageReading: features.pageReading, durableRuns: features.durableRuns } });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return security;
    return reply({ offered: false, reason: "conversation_unavailable" });
  }
}

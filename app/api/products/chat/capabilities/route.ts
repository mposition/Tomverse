export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { voiceConversationConfig } from "@tomverse/chat-core";
import { randomUUID } from "node:crypto";
import { desktopBillingEnabled, desktopDeepResearchEnabled, desktopDriveEnabled, desktopPluginsEnabled, desktopVoiceEnabled } from "@/lib/nativeBearerGate";
import { desktopManagedCodeEnabled } from "@/lib/desktopManagedCodeSwitch";
import { mcpPreviewEnabled } from "@/lib/mcpConnectorPolicy";
import { readGooglePickerConfig } from "@/lib/googleDrivePickerConfig";
import { resolveProviderApiKey } from "@/lib/modelRegistryShared";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { DESKTOP_APP_ORIGIN, desktopAttachmentEnabled, desktopChatWriteEnabled, desktopReviewWriteEnabled, desktopReviewAnalysisEnabled, desktopComposerToolsEnabled } from "@/lib/desktopReadApiContract";
import {
  getOperationalFeatureFlags, isChatStarterEnabled, isExternalContinuationEnabledCached, isExternalImportEnabled, isImageGenerationEnabledCached, isVoiceInputEnabled,
} from "@/lib/appSettings";
import { CHAT_STARTER_MAX_VISIBLE, parseStarterOrderSeed, selectVisibleStarterCards } from "@/lib/chatStarterAvailability";
import { chatStarterCatalogFor } from "@/lib/chatStarterCatalog";
import { resolveChatStarterCapabilities } from "@/lib/chatStarterCapabilityResolution";
import { resolveWebSearchBackendReadiness } from "@/lib/webSearchBackendRuntime";
import { workspaceWelcomeCopy } from "@/locales/workspaceWelcome";
import { effectivePlanModelLimit, getUserBillingPlan, planAllowsFeature } from "@/lib/billingEntitlements";
import { reviewEasyEnabled } from "@/lib/reviewRouting";
import { refreshImageModelCatalog } from "@/lib/modelCatalog";
import { imageModelOwner } from "@/lib/imageModelRegistry";
import { imageGroupMaxModels } from "@/lib/imageGroupLimits";

import { autoAvailabilityFor } from "@/lib/autoAvailability";
import { autoSelectionCapability } from "@/lib/autoRoutingUi";
import { identifyChatCaller } from "@/lib/chatSecurity";
import {
  mintGuestChatAutoCapability,
} from "@/lib/guestChatAutoAuthority";
import {
  GUEST_CHAT_SMART_ADAPTIVE_AUTHORITY_SECRET_ENV,
  guestChatSmartAdaptiveAuthorityTtlSeconds,
} from "@/lib/guestChatSmartAdaptiveRelease";
import { readGuestChatSmartAdaptiveRelease } from
  "@/lib/guestChatSmartAdaptiveReleaseStore";
import { promptRefinerChatExecutionRelease } from
  "@/lib/promptRefinerChatExecutionRelease";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

async function desktopChatCapabilities(userId: string, orderSeed: number | null) {
  const desktopWrite = desktopChatWriteEnabled();
  const desktopReview = desktopReviewWriteEnabled();
  const attachmentAccess = desktopAttachmentEnabled();
  const [startersEnabled, importEnabled, continuationEnabled, plan, attachments] = await Promise.all([
    isChatStarterEnabled().catch(() => false),
    isExternalImportEnabled().catch(() => false),
    isExternalContinuationEnabledCached().catch(() => false),
    desktopWrite || desktopReview || attachmentAccess ? getUserBillingPlan(userId).catch(() => null) : null,
    attachmentAccess ? getOperationalFeatureFlags().then((flags) => flags.attachmentsEnabled).catch(() => false) : false,
  ]);
  const reviewPlan = desktopReview ? plan : null;
  const desktopAttachments = attachments && plan?.allowAttachments === true;
  const imageEnabled = reviewPlan && planAllowsFeature(reviewPlan, "imageGeneration") &&
    await isImageGenerationEnabledCached().catch(() => false);
  const catalog = imageEnabled ? await refreshImageModelCatalog().catch(() => []) : [];
  const images = catalog.filter((model) => !model.disabledReason).map((model) => ({
    id: model.id, name: model.name, provider: imageModelOwner(model), pricingVersion: model.pricingVersion,
    prices: model.prices.map(({ quality, size, credits }) => ({ quality, size, credits })),
  }));
  const modelCapabilities = new Set(resolveChatStarterCapabilities({
    webSearchBackendReadiness: resolveWebSearchBackendReadiness(),
  }).filter((capability) => (desktopWrite && capability === "generated-artifact") ||
    (desktopAttachments && (capability === "document-attachment" || capability === "image-input"))));
  const starters = startersEnabled && (desktopWrite || orderSeed !== null) ? selectVisibleStarterCards({
    signedIn: true, plan: plan?.tier ?? null, enabledFlags: new Set(),
    knownFlags: new Set(), modelCapabilities,
  }, chatStarterCatalogFor("chat"), CHAT_STARTER_MAX_VISIBLE, orderSeed).flatMap(({ entry, availability }) => {
    const cards = workspaceWelcomeCopy.en.starter.cards;
    const copy = cards[entry.labelKey.split(".")[2] as keyof typeof cards];
    return copy && availability.state === "available" ? [{ id: entry.id, ...copy }] : [];
  }) : [];
  return { desktopWrite, desktopImport: importEnabled && continuationEnabled, desktopStarters: starters,
    desktopReviewAnalysis: desktopReviewAnalysisEnabled(), desktopComposerTools: desktopComposerToolsEnabled(),
    desktopSearchReadiness: resolveWebSearchBackendReadiness(),
    desktopAttachments,
    desktopGoogleDrive: desktopAttachments && desktopDriveEnabled() && Boolean(readGooglePickerConfig()),
    desktopDeepResearch: desktopDeepResearchEnabled() && Boolean(resolveProviderApiKey("perplexity")),
    desktopBilling: desktopBillingEnabled(),
    desktopManagedCode: desktopManagedCodeEnabled(),
    desktopPlugins: desktopPluginsEnabled() && mcpPreviewEnabled(),
    // What this server accepts in a Desktop turn. A Desktop build offers the device position, a chosen plugin in Chat
    // and the "+" menu's choices for a Review only where the server it reached says so, whatever its own version.
    desktopTurnLocation: desktopWrite || desktopReview,
    desktopChatPlugin: desktopWrite && desktopPluginsEnabled() && mcpPreviewEnabled(),
    desktopReviewContext: desktopReview,
    desktopReviewTools: desktopReview && desktopComposerToolsEnabled(),
    // Dictation and the Chat voice conversation, each only where its own switch is on as well as Desktop's.
    desktopVoiceInput: desktopVoiceEnabled() && await isVoiceInputEnabled().catch(() => false),
    desktopVoiceConversation: desktopVoiceEnabled() && voiceConversationConfig(process.env) !== null,
    ...(reviewPlan ? { desktopReview: { easy: reviewEasyEnabled(), modelLimit: effectivePlanModelLimit(reviewPlan), plan: reviewPlan.tier } } : {}),
    ...(images.length ? { desktopImages: { maxModels: imageGroupMaxModels(), models: images } } : {}),
  };
}

/**
 * Read the server-owned Auto capability for a not-yet-created Tomverse Chat.
 *
 * This is deliberately read-only. Merely opening the workspace must not
 * consume conversation capacity or leave an empty row behind. The product is
 * this route's constant and the response exposes only the same boolean that a
 * confirmed Chat conversation detail exposes; rollout reasons stay server
 * side.
 */
export async function GET(request: Request) {
  const routeAuth = await resolveChatRouteSession(request);
  if (routeAuth.response) return routeAuth.response;
  const session = routeAuth.session;
  if (!session?.user?.id) {
    const access = identifyChatCaller(request, null);
    try {
      const [guestRelease, refinerRelease] = await Promise.all([
        readGuestChatSmartAdaptiveRelease(),
        promptRefinerChatExecutionRelease(),
      ]);
      if (!guestRelease || !refinerRelease.autoEnabled ||
          refinerRelease.runtimeCommitSha !==
            guestRelease.binding.runtimeCommitSha ||
          refinerRelease.runtimeDeploymentId !==
            guestRelease.binding.runtimeDeploymentId) {
        const response = NextResponse.json(
          {
            autoSelection: { offered: false },
            guestAuto: { attachmentSupport: "manual_only" },
          },
          { headers: NO_STORE_HEADERS });
        if (access.setCookie) response.headers.append("Set-Cookie", access.setCookie);
        return response;
      }
      const capability = mintGuestChatAutoCapability({
        secret: process.env[GUEST_CHAT_SMART_ADAPTIVE_AUTHORITY_SECRET_ENV] ?? "",
        binding: {
          subjectKey: access.subjectKey as `guest:${string}`,
          sourceCommitSha: guestRelease.binding.runtimeCommitSha,
          runtimeDeploymentId: guestRelease.binding.runtimeDeploymentId,
          activationPairDigest: guestRelease.activationPairDigest,
          configDigest: guestRelease.binding.configDigest,
        },
        authorityId: randomUUID(),
        nonce: randomUUID(),
        nowMs: Date.now(),
        ttlSeconds: guestChatSmartAdaptiveAuthorityTtlSeconds(),
      });
      const response = NextResponse.json({
        autoSelection: { offered: true },
        guestAutoCapability: capability,
        guestAuto: { attachmentSupport: "manual_only" },
      }, { headers: NO_STORE_HEADERS });
      if (access.setCookie) response.headers.append("Set-Cookie", access.setCookie);
      return response;
    } catch (error) {
      console.error(JSON.stringify({
        event: "guest_chat_auto_capability_unavailable",
        errorName: error instanceof Error ? error.name : "UnknownError",
        timestamp: new Date().toISOString(),
      }));
      const response = NextResponse.json(
        {
          autoSelection: { offered: false },
          guestAuto: { attachmentSupport: "manual_only" },
        },
        { headers: NO_STORE_HEADERS });
      if (access.setCookie) response.headers.append("Set-Cookie", access.setCookie);
      return response;
    }
  }

  try {
    const [availability, desktop] = await Promise.all([
      autoAvailabilityFor(session.user.id),
      request.headers.get("origin") === DESKTOP_APP_ORIGIN
        ? desktopChatCapabilities(session.user.id, parseStarterOrderSeed(new URL(request.url).searchParams.get("starterOrder")))
        : null,
    ]);
    const voice = voiceConversationConfig(process.env);
    return NextResponse.json(
      // Older APKs use this field for their 300-second client timer and reserve
      // estimate. Updated clients opt into continuous funding explicitly.
      { autoSelection: autoSelectionCapability(availability), voiceConversation: { enabled: Boolean(voice), maxSeconds: 300, continuous: Boolean(voice), reservationSeconds: voice?.reservationSeconds ?? 60 },
        ...desktop },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error(JSON.stringify({
      event: "chat_draft_auto_capability_unavailable",
      errorName: error instanceof Error ? error.name : "UnknownError",
      timestamp: new Date().toISOString(),
    }));
    return NextResponse.json(
      { autoSelection: { offered: false } },
      { headers: NO_STORE_HEADERS }
    );
  }
}

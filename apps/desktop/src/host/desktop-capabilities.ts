import { z } from "zod";
import { randomInt } from "node:crypto";
import { CHAT_STARTER_MAX_VISIBLE, STARTER_ORDER_SEED_LIMIT } from "../../../../lib/chatStarterAvailability";
import { DESKTOP_LIVE_ORIGIN } from "../../../../lib/desktopAuthContract";
import { DESKTOP_APP_ORIGIN, DESKTOP_CHAT_CAPABILITIES } from "../../../../lib/desktopReadApiContract";
import { reviewCapability } from "../chat-contract";
import { imageCapability } from "../images-contract";

const capabilities = z.object({
  autoSelection: z.object({ offered: z.boolean() }),
  desktopWrite: z.boolean().optional(),
  desktopReviewAnalysis: z.boolean().optional(),
  desktopComposerTools: z.boolean().optional(),
  desktopSearchReadiness: z.object({ brave: z.boolean() }).optional(),
  desktopImport: z.boolean().optional(),
  desktopStarters: z.array(z.object({ id: z.string(), label: z.string(), outcome: z.string(), seed: z.string() })).max(CHAT_STARTER_MAX_VISIBLE).optional(),
  desktopReview: reviewCapability.optional(),
  desktopImages: imageCapability.optional().catch(undefined),
  desktopAttachments: z.boolean().optional(),
  desktopGoogleDrive: z.boolean().optional(),
  desktopDeepResearch: z.boolean().optional(),
  desktopPlugins: z.boolean().optional(),
  // Plugins from a zip file, an npm package or a private repository, and the marketplace Desktop carries. An older server names none of it.
  desktopPluginSources: z.boolean().optional(),
  desktopCodeMcp: z.boolean().optional(),
  desktopBilling: z.boolean().optional(),
  desktopManagedCode: z.boolean().optional(),
  // The Code agent's web_search (the coding API's paid search). An older server does not name it, and runs then have no such tool.
  desktopCodeWebSearch: z.boolean().optional(),
  // What this server accepts in a Desktop turn. An older server names none of them, and the app then offers none.
  desktopTurnLocation: z.boolean().optional(),
  desktopChatPlugin: z.boolean().optional(),
  desktopReviewContext: z.boolean().optional(),
  desktopReviewTools: z.boolean().optional(),
  desktopReviewDeepResearch: z.boolean().optional(),
  desktopVoiceInput: z.boolean().optional(),
  desktopVoiceConversation: z.boolean().optional(),
  desktopReasoningSteps: z.boolean().optional(),
  desktopPromptRefiner: z.boolean().optional(),
  // An older server names none, and Settings then offers no Google or Microsoft connection.
  desktopSocialLink: z.array(z.enum(["google", "azure-ad"])).max(2).optional().catch(undefined),
  voiceConversation: z.object({ enabled: z.boolean(), maxSeconds: z.number().int().positive(), continuous: z.boolean().optional() }).optional().catch(undefined),
});

const starterOrder = randomInt(STARTER_ORDER_SEED_LIMIT);

export async function readDesktopCapabilities(accessToken: string, signal: AbortSignal, origin = DESKTOP_LIVE_ORIGIN) {
  const url = new URL(DESKTOP_CHAT_CAPABILITIES, origin);
  url.searchParams.set("starterOrder", String(starterOrder));
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + accessToken, Origin: DESKTOP_APP_ORIGIN, Accept: "application/json" },
    credentials: "omit", redirect: "error", cache: "no-store", signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const data = capabilities.parse(await response.json());
  return { autoSelection: data.autoSelection.offered, chatWrite: data.desktopWrite === true,
    reviewAnalysis: data.desktopReviewAnalysis === true, composerTools: data.desktopComposerTools === true,
    searchReadiness: data.desktopSearchReadiness,
    chatImport: data.desktopImport === true, chatStarters: data.desktopStarters ?? [],
    review: data.desktopReview ?? null, images: data.desktopImages ?? null, attachments: data.desktopAttachments === true,
    googleDrive: data.desktopGoogleDrive === true, deepResearch: data.desktopDeepResearch === true,
    plugins: data.desktopPlugins === true, pluginSources: data.desktopPluginSources === true, codeMcp: data.desktopCodeMcp === true, billing: data.desktopBilling === true,
    managedCode: data.desktopManagedCode === true,
    codeWebSearch: data.desktopCodeWebSearch === true,
    turnLocation: data.desktopTurnLocation === true, chatPlugin: data.desktopChatPlugin === true,
    reviewContext: data.desktopReviewContext === true,
    reviewTools: data.desktopReviewTools === true && data.desktopReviewContext === true,
    // A Deep Research column of a Review prepares its own context, as a one-model Review turn does.
    reviewDeepResearch: data.desktopReviewDeepResearch === true && data.desktopReviewContext === true && data.desktopReview !== undefined,
    voiceInput: data.desktopVoiceInput === true,
    reasoningSteps: data.desktopReasoningSteps === true,
    promptRefiner: data.desktopPromptRefiner === true && data.desktopWrite === true,
    socialLink: data.desktopSocialLink ?? [],
    // The conversation is offered only where Desktop's own switch and the server's voice switch are both on.
    voiceConversation: data.desktopVoiceConversation === true && data.voiceConversation?.enabled
      ? { continuous: data.voiceConversation.continuous === true, maxSeconds: data.voiceConversation.maxSeconds } : null };
}

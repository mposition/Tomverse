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
  desktopPlugins: z.boolean().optional(),
  desktopCodeMcp: z.boolean().optional(),
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
    plugins: data.desktopPlugins === true, codeMcp: data.desktopCodeMcp === true };
}

import { z } from "zod";
import { DESKTOP_LIVE_ORIGIN } from "../../../../lib/desktopAuthContract";
import { DESKTOP_APP_ORIGIN, DESKTOP_CHAT_CAPABILITIES } from "../../../../lib/desktopReadApiContract";
import { reviewCapability } from "../chat-contract";
import { imageCapability } from "../images-contract";

const capabilities = z.object({
  autoSelection: z.object({ offered: z.boolean() }),
  desktopWrite: z.boolean().optional(),
  desktopImport: z.boolean().optional(),
  desktopStarters: z.array(z.object({ id: z.string(), label: z.string(), outcome: z.string(), seed: z.string() })).max(6).optional(),
  desktopReview: reviewCapability.optional(),
  desktopImages: imageCapability.optional(),
  desktopAttachments: z.boolean().optional(),
  desktopPlugins: z.boolean().optional(),
  desktopCodeMcp: z.boolean().optional(),
});

export async function readDesktopCapabilities(accessToken: string, signal: AbortSignal, origin = DESKTOP_LIVE_ORIGIN) {
  const response = await fetch(new URL(DESKTOP_CHAT_CAPABILITIES, origin), {
    headers: { Authorization: "Bearer " + accessToken, Origin: DESKTOP_APP_ORIGIN, Accept: "application/json" },
    credentials: "omit", redirect: "error", cache: "no-store", signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const data = capabilities.parse(await response.json());
  return { autoSelection: data.autoSelection.offered, chatWrite: data.desktopWrite === true,
    chatImport: data.desktopImport === true, chatStarters: data.desktopStarters ?? [],
    review: data.desktopReview ?? null, images: data.desktopImages ?? null, attachments: data.desktopAttachments === true,
    plugins: data.desktopPlugins === true, codeMcp: data.desktopCodeMcp === true };
}

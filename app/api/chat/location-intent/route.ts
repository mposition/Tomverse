import { z } from "zod";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { assertUserOperationalAccess, ChatAccessError, identifyChatCaller } from "@/lib/chatSecurity";
import { detectChatLocationIntent } from "@/lib/chatLocationIntent";
import { ensureGuestVerified } from "@/lib/turnstile";

export const dynamic = "force-dynamic";
const schema = z.object({ text: z.string().trim().min(1).max(8_000), turnstileToken: z.string().max(8_000).optional() }).strict();
const reply = (requiresLocation: boolean, cookie?: string) => Response.json({ requiresLocation }, {
  headers: { "Cache-Control": "private, no-store", ...(cookie ? { "Set-Cookie": cookie } : {}) },
});

/** Only a semantic signal is returned; the server never reads device coordinates here. */
export async function POST(request: Request) {
  try {
    const authentication = await resolveChatRouteSession(request);
    if (authentication.response) return authentication.response;
    const userId = authentication.session?.user?.id;
    const input = await readLimitedJson(request, 32 * 1024, schema);
    const caller = identifyChatCaller(request, userId ?? null);
    await consumeApiRateLimit(request, caller.subjectKey, "chat-location-intent", { minute: 30, day: 2_000 });
    if (userId) await assertUserOperationalAccess(userId);
    const cookie = userId ? undefined : await ensureGuestVerified(request, input.turnstileToken, "guest_chat");
    return reply(await detectChatLocationIntent(input.text), cookie);
  } catch (error) {
    if (error instanceof ChatAccessError) return Response.json({ code: error.code, error: error.message }, {
      status: error.status, headers: { "Cache-Control": "private, no-store" },
    });
    return apiSecurityResponse(error) ?? reply(false);
  }
}

import { z } from "zod";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { assertUserOperationalAccess, ChatAccessError, identifyChatCaller } from "@/lib/chatSecurity";
import { detectChatLocationIntent } from "@/lib/chatLocationIntent";
import { ensureGuestVerified } from "@/lib/turnstile";

export const dynamic = "force-dynamic";
const schema = z.object({ text: z.string().trim().min(1).max(8_000), turnstileToken: z.string().max(8_000).optional() }).strict();
const reply = (requiresLocation: boolean) => Response.json({ requiresLocation }, {
  headers: { "Cache-Control": "private, no-store" },
});

/** Only a semantic signal is returned; the server never reads device coordinates here. */
export async function POST(request: Request) {
  const cookies: string[] = [];
  const finish = (response: Response) => {
    for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
    return response;
  };
  try {
    const authentication = await resolveChatRouteSession(request);
    if (authentication.response) return authentication.response;
    const userId = authentication.session?.user?.id;
    const input = await readLimitedJson(request, 32 * 1024, schema);
    const caller = identifyChatCaller(request, userId ?? null);
    if (caller.setCookie) cookies.push(caller.setCookie);
    await consumeApiRateLimit(request, caller.subjectKey, "chat-location-intent", { minute: 30, day: 2_000 });
    if (userId) await assertUserOperationalAccess(userId);
    const grant = userId ? undefined : await ensureGuestVerified(request, input.turnstileToken, "guest_chat");
    if (grant) cookies.push(grant);
    // A token-bearing request only redeems verification. Its cookie reaches the
    // client before the separate, tokenless analysis request can time out.
    if (input.turnstileToken) return finish(reply(false));
    return finish(reply(await detectChatLocationIntent(input.text)));
  } catch (error) {
    if (error instanceof ChatAccessError) return finish(Response.json({ code: error.code, error: error.message }, {
      status: error.status, headers: { "Cache-Control": "private, no-store" },
    }));
    return finish(apiSecurityResponse(error) ?? reply(false));
  }
}

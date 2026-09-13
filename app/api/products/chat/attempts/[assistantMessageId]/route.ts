export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";

import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { authorizeChatRecoveryScope } from "@/lib/chatDurableRecoveryAccess";
import {
  chatResponseAttemptIdSchema,
  publicChatResponseAttempt,
} from "@/lib/chatResponseAttemptCore";
import { readChatResponseAttempt } from "@/lib/chatResponseAttemptPersistence";

type Params = { params: Promise<{ assistantMessageId: string }> };

const jsonError = (error: string, code: string, status: number) =>
  Response.json(
    { error, code },
    { status, headers: { "Cache-Control": "no-store" } }
  );

const noStore = (response: Response) => {
  response.headers.set("Cache-Control", "no-store");
  return response;
};

export async function GET(request: Request, { params }: Params) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return jsonError("Authentication required.", "AUTH_REQUIRED", 401);
    }
    await consumeApiRateLimit(request, session.user.id, "chat-attempt-read", {
      minute: 120,
      day: 4_000,
    });
    const parsed = chatResponseAttemptIdSchema.safeParse((await params).assistantMessageId);
    if (!parsed.success) {
      return jsonError("Chat response attempt not found.", "CHAT_ATTEMPT_NOT_FOUND", 404);
    }

    // Ownership is inside this query. A foreign id and a missing id follow the
    // same branch and reveal nothing about another account.
    const attempt = await readChatResponseAttempt(session.user.id, parsed.data);
    if (!attempt) {
      return jsonError("Chat response attempt not found.", "CHAT_ATTEMPT_NOT_FOUND", 404);
    }
    const access = await authorizeChatRecoveryScope({
      request,
      userId: session.user.id,
      scopeKey: attempt.conversationId,
    });
    if (!access.ok) return noStore(access.response);

    return Response.json(
      { attempt: publicChatResponseAttempt(attempt) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return noStore(securityResponse);
    console.error("Chat response attempt read failed:", error);
    return jsonError(
      "Failed to read the Chat response attempt.",
      "CHAT_ATTEMPT_READ_FAILED",
      500
    );
  }
}

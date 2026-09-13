export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";

import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { authorizeChatRecoveryScope } from "@/lib/chatDurableRecoveryAccess";
import {
  chatResponseAttemptIdSchema,
  publicChatResponseAttempt,
} from "@/lib/chatResponseAttemptCore";
import {
  peekChatResponseAttempt,
  readChatResponseAttempt,
} from "@/lib/chatResponseAttemptPersistence";

type Params = { params: Promise<{ assistantMessageId: string }> };

const jsonError = (error: string, code: string, status: number) =>
  Response.json(
    { error, code },
    { status, headers: { "Cache-Control": "private, no-store" } }
  );

const noStore = (response: Response) => {
  response.headers.set("Cache-Control", "private, no-store");
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
    // same branch and reveal nothing about another account. This first lookup
    // is deliberately non-mutating: a locked conversation must pass its
    // unlock grant before lease reconciliation may UPDATE the attempt row.
    const attempt = await peekChatResponseAttempt(session.user.id, parsed.data);
    if (!attempt) {
      return jsonError("Chat response attempt not found.", "CHAT_ATTEMPT_NOT_FOUND", 404);
    }
    const access = await authorizeChatRecoveryScope({
      request,
      userId: session.user.id,
      scopeKey: attempt.conversationId,
    });
    if (!access.ok) return noStore(access.response);

    const reconciled = await readChatResponseAttempt(
      session.user.id,
      parsed.data,
      attempt.conversationId
    );
    if (!reconciled) {
      return jsonError("Chat response attempt not found.", "CHAT_ATTEMPT_NOT_FOUND", 404);
    }
    // Persistence scopes both its conditional reconciliation UPDATE and final
    // SELECT to the authorized conversation. Keep this independent assertion
    // fail-closed in case a future adapter violates that contract.
    if (reconciled.conversationId !== attempt.conversationId) {
      return jsonError("Chat response attempt not found.", "CHAT_ATTEMPT_NOT_FOUND", 404);
    }

    return Response.json(
      { attempt: publicChatResponseAttempt(reconciled) },
      { headers: { "Cache-Control": "private, no-store" } }
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

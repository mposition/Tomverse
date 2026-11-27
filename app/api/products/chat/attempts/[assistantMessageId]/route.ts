import { resolveChatRouteSession } from "@/lib/chatRouteSession";
export const dynamic = "force-dynamic";


import { z } from "zod";

import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { chatContinueAfterDisconnectEnabled } from "@/lib/chatContinueAfterDisconnect";
import { authorizeChatRecoveryScope } from "@/lib/chatDurableRecoveryAccess";
import {
  chatResponseAttemptIdSchema,
  publicChatResponseAttempt,
} from "@/lib/chatResponseAttemptCore";
import {
  peekChatResponseAttempt,
  readChatResponseAttempt,
  requestChatResponseAttemptStop,
} from "@/lib/chatResponseAttemptPersistence";
import { readPublicCompletedChatMessage } from "@/lib/publicChatMessage";

const stopRequestSchema = z.object({ action: z.literal("stop") }).strict();

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
    const routeAuth = await resolveChatRouteSession(request);
    if (routeAuth.response) return routeAuth.response;
    const session = routeAuth.session;
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

    const message = reconciled.status === "completed"
      ? await readPublicCompletedChatMessage(session.user.id, reconciled)
      : null;
    if (reconciled.status === "completed" && !message) {
      throw new Error("CHAT_COMPLETED_ATTEMPT_MESSAGE_MISSING");
    }

    return Response.json(
      {
        attempt: publicChatResponseAttempt(reconciled),
        ...(message ? { message } : {}),
      },
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

/**
 * The user's explicit stop (lib/chatContinueAfterDisconnect.ts).
 *
 * A stop and a dropped connection reach the streaming route as the same
 * request abort, so with CHAT_CONTINUE_AFTER_DISCONNECT on the browser says
 * which one it was here, as it aborts. This records the stop in the attempt
 * row; the streaming process -- whichever it is -- reads it and cancels. It
 * never touches a provider, credits or a Message.
 *
 * With the switch off a request abort already cancels the turn, and the row
 * is the stream's own to terminalize: this answers with the current state
 * and writes nothing, so switch-off behaviour is unchanged.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const routeAuth = await resolveChatRouteSession(request);
    if (routeAuth.response) return routeAuth.response;
    const session = routeAuth.session;
    if (!session?.user?.id) {
      return jsonError("Authentication required.", "AUTH_REQUIRED", 401);
    }
    await consumeApiRateLimit(request, session.user.id, "chat-attempt-stop", {
      minute: 60,
      day: 2_000,
    });
    const parsed = chatResponseAttemptIdSchema.safeParse((await params).assistantMessageId);
    if (!parsed.success) {
      return jsonError("Chat response attempt not found.", "CHAT_ATTEMPT_NOT_FOUND", 404);
    }
    await readLimitedJson(request, 256, stopRequestSchema);

    // Ownership is inside this query, as on GET: a foreign id and a missing
    // id are indistinguishable, and nothing is written before the unlock.
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

    if (!chatContinueAfterDisconnectEnabled()) {
      return Response.json(
        { stopped: false, attempt: publicChatResponseAttempt(attempt) },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }
    const result = await requestChatResponseAttemptStop(
      session.user.id,
      parsed.data,
      attempt.conversationId
    );
    if (!result.attempt || result.attempt.conversationId !== attempt.conversationId) {
      return jsonError("Chat response attempt not found.", "CHAT_ATTEMPT_NOT_FOUND", 404);
    }
    return Response.json(
      { stopped: result.stopped, attempt: publicChatResponseAttempt(result.attempt) },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return noStore(securityResponse);
    console.error("Chat response attempt stop failed:", error);
    return jsonError(
      "Failed to stop the Chat response attempt.",
      "CHAT_ATTEMPT_STOP_FAILED",
      500
    );
  }
}

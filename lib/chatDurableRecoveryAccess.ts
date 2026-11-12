import "server-only";

import { CHAT_DRAFT_NEW_SCOPE } from "@/lib/chatComposerDraftCore";
import {
  conversationKindNotSupportedResponse,
  isChatConversationKind,
} from "@/lib/conversationKindGuard";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import { CHAT_PRODUCT_KEY } from "@/lib/conversationProduct";
import { prisma } from "@/lib/prisma";

export type ChatRecoveryScopeAccess =
  | { ok: true; conversationId: string | null }
  | { ok: false; response: Response };

const jsonError = (error: string, code: string, status: number) =>
  Response.json(
    { error, code },
    { status, headers: { "Cache-Control": "no-store" } }
  );

/**
 * Authorizes only the durable Chat surface. Existing rows use their stored
 * product; the unbound `new` scope belongs to every signed-in account.
 */
export async function authorizeChatRecoveryScope(input: {
  request: Request;
  userId: string;
  scopeKey: string;
}): Promise<ChatRecoveryScopeAccess> {
  if (input.scopeKey === CHAT_DRAFT_NEW_SCOPE) return { ok: true, conversationId: null };

  const conversation = await prisma.conversation.findFirst({
    where: { id: input.scopeKey, userId: input.userId },
    select: { password: true, productKey: true, kind: true },
  });
  if (!conversation) {
    return {
      ok: false,
      response: jsonError("Conversation not found.", "CONVERSATION_NOT_FOUND", 404),
    };
  }
  if (!isChatConversationKind(conversation.kind)) {
    return { ok: false, response: conversationKindNotSupportedResponse() };
  }
  if (conversation.productKey !== CHAT_PRODUCT_KEY) {
    return {
      ok: false,
      response: jsonError(
        "This operation is available only for Tomverse Chat conversations.",
        "CHAT_RECOVERY_PRODUCT_NOT_SUPPORTED",
        409
      ),
    };
  }
  if (
    !hasConversationUnlockGrant(
      input.request,
      input.userId,
      input.scopeKey,
      conversation.password
    )
  ) {
    return { ok: false, response: conversationLockedResponse() };
  }
  return { ok: true, conversationId: input.scopeKey };
}

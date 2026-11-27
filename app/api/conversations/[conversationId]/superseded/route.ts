import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { isSupersededMessageIdList, markMessagesSuperseded } from "@/lib/chatSupersededMessages";
import { conversationLockedResponse, hasConversationUnlockGrant } from "@/lib/conversationLock";
import { prisma } from "@/lib/prisma";

/**
 * Records that "Regenerate" or "edit your last message" replaced a question
 * and its answer (lib/chatSupersededMessages.ts). The browser calls it once it
 * has seen the new answer finished; the chat route records the same fact in
 * the transaction that saves that answer, so a repeat changes nothing.
 *
 * Only the owner of an unlocked conversation may write, and only to that
 * conversation's own rows: an id that names another conversation's message, or
 * nothing at all, matches no row. Nothing is deleted.
 */
const bodySchema = z
  .object({ messageIds: z.custom<string[]>(isSupersededMessageIdList) })
  .strict();

export async function PUT(
  req: Request,
  context: RouteContext<"/api/conversations/[conversationId]/superseded">
) {
  try {
    const authentication = await resolveChatRouteSession(req);
    if (authentication.response) return authentication.response;
    const userId = authentication.session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    await consumeApiRateLimit(req, userId, "conversation-superseded", { minute: 60, day: 2_000 });

    const { conversationId } = await context.params;
    if (!conversationId) {
      return NextResponse.json({ error: "Conversation ID is required." }, { status: 400 });
    }
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { userId: true, password: true, passwordVersion: true },
    });
    if (!conversation || conversation.userId !== userId) {
      return NextResponse.json({ error: "You do not have access to this conversation." }, { status: 403 });
    }
    if (
      !hasConversationUnlockGrant(
        req,
        userId,
        conversationId,
        conversation.password == null ? null : conversation.passwordVersion
      )
    ) {
      return conversationLockedResponse();
    }

    const { messageIds } = await readLimitedJson(req, 2_048, bodySchema);
    const marked = await markMessagesSuperseded(prisma, conversationId, messageIds);
    return NextResponse.json({ marked });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;

    console.error("Failed to record replaced messages:", error);
    return NextResponse.json({ error: "Failed to record the replaced turn." }, { status: 500 });
  }
}

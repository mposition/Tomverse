import { NextResponse } from "next/server";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { reviewHandoffDescriptorSchema } from "@/lib/reviewContinuationHandoffCore";
import { prisma } from "@/lib/prisma";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  chatDraftMessageReceiptSchema,
  reconcileChatDraftMessageReceipt,
} from "@/lib/chatDraftMessageConsume";
import { scopedMessageId } from "@/lib/messageRequestIdentity";

const noStoreHeaders = { "Cache-Control": "private, no-store" } as const;

/**
 * Read-only receipt for a Message + draft-consume transaction whose HTTP
 * response was lost. It never repeats the transaction and never calls a
 * provider. The service performs every observation under the same advisory
 * lock used by the original consume.
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  try {
    const { conversationId } = await context.params;
    const authentication = await resolveChatRouteSession(req);
    if (authentication.response) return authentication.response;
    const session = authentication.session;
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401, headers: noStoreHeaders }
      );
    }
    await consumeApiRateLimit(req, session.user.id, "message-save", {
      minute: 30,
      day: 1_000,
    });
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { userId: true, password: true, passwordVersion: true, kind: true, productKey: true,
        continuationBridge: { select: { reviewHandoff: true } } },
    });
    // Missing and foreign ids deliberately share one response. The receipt is
    // a recovery read, not a conversation-existence oracle.
    if (!conversation || conversation.userId !== session.user.id) {
      return NextResponse.json(
        { error: "You do not have access to this conversation." },
        { status: 403, headers: noStoreHeaders }
      );
    }
    if (!hasConversationUnlockGrant(
      req,
      session.user.id,
      conversationId,
      conversation.password == null ? null : conversation.passwordVersion
    )) {
      const response = conversationLockedResponse();
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }
    const receiptRequest = await readLimitedJson(req, 64 * 1024, chatDraftMessageReceiptSchema);
    const handoffDraft = conversation.productKey === "review" &&
      reviewHandoffDescriptorSchema.safeParse(conversation.continuationBridge?.reviewHandoff).success &&
      receiptRequest.draftConsume.scopeKey === conversationId &&
      (receiptRequest.message.attachmentReferences?.length ?? 0) === 0 &&
      (receiptRequest.message.attachmentUploadIds?.length ?? 0) === 0;
    if (conversation.kind !== "chat" || (conversation.productKey !== "chat" && !handoffDraft)) {
      return NextResponse.json(
        {
          error: "This receipt is not available for this conversation.",
          code: "CHAT_DRAFT_CONSUME_NOT_SUPPORTED",
        },
        { status: 409, headers: noStoreHeaders }
      );
    }
    const messageId = scopedMessageId(
      conversationId,
      receiptRequest.message.clientRequestId
    );
    const result = await reconcileChatDraftMessageReceipt({
      userId: session.user.id,
      conversationId,
      receipt: {
        draftConsume: {
          scopeKey: receiptRequest.draftConsume.scopeKey,
          expectedRevision: receiptRequest.draftConsume.expectedRevision,
          messageId,
        },
        message: {
          id: messageId,
          content: receiptRequest.message.content,
          ...(receiptRequest.message.attachmentUploadIds
            ? { attachmentUploadIds: receiptRequest.message.attachmentUploadIds }
            : {}),
          ...(receiptRequest.message.attachmentReferences
            ? { attachmentReferences: receiptRequest.message.attachmentReferences }
            : {}),
        },
      },
    });
    return NextResponse.json(
      result.outcome === "committed"
        ? {
            ...result,
            requestId: receiptRequest.message.clientRequestId,
            messageId,
          }
        : result,
      { headers: noStoreHeaders }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) {
      securityResponse.headers.set("Cache-Control", "private, no-store");
      return securityResponse;
    }
    console.error("Failed to reconcile a Chat message receipt:", error);
    return NextResponse.json(
      { error: "The saved message state could not be verified." },
      { status: 500, headers: noStoreHeaders }
    );
  }
}

import "server-only";

import { prisma } from "@/lib/prisma";
import { scopedMessageId } from "@/lib/messageRequestIdentity";

type DurableRequestAttachment = {
  attachmentId?: unknown;
  uploadId?: unknown;
};

type DurableRequestMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  attachments?: unknown[];
};

export class ChatSourceMessageMismatchError extends Error {
  readonly code = "CHAT_SOURCE_MESSAGE_MISMATCH";
  readonly status = 409;

  constructor() {
    super("The persisted source message does not match this Chat request.");
    this.name = "ChatSourceMessageMismatchError";
  }
}

/**
 * Binds a paid durable execution to the exact user Message already committed
 * by the pre-save route. Text and ordered opaque attachment identities are
 * compared; browser-supplied names and media metadata are never evidence.
 */
export async function verifyDurableChatSourceMessage(input: {
  userId: string;
  conversationId: string;
  sourceUserMessageId: string;
  messages: DurableRequestMessage[];
}) {
  const latestUserMessage = [...input.messages]
    .reverse()
    .find((message) => message.role === "user");
  const requestMessageId = latestUserMessage?.id;
  const sourceMatchesCurrentOrLegacyRequest =
    typeof requestMessageId === "string" &&
    (requestMessageId === input.sourceUserMessageId ||
      scopedMessageId(input.conversationId, requestMessageId) ===
        input.sourceUserMessageId);
  if (!latestUserMessage || !sourceMatchesCurrentOrLegacyRequest) {
    throw new ChatSourceMessageMismatchError();
  }

  const persisted = await prisma.message.findFirst({
    where: {
      id: input.sourceUserMessageId,
      conversationId: input.conversationId,
      role: "user",
      conversation: { userId: input.userId },
    },
    select: {
      id: true,
      content: true,
      attachments: {
        orderBy: { ordinal: "asc" },
        select: {
          id: true,
          uploadId: true,
          userId: true,
          conversationId: true,
        },
      },
    },
  });
  if (!persisted || persisted.content !== latestUserMessage.content) {
    throw new ChatSourceMessageMismatchError();
  }

  const requested = Array.isArray(latestUserMessage.attachments)
    ? (latestUserMessage.attachments as DurableRequestAttachment[])
    : [];
  if (requested.length !== persisted.attachments.length) {
    throw new ChatSourceMessageMismatchError();
  }
  for (const [index, reference] of requested.entries()) {
    const attachment = persisted.attachments[index];
    if (
      !attachment ||
      attachment.userId !== input.userId ||
      attachment.conversationId !== input.conversationId
    ) {
      throw new ChatSourceMessageMismatchError();
    }
    if (
      typeof reference.attachmentId === "string" &&
      reference.attachmentId.length > 0 &&
      reference.uploadId === undefined
    ) {
      // The conversation/detail and message-save responses hand the browser
      // this newly bound row id. `sourceAttachmentId` remains provenance for
      // draft replay/copy validation; it is not the identity of the current
      // persisted turn the provider is about to receive.
      if (attachment.id !== reference.attachmentId) {
        throw new ChatSourceMessageMismatchError();
      }
      continue;
    }
    if (
      typeof reference.uploadId === "string" &&
      reference.uploadId.length > 0 &&
      reference.attachmentId === undefined &&
      attachment.uploadId === reference.uploadId
    ) {
      continue;
    }
    throw new ChatSourceMessageMismatchError();
  }
  return { id: persisted.id };
}

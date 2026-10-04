import "server-only";

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import {
  CHAT_DRAFT_NEW_SCOPE,
  chatDraftAttachmentReferencesSchema,
  parseStoredDraftReferences,
  type ChatDraftAttachmentReference,
} from "@/lib/chatComposerDraftCore";
import {
  PUBLIC_MESSAGE_ATTACHMENT_SELECT,
  toPublicMessageAttachment,
  type PublicMessageAttachment,
} from "@/lib/messageAttachmentCore";
import { prisma } from "@/lib/prisma";
import { lockChatRecoveryConversation } from "@/lib/chatResponseAttemptPersistence";

const opaqueId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const chatDraftConsumeRequestSchema = z
  .object({
    scopeKey: opaqueId,
    expectedRevision: z.number().int().min(1).max(2_147_483_647),
    requestId: z.string().uuid(),
  })
  .strict();

export type ChatDraftConsumeRequest = z.infer<
  typeof chatDraftConsumeRequestSchema
>;

export type ChatDraftConsume = Omit<ChatDraftConsumeRequest, "requestId"> & {
  messageId: string;
};

export class ChatDraftConsumeConflictError extends Error {
  readonly code = "MESSAGE_SAVE_CONFLICT";
  readonly status = 409;

  constructor() {
    super("The saved message does not match the draft being consumed.");
    this.name = "ChatDraftConsumeConflictError";
  }
}

const sameReferences = (
  left: readonly ChatDraftAttachmentReference[],
  right: readonly ChatDraftAttachmentReference[]
) => JSON.stringify(left) === JSON.stringify(right);

export type DraftMessage = {
  id: string;
  content: string;
  modelId?: string;
  attachmentUploadIds?: string[];
  attachmentReferences?: ChatDraftAttachmentReference[];
};

export const chatDraftMessageReceiptSchema = z
  .object({
    draftConsume: chatDraftConsumeRequestSchema,
    message: z
      .object({
        clientRequestId: z.string().uuid(),
        content: z.string().trim().max(50_000),
        attachmentUploadIds: z.array(opaqueId).max(5).optional(),
        attachmentReferences: chatDraftAttachmentReferencesSchema.optional(),
      })
      .strict()
      .refine(
        (message) =>
          !(message.attachmentUploadIds && message.attachmentReferences),
        { message: "Use one attachment reference format per message." }
      )
      .refine(
        (message) =>
          message.content.length > 0 ||
          (message.attachmentUploadIds?.length ?? 0) > 0 ||
          (message.attachmentReferences?.length ?? 0) > 0,
        { message: "A receipt message must have text or an attachment." }
      ),
  })
  .strict()
  .refine(
    (body) => body.draftConsume.requestId === body.message.clientRequestId,
    { message: "The receipt must name its one message." }
  );

export type ChatDraftMessageReceiptRequest = {
  draftConsume: ChatDraftConsume;
  message: DraftMessage;
};

export type ChatDraftMessageReceipt =
  | {
      outcome: "committed";
      messageId: string;
      attachments: PublicMessageAttachment[];
    }
  | { outcome: "unchanged"; attachments: [] }
  | { outcome: "ambiguous"; attachments: [] };

type DraftReadDb = Pick<Prisma.TransactionClient, "message" | "chatComposerDraft">;

async function exactExistingMessage(
  tx: DraftReadDb,
  input: {
    userId: string;
    conversationId: string;
    message: DraftMessage;
  }
) {
  const existing = await tx.message.findFirst({
    where: {
      id: input.message.id,
      conversationId: input.conversationId,
      conversation: { userId: input.userId },
    },
    select: {
      role: true,
      content: true,
      modelId: true,
      attachments: {
        orderBy: { ordinal: "asc" },
        select: {
          uploadId: true,
          sourceAttachmentId: true,
        },
      },
    },
  });
  if (!existing) return false;
  if (
    existing.role !== "user" ||
    existing.content !== input.message.content ||
    existing.modelId !== (input.message.modelId ?? null)
  ) {
    throw new ChatDraftConsumeConflictError();
  }

  const references =
    input.message.attachmentReferences ??
    (input.message.attachmentUploadIds ?? []).map((uploadId) => ({ uploadId }));
  if (existing.attachments.length !== references.length) {
    throw new ChatDraftConsumeConflictError();
  }
  for (const [index, reference] of references.entries()) {
    const bound = existing.attachments[index];
    if (!bound) throw new ChatDraftConsumeConflictError();
    if ("uploadId" in reference) {
      if (bound.uploadId !== reference.uploadId) throw new ChatDraftConsumeConflictError();
      continue;
    }
    if (bound.sourceAttachmentId !== reference.attachmentId) {
      throw new ChatDraftConsumeConflictError();
    }
  }
  return true;
}

async function inspectChatDraftForMessage(
  db: DraftReadDb,
  input: {
    userId: string;
    conversationId: string;
    draftConsume: ChatDraftConsume;
    message: DraftMessage;
  }
): Promise<{ replay: boolean }> {
  if (
    input.draftConsume.messageId !== input.message.id ||
    (input.draftConsume.scopeKey !== CHAT_DRAFT_NEW_SCOPE &&
      input.draftConsume.scopeKey !== input.conversationId)
  ) {
    throw new ChatDraftConsumeConflictError();
  }
  const replay = await exactExistingMessage(db, input);
  if (replay) return { replay: true };
  const draft = await db.chatComposerDraft.findUnique({
    where: {
      userId_scopeKey: {
        userId: input.userId,
        scopeKey: input.draftConsume.scopeKey,
      },
    },
    select: { text: true, attachmentReferences: true, revision: true },
  });
  if (!draft) throw new ChatDraftConsumeConflictError();
  const messageReferences = chatDraftAttachmentReferencesSchema.parse(
    input.message.attachmentReferences ??
      (input.message.attachmentUploadIds ?? []).map((uploadId) => ({ uploadId }))
  );
  if (
    draft.revision !== input.draftConsume.expectedRevision ||
    draft.text !== input.message.content ||
    !sameReferences(parseStoredDraftReferences(draft.attachmentReferences), messageReferences)
  ) {
    throw new ChatDraftConsumeConflictError();
  }
  return { replay: false };
}

/**
 * Read-only fail-fast gate used before attachment bytes are read or copied.
 * The transaction gate below repeats the comparison under the conversation
 * lock, so passing this check grants no write authority.
 */
export async function preflightChatDraftForMessage(input: {
  userId: string;
  conversationId: string;
  draftConsume: ChatDraftConsume;
  message: DraftMessage;
}): Promise<{ replay: boolean }> {
  return inspectChatDraftForMessage(prisma, input);
}

/**
 * Verifies and consumes one durable composer draft in the same transaction as
 * the user Message. The shared advisory lock also serialises a model-history
 * clear and the following response-attempt claim for this conversation.
 */
export async function consumeChatDraftForMessage(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    conversationId: string;
    draftConsume: ChatDraftConsume;
    message: DraftMessage;
  }
): Promise<{ replay: boolean }> {
  await lockChatRecoveryConversation(tx, input.userId, input.conversationId);
  const inspection = await inspectChatDraftForMessage(tx, input);
  // The exact Message is the durable receipt for the original consume. A
  // later draft may already occupy the same composer scope; a retry of the
  // old request must neither reject because of it nor delete it.
  if (inspection.replay) return inspection;
  const removed = await tx.chatComposerDraft.deleteMany({
    where: {
      userId: input.userId,
      scopeKey: input.draftConsume.scopeKey,
      revision: input.draftConsume.expectedRevision,
    },
  });
  if (removed.count !== 1) throw new ChatDraftConsumeConflictError();
  return { replay: false };
}

/**
 * Resolves an indeterminate Message POST without repeating a write.
 *
 * The browser calls this only after a timeout, network failure, or 5xx made
 * the transaction's result unknowable. The same conversation advisory lock
 * used by draft consumption makes the observations one serial point:
 *
 * - the exact Message is the durable receipt (`committed`);
 * - no Message plus the exact original draft is a proven rollback
 *   (`unchanged`);
 * - every other state is deliberately `ambiguous`.
 *
 * No result authorises a write. In particular, `ambiguous` never guesses
 * whether a missing draft was consumed or independently changed.
 */
export async function reconcileChatDraftMessageReceipt(input: {
  userId: string;
  conversationId: string;
  receipt: ChatDraftMessageReceiptRequest;
}): Promise<ChatDraftMessageReceipt> {
  return prisma.$transaction(async (tx) => {
    await lockChatRecoveryConversation(tx, input.userId, input.conversationId);
    const conversation = await tx.conversation.findFirst({
      where: { id: input.conversationId, userId: input.userId },
      select: { kind: true, productKey: true },
    });
    if (!conversation || conversation.kind !== "chat" ||
        conversation.productKey !== "chat") {
      return { outcome: "ambiguous", attachments: [] };
    }
    if (
      input.receipt.draftConsume.scopeKey !== CHAT_DRAFT_NEW_SCOPE &&
      input.receipt.draftConsume.scopeKey !== input.conversationId
    ) {
      return { outcome: "ambiguous", attachments: [] };
    }

    try {
      const committed = await exactExistingMessage(tx, {
        userId: input.userId,
        conversationId: input.conversationId,
        message: input.receipt.message,
      });
      if (committed) {
        const attachments = await tx.messageAttachment.findMany({
          where: {
            messageId: input.receipt.message.id,
            userId: input.userId,
            conversationId: input.conversationId,
          },
          orderBy: { ordinal: "asc" },
          select: PUBLIC_MESSAGE_ATTACHMENT_SELECT,
        });
        return {
          outcome: "committed",
          messageId: input.receipt.message.id,
          attachments: attachments.map(toPublicMessageAttachment),
        };
      }
    } catch (error) {
      if (error instanceof ChatDraftConsumeConflictError) {
        return { outcome: "ambiguous", attachments: [] };
      }
      throw error;
    }

    const draft = await tx.chatComposerDraft.findUnique({
      where: {
        userId_scopeKey: {
          userId: input.userId,
          scopeKey: input.receipt.draftConsume.scopeKey,
        },
      },
      select: { text: true, attachmentReferences: true, revision: true },
    });
    const messageReferences = chatDraftAttachmentReferencesSchema.parse(
      input.receipt.message.attachmentReferences ??
        (input.receipt.message.attachmentUploadIds ?? []).map((uploadId) => ({
          uploadId,
        }))
    );
    if (
      draft &&
      draft.revision === input.receipt.draftConsume.expectedRevision &&
      draft.text === input.receipt.message.content &&
      sameReferences(
        parseStoredDraftReferences(draft.attachmentReferences),
        messageReferences
      )
    ) {
      return { outcome: "unchanged", attachments: [] };
    }
    return { outcome: "ambiguous", attachments: [] };
  });
}

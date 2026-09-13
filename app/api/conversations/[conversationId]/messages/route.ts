import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { z } from "zod";
import { isEnabledRuntimeModelId } from "@/lib/modelRegistry";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import {
  apiSecurityResponse,
  assertMessageCapacity,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { enqueueArtifactCleanupForMessages } from "@/lib/generatedArtifactStorage";
import {
  ActiveChatResponseAttemptError,
  deleteChatResponseAttemptsForModelHistory,
} from "@/lib/chatResponseAttemptDeletion";
import {
  ChatDraftConsumeConflictError,
  chatDraftConsumeRequestSchema,
  consumeChatDraftForMessage,
  preflightChatDraftForMessage,
} from "@/lib/chatDraftMessageConsume";
import { scopedMessageId } from "@/lib/messageRequestIdentity";
import {
  PUBLIC_MESSAGE_ATTACHMENT_SELECT,
  toPublicMessageAttachment,
} from "@/lib/messageAttachmentCore";
import {
  MessageAttachmentBindError,
  accountAttachmentPrefix,
  bindMessageAttachments,
} from "@/lib/messageAttachmentStorage";
import {
  exactExistingOwnedMessage,
  MessageAttachmentResendError,
  savedMessageAttachmentReferencesSchema,
  saveMessagesWithAttachmentReferences,
} from "@/lib/messageAttachmentResend";

const modelIdSchema = z
  .string()
  .min(1)
  .max(120);
/**
 * The attachments one saved message carries.
 *
 * Opaque upload ids only, in the order the composer sent them -- that order
 * becomes `ordinal`, which with `messageId` is the idempotency key. No name,
 * no media type, no size and above all no storage key: every one of those is
 * read from the row the id resolves to, so a re-posted save cannot change what
 * a file is (docs/policy/user-attachment-persistence.md).
 */
const attachmentUploadIdSchema = z.string().trim().min(1).max(64);

const userMessageSchema = z
  .object({
    // `id` is the pre-durable browser bundle's spelling. Treat it as an
    // external request id and still derive the database Message id on the
    // server; never restore the old trust-in-client-primary-key behaviour.
    clientRequestId: z.string().uuid().optional(),
    id: z.string().uuid().optional(),
    role: z.literal("user"),
    /*
      Empty is allowed, and that is the fix rather than an oversight.

      A message with only files used to be stored with the file names joined
      into its text, because this schema demanded at least one character. The
      result was a turn that came back from a reload as "a.docx, b.xlsx" with
      no cards and nothing a later turn could read. A message that carries
      attachments is a complete message; the refinement below is what keeps a
      genuinely empty one out.
    */
    content: z.string().trim().max(50_000),
    status: z.literal("normal").optional().default("normal"),
    modelId: modelIdSchema.optional(),
    attachmentUploadIds: z.array(attachmentUploadIdSchema).max(5).optional(),
    attachmentReferences: savedMessageAttachmentReferencesSchema.optional(),
  })
  .strict()
  .refine(
    (message) => Boolean(message.clientRequestId) !== Boolean(message.id),
    { message: "Provide exactly one message request id." }
  )
  .refine((message) => !(message.attachmentUploadIds && message.attachmentReferences),
    { message: "Use one attachment reference format per message." })
  .refine(
    (message) =>
      message.content.length > 0 ||
      (message.attachmentUploadIds?.length ?? 0) > 0 ||
      (message.attachmentReferences?.length ?? 0) > 0,
    { message: "A message must have text or at least one attachment." }
  )
  .transform(({ id, clientRequestId, ...message }) => ({
    ...message,
    clientRequestId: (clientRequestId ?? id)!,
  }));
const saveMessagesSchema = z
  .object({
    messages: z.array(userMessageSchema).min(1).max(3),
    draftConsume: chatDraftConsumeRequestSchema.optional(),
  })
  .strict()
  .refine((body) => new Set(body.messages.map((message) => message.clientRequestId)).size === body.messages.length,
    { message: "Message request ids must be unique within one save." })
  .refine(
    (body) =>
      !body.draftConsume ||
      (body.messages.length === 1 &&
        body.messages[0]?.clientRequestId === body.draftConsume.requestId),
    { message: "A draft consumption must name the one message being saved." }
  );

export async function POST(
  req: Request,
  context: RouteContext<"/api/conversations/[conversationId]/messages">
) {
  try {
	const params = await context.params;
      const conversationId = params.conversationId;

      if (!conversationId) {
          return NextResponse.json({ error: "Conversation ID is required." }, { status: 400 });
      }

      const session = await getServerSession(authOptions);
      if (!session || !session.user) {
          return NextResponse.json({ error: "Authentication required." }, { status: 401 });
      }

      const userId = session.user.id;
      await consumeApiRateLimit(req, userId, "message-save", {
        minute: 30,
        day: 1_000,
      });
      const existingConv = await prisma.conversation.findUnique({
          where: { id: conversationId },
          select: { userId: true, password: true, kind: true, productKey: true }
      });

      if (!existingConv || existingConv.userId !== userId) {
          return NextResponse.json({ error: "You do not have access to this conversation." }, { status: 403 });
      }
      if (
        !hasConversationUnlockGrant(
          req,
          userId,
          conversationId,
          existingConv.password
        )
      ) {
        return conversationLockedResponse();
      }

    const body = await readLimitedJson(req, 160 * 1024, saveMessagesSchema);
    const messageMappings = body.messages.map((message) => ({
      requestId: message.clientRequestId,
      messageId: scopedMessageId(conversationId, message.clientRequestId),
    }));
    const internalIdByRequest = new Map(
      messageMappings.map((mapping) => [mapping.requestId, mapping.messageId])
    );
    const messages = body.messages.map(({ clientRequestId, ...message }) => ({
      ...message,
      id: internalIdByRequest.get(clientRequestId)!,
    }));
    const draftConsume = body.draftConsume
      ? {
          scopeKey: body.draftConsume.scopeKey,
          expectedRevision: body.draftConsume.expectedRevision,
          messageId: internalIdByRequest.get(body.draftConsume.requestId)!,
        }
      : undefined;
    if (body.draftConsume &&
        (existingConv.kind !== "chat" || existingConv.productKey !== "chat")) {
      return NextResponse.json(
        {
          error: "This draft cannot be consumed for this conversation.",
          code: "CHAT_DRAFT_CONSUME_NOT_SUPPORTED",
        },
        { status: 409, headers: { "Cache-Control": "private, no-store" } }
      );
    }
    const requestedModelIds = Array.from(
      new Set(messages.flatMap((message) => (message.modelId ? [message.modelId] : [])))
    );
    const validModelFlags = await Promise.all(requestedModelIds.map(isEnabledRuntimeModelId));
    if (validModelFlags.some((valid) => !valid)) {
      return NextResponse.json({ error: "Unsupported model." }, { status: 400 });
    }
    const contentBytes = messages.reduce(
      (total, message) => total + Buffer.byteLength(message.content, "utf8"),
      0
    );
    const ownPrefix = session.user.email
      ? accountAttachmentPrefix(session.user.email)
      : null;
    const carriesAttachments = messages.some(
      (message) => (message.attachmentUploadIds?.length ?? 0) > 0 ||
        (message.attachmentReferences?.length ?? 0) > 0
    );
    if (carriesAttachments && !ownPrefix) {
      return NextResponse.json(
        { error: "Attachments require a verified account address." },
        { status: 400 }
      );
    }

    /*
      The message rows and their attachment rows commit together.

      That is the whole contract of this endpoint: there is no state in which a
      stored turn shows a file count it cannot list, or lists a file the
      message never carried. `skipDuplicates` on both sides makes a re-posted
      save converge on the same rows rather than failing -- the unique index on
      (messageId, ordinal) is what makes that idempotent rather than merely
      forgiving.
    */
    const created = messages.some((message) => message.attachmentReferences !== undefined)
      ? await saveMessagesWithAttachmentReferences({
          userId, conversationId, ownPrefix: ownPrefix ?? "", messages,
          ...(draftConsume
            ? {
                beforePrepare: async () => {
                  return preflightChatDraftForMessage({
                    userId,
                    conversationId,
                    draftConsume,
                    message: messages[0]!,
                  });
                },
                beforeCommit: async (tx) => {
                  return consumeChatDraftForMessage(tx, {
                    userId,
                    conversationId,
                    draftConsume,
                    message: messages[0]!,
                  });
                },
              }
            : {}),
          beforeCreate: (tx) => assertMessageCapacity(tx, userId, conversationId, messages.length, contentBytes),
        })
      : await prisma.$transaction(async (tx) => {
      if (draftConsume) {
        const consumption = await consumeChatDraftForMessage(tx, {
          userId,
          conversationId,
          draftConsume,
          message: messages[0]!,
        });
        if (consumption.replay) return { count: 0 };
      }
      await assertMessageCapacity(
        tx,
        userId,
        conversationId,
        messages.length,
        contentBytes
      );
      let count = 0;
      for (const message of messages) {
        const inserted = await tx.message.createMany({
          data: [{
            id: message.id,
            conversationId,
            role: "user",
            content: message.content,
            status: "normal",
            modelId: message.modelId || null,
          }],
          skipDuplicates: true,
        });
        count += inserted.count;
        if (!inserted.count) {
          /*
            A duplicate primary key proves neither ownership nor an exact
            replay. Validate text, model and the ordered attachment identity
            before binding anything. Otherwise a replay could mutate an
            existing text-only Message by attaching a fresh upload to it.
          */
          if (!await exactExistingOwnedMessage(tx, message, userId, conversationId)) {
            throw new MessageAttachmentResendError("MESSAGE_SAVE_CONFLICT", 409);
          }
          continue;
        }
        if (!message.attachmentUploadIds?.length || !ownPrefix) continue;
        await bindMessageAttachments(tx, {
          userId,
          ownPrefix,
          conversationId,
          messageId: message.id,
          uploadIds: message.attachmentUploadIds,
        });
      }
      return { count };
    });

    /*
      Read back rather than echoed.

      The composer needs the durable ids so the cards it is already showing
      become the cards a reload will produce -- and a re-posted save that
      wrote nothing still has to return the ids of the rows that were already
      there. Public fields only: the select cannot name `objectKey`.
    */
    const attachments = carriesAttachments
      ? await prisma.messageAttachment.findMany({
          where: {
            messageId: { in: messages.map((message) => message.id) },
            userId,
            conversationId,
          },
          orderBy: [{ messageId: "asc" }, { ordinal: "asc" }],
          select: { ...PUBLIC_MESSAGE_ATTACHMENT_SELECT, messageId: true },
        })
      : [];

    return NextResponse.json({
      success: true,
      created: created.count,
      messageMappings,
      ...(body.draftConsume ? { draftConsumed: true } : {}),
      ...(carriesAttachments
        ? {
            attachments: attachments.map((attachment) => ({
              messageId: attachment.messageId,
              ...toPublicMessageAttachment(attachment),
            })),
          }
        : {}),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    if (error instanceof MessageAttachmentResendError) {
      return NextResponse.json(
        { error: "This question could not be saved with its attachments.", code: error.code },
        { status: error.status }
      );
    }
    if (error instanceof ChatDraftConsumeConflictError) {
      return NextResponse.json(
        { error: "This message no longer matches the draft being sent.", code: error.code },
        { status: error.status, headers: { "Cache-Control": "private, no-store" } }
      );
    }
    if (error instanceof MessageAttachmentBindError) {
      // One answer for "no such upload" and "somebody else's upload": the
      // caller learns that this save cannot carry that file and nothing more.
      console.warn(
        JSON.stringify({
          event: "message_attachment_bind_refused",
          code: error.code,
          timestamp: new Date().toISOString(),
        })
      );
      return NextResponse.json(
        {
          error: "An attachment in this message is not available.",
          // Missing, foreign and out-of-prefix opaque upload ids are the same
          // fact to a caller. Keep the precise reason in the server log above,
          // but do not turn this endpoint into an upload-id existence oracle.
          code: error.code === "ATTACHMENT_ALREADY_BOUND"
            ? error.code
            : "ATTACHMENT_UNAVAILABLE",
        },
        { status: 400 }
      );
    }
    console.error("Failed to save messages:", error);
    return NextResponse.json(
      { error: "Failed to save messages." },
      { status: 500 }
    );
  }
}

export async function DELETE(
    req: Request,
    context: RouteContext<"/api/conversations/[conversationId]/messages">
) {
    try {
        const session = await getServerSession(authOptions);

        if (!session || !session.user) {
            return NextResponse.json({ error: "Authentication required." }, { status: 401 });
        }

        const params = await context.params;
        const conversationId = params.conversationId;

        const userId = session.user.id;
        await consumeApiRateLimit(req, userId, "message-delete", {
          minute: 20,
          day: 200,
        });
        const existingConv = await prisma.conversation.findUnique({
            where: { id: conversationId },
            select: { userId: true, password: true }
        });

        if (!existingConv || existingConv.userId !== userId) {
            return NextResponse.json({ error: "You do not have access to this conversation." }, { status: 403 });
        }
        if (
          !hasConversationUnlockGrant(
            req,
            userId,
            conversationId,
            existingConv.password
          )
        ) {
          return conversationLockedResponse();
        }

        const { searchParams } = new URL(req.url);
        const modelId = searchParams.get("modelId");

        if (!conversationId || !modelId) {
            return NextResponse.json({ error: "Missing required parameter." }, { status: 400 });
        }
        const parsedModelId = modelIdSchema.safeParse(modelId);
        if (!parsedModelId.success || !(await isEnabledRuntimeModelId(parsedModelId.data))) {
            return NextResponse.json({ error: "Unsupported model." }, { status: 400 });
        }

        await prisma.$transaction(async (tx) => {
            // DB-first tombstone, before the cascade takes the rows with it:
            // MessageArtifact cascades from Message, so after the delete there
            // is nothing left to read the object keys from
            // (docs/policy/generated-artifacts.md section 8).
            await enqueueArtifactCleanupForMessages(tx, {
                conversationId,
                modelId: parsedModelId.data,
                role: "assistant",
            });
            await deleteChatResponseAttemptsForModelHistory(tx, {
                userId,
                conversationId,
                modelId: parsedModelId.data,
            });
            const deletedSources = await tx.message.deleteMany({
                where: {
                    conversationId,
                    modelId: parsedModelId.data,
                    role: "assistant",
                },
            });
            if (deletedSources.count > 0) {
                await tx.comparisonReview.updateMany({
                    where: {
                        conversationId,
                        isStale: false,
                    },
                    data: { isStale: true },
                });
            }
        });

        return NextResponse.json({ success: true });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;

    if (error instanceof ActiveChatResponseAttemptError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    console.error("Failed to delete messages:", error);
    return NextResponse.json({ error: "Failed to delete messages." }, { status: 500 });
  }
}

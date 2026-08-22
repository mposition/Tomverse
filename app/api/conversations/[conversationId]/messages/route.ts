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
  PUBLIC_MESSAGE_ATTACHMENT_SELECT,
  toPublicMessageAttachment,
} from "@/lib/messageAttachmentCore";
import {
  MessageAttachmentBindError,
  accountAttachmentPrefix,
  bindMessageAttachments,
} from "@/lib/messageAttachmentStorage";

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
    id: z.string().uuid(),
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
  })
  .strict()
  .refine(
    (message) =>
      message.content.length > 0 ||
      (message.attachmentUploadIds?.length ?? 0) > 0,
    { message: "A message must have text or at least one attachment." }
  );
const saveMessagesSchema = z
  .object({
    messages: z.array(userMessageSchema).min(1).max(3),
  })
  .strict();

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

    const body = await readLimitedJson(req, 160 * 1024, saveMessagesSchema);
    const requestedModelIds = Array.from(
      new Set(body.messages.flatMap((message) => (message.modelId ? [message.modelId] : [])))
    );
    const validModelFlags = await Promise.all(requestedModelIds.map(isEnabledRuntimeModelId));
    if (validModelFlags.some((valid) => !valid)) {
      return NextResponse.json({ error: "Unsupported model." }, { status: 400 });
    }
    const contentBytes = body.messages.reduce(
      (total, message) => total + Buffer.byteLength(message.content, "utf8"),
      0
    );
    const ownPrefix = session.user.email
      ? accountAttachmentPrefix(session.user.email)
      : null;
    const carriesAttachments = body.messages.some(
      (message) => (message.attachmentUploadIds?.length ?? 0) > 0
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
    const created = await prisma.$transaction(async (tx) => {
      await assertMessageCapacity(
        tx,
        userId,
        conversationId,
        body.messages.length,
        contentBytes
      );
      const result = await tx.message.createMany({
        data: body.messages.map((message) => ({
          id: message.id,
          conversationId,
          role: "user",
          content: message.content,
          status: "normal",
          modelId: message.modelId || null,
        })),
        skipDuplicates: true,
      });
      for (const message of body.messages) {
        if (!message.attachmentUploadIds?.length || !ownPrefix) continue;
        await bindMessageAttachments(tx, {
          userId,
          ownPrefix,
          conversationId,
          messageId: message.id,
          uploadIds: message.attachmentUploadIds,
        });
      }
      return result;
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
            messageId: { in: body.messages.map((message) => message.id) },
            userId,
          },
          orderBy: [{ messageId: "asc" }, { ordinal: "asc" }],
          select: { ...PUBLIC_MESSAGE_ATTACHMENT_SELECT, messageId: true },
        })
      : [];

    return NextResponse.json({
      success: true,
      created: created.count,
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
        { error: "An attachment in this message is not available.", code: error.code },
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

    console.error("Failed to delete messages:", error);
    return NextResponse.json({ error: "Failed to delete messages." }, { status: 500 });
  }
}

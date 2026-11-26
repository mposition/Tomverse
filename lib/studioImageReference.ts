import "server-only";

import type { Prisma } from "@prisma/client";
import { ChatAccessError } from "@/lib/chatSecurity";
import { IMAGE_EDIT_SOURCE_MAX_BYTES, IMAGE_EDIT_SOURCE_MEDIA_TYPES } from "@/lib/imageGenerationPricing";
import { accountAttachmentPrefix, bindMessageAttachments } from "@/lib/messageAttachmentStorage";

/**
 * A Studio tool run is a one-off: its result is shown and saved in the tool and nothing resumes it, so it
 * is not part of the conversation history. It still has a conversation row, which the image tables hang
 * from, and is told apart by the request message this file writes into it. Nothing else writes a message
 * into an image conversation: the image workspace keeps its prompts on the generation rows.
 */
export const STUDIO_RUN_CONVERSATION = { kind: "image", messages: { some: {} } } satisfies Prisma.ConversationWhereInput;

/** The request of a Studio run that has no photo. With a photo, bindStudioImageUpload writes it. */
export async function recordStudioRequest(tx: Prisma.TransactionClient, conversationId: string, prompt: string) {
  return tx.message.create({ data: { conversationId, role: "user", content: prompt }, select: { id: true } });
}

export async function bindStudioImageUpload(tx: Prisma.TransactionClient, input: {
  userId: string;
  email: string;
  conversationId: string;
  uploadId: string;
  prompt: string;
}) {
  const { userId, email, conversationId, uploadId, prompt } = input;
  const upload = await tx.messageAttachmentUpload.findFirst({
    where: { id: uploadId, userId, sourceArtifactId: null },
    select: { id: true, size: true, mediaType: true },
  });
  if (!upload || upload.size > IMAGE_EDIT_SOURCE_MAX_BYTES || !IMAGE_EDIT_SOURCE_MEDIA_TYPES.includes(upload.mediaType)) {
    throw new ChatAccessError(400, "STUDIO_INVALID_REFERENCE", "The reference image is unavailable.");
  }
  const message = await recordStudioRequest(tx, conversationId, prompt);
  await bindMessageAttachments(tx, {
    userId,
    ownPrefix: accountAttachmentPrefix(email),
    conversationId,
    messageId: message.id,
    uploadIds: [upload.id],
  });
  const attachment = await tx.messageAttachment.findFirstOrThrow({
    where: { messageId: message.id, userId, uploadId: upload.id },
    select: { id: true },
  });
  return attachment.id;
}

import "server-only";

import type { Prisma } from "@prisma/client";
import { ChatAccessError } from "@/lib/chatSecurity";
import { IMAGE_EDIT_SOURCE_MAX_BYTES, IMAGE_EDIT_SOURCE_MEDIA_TYPES } from "@/lib/imageGenerationPricing";
import { accountAttachmentPrefix, bindMessageAttachments } from "@/lib/messageAttachmentStorage";

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
  const message = await tx.message.create({
    data: { conversationId, role: "user", content: prompt },
    select: { id: true },
  });
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

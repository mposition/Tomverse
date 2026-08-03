import type { ChatAttachment, Message } from "@/components/chat/types";

/**
 * Purpose-built message serializers for everything that leaves client
 * memory. Allowlists, not spreads: a runtime-only field added to Message
 * (today: `errorReport`, whose token must never be persisted or ride along
 * in a chat transcript) stays out of every payload unless a serializer here
 * names it explicitly.
 */

const serializeAttachments = (
  attachments: ChatAttachment[] | undefined,
  { stripData }: { stripData: boolean }
): ChatAttachment[] | undefined => {
  if (!attachments?.length) return attachments;
  return attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    size: attachment.size,
    kind: attachment.kind,
    // An objectKey means the bytes live in object storage; the inline data
    // URL is only the preview and is dropped from requests and storage alike.
    ...(attachment.data !== undefined &&
    !(stripData && attachment.objectKey)
      ? { data: attachment.data }
      : {}),
    ...(attachment.objectKey !== undefined
      ? { objectKey: attachment.objectKey }
      : {}),
  }));
};

const pickTransportFields = (message: Message): Message => ({
  id: message.id,
  role: message.role,
  content: message.content,
  ...(message.status !== undefined ? { status: message.status } : {}),
  ...(message.modelId !== undefined ? { modelId: message.modelId } : {}),
  ...(message.errorCode !== undefined ? { errorCode: message.errorCode } : {}),
  ...(message.errorHadAttachments !== undefined
    ? { errorHadAttachments: message.errorHadAttachments }
    : {}),
  ...(message.createdAt !== undefined ? { createdAt: message.createdAt } : {}),
  ...(message.pendingJobId !== undefined
    ? { pendingJobId: message.pendingJobId }
    : {}),
  ...(message.searchMetadata !== undefined
    ? { searchMetadata: message.searchMetadata }
    : {}),
});

/** The /api/chat request transcript. Never contains `errorReport`. */
export const toChatRequestMessage = (message: Message): Message => ({
  ...pickTransportFields(message),
  ...(message.attachments !== undefined
    ? { attachments: serializeAttachments(message.attachments, { stripData: true }) }
    : {}),
});

/**
 * The guest localStorage snapshot. Identical shape to the request transcript
 * today -- and deliberately without `errorReport`: the error report context
 * is live-memory only, so a reload legitimately loses the token and the
 * report simply verifies as `missing_token`.
 */
export const toGuestPersistableMessage = (message: Message): Message =>
  toChatRequestMessage(message);

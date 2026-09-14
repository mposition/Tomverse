import "server-only";

import { prisma } from "@/lib/prisma";
import {
  PUBLIC_MESSAGE_ATTACHMENT_SELECT,
  toPublicMessageAttachment,
} from "@/lib/messageAttachmentCore";
import type { ChatResponseAttemptRecord } from "@/lib/chatResponseAttemptCore";

/**
 * The one allowlist used whenever an authenticated Chat message crosses the
 * server/browser boundary.
 *
 * In particular, neither generated artifacts nor user attachments are read
 * with an `include`: both tables contain private object-storage keys. Keeping
 * this select shared stops the attempt-recovery endpoint from becoming a
 * second, subtly different transcript serializer.
 */
export const PUBLIC_CHAT_MESSAGE_SELECT = {
  id: true,
  role: true,
  content: true,
  status: true,
  modelId: true,
  pendingJobId: true,
  searchMetadata: true,
  createdAt: true,
  memoryUsedCount: true,
  knowledgeChunkCount: true,
  artifacts: {
    orderBy: { ordinal: "asc" as const },
    select: {
      id: true,
      ordinal: true,
      format: true,
      filename: true,
      mediaType: true,
      byteSize: true,
      status: true,
      failureCode: true,
      modelId: true,
    },
  },
  attachments: {
    orderBy: { ordinal: "asc" as const },
    select: PUBLIC_MESSAGE_ATTACHMENT_SELECT,
  },
} as const;

type PublicChatMessageRow = {
  id: string;
  role: string;
  content: string;
  status: string;
  modelId: string | null;
  pendingJobId: string | null;
  searchMetadata: unknown;
  createdAt: Date | string;
  memoryUsedCount: number | null;
  knowledgeChunkCount: number | null;
  artifacts: Array<{
    id: string;
    ordinal: number;
    format: string;
    filename: string;
    mediaType: string;
    byteSize: number;
    status: string;
    failureCode: string | null;
    modelId: string | null;
  }>;
  attachments: Array<Parameters<typeof toPublicMessageAttachment>[0]>;
};

/** Field-by-field public serialization; private columns cannot hitch a ride. */
export const toPublicChatMessage = (row: PublicChatMessageRow) => ({
  id: row.id,
  role: row.role,
  content: row.content,
  status: row.status,
  modelId: row.modelId,
  pendingJobId: row.pendingJobId,
  searchMetadata: row.searchMetadata,
  createdAt: row.createdAt,
  ...(row.attachments.length
    ? {
        // docs/policy/user-attachment-persistence.md §4: the card keys on
        // `id`, while the next request names that same public row through
        // `attachmentId`. Repeating the value here keeps that identity fact
        // at the server boundary instead of teaching the client DB layout.
        attachments: row.attachments.map((attachment) => ({
          ...toPublicMessageAttachment(attachment),
          attachmentId: attachment.id,
        })),
      }
    : {}),
  ...(row.artifacts.length
    ? {
        artifacts: row.artifacts.map((artifact) => ({
          id: artifact.id,
          ordinal: artifact.ordinal,
          format: artifact.format,
          filename: artifact.filename,
          mediaType: artifact.mediaType,
          byteSize: artifact.byteSize,
          status: artifact.status,
          failureCode: artifact.failureCode,
          modelId: artifact.modelId,
        })),
      }
    : {}),
  // docs/policy/external-conversation-import-and-memory.md §13.4 and §14.3:
  // null means context injection was unavailable and zero means retrieval
  // selected nothing. Neither is a disclosure the UI may show, so omit the
  // fields at the serializer rather than asking every renderer to hide them.
  ...(typeof row.memoryUsedCount === "number" && row.memoryUsedCount > 0
    ? { memoryUsedCount: row.memoryUsedCount }
    : {}),
  ...(typeof row.knowledgeChunkCount === "number" && row.knowledgeChunkCount > 0
    ? { knowledgeChunkCount: row.knowledgeChunkCount }
    : {}),
});

/**
 * Reads the canonical Message that was committed in the same transaction as
 * a completed durable attempt. The owner predicate is repeated here even
 * though the caller already authorized the attempt: this helper is a public
 * response boundary and should remain safe if it gets another caller later.
 */
export async function readPublicCompletedChatMessage(
  userId: string,
  attempt: Pick<
    ChatResponseAttemptRecord,
    "assistantMessageId" | "conversationId" | "actualModelId" | "requestedModelId"
  >
) {
  const expectedModelId = attempt.actualModelId ?? attempt.requestedModelId;
  const row = await prisma.message.findFirst({
    where: {
      id: attempt.assistantMessageId,
      conversationId: attempt.conversationId,
      role: "assistant",
      modelId: expectedModelId,
      conversation: { userId },
    },
    select: PUBLIC_CHAT_MESSAGE_SELECT,
  });
  return row ? toPublicChatMessage(row) : null;
}

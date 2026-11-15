import "server-only";

import { prisma } from "@/lib/prisma";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import { generatedArtifactRevisionEnabled } from "@/lib/generatedArtifactRevisionCore";
import { PUBLIC_CHAT_MESSAGE_SELECT } from "@/lib/publicChatMessage";

export class GeneratedArtifactLineageError extends Error {
  constructor(readonly code: "ARTIFACT_NOT_FOUND" | "CONVERSATION_LOCKED", readonly status: number) {
    super(code); this.name = "GeneratedArtifactLineageError";
  }
}

const unavailable = () => new GeneratedArtifactLineageError("ARTIFACT_NOT_FOUND", 404);
const PAGE_SIZE = 50;

/** Owner-only real source edges. Nothing here infers relationships from names. */
export async function readGeneratedArtifactVersions(input: {
  request: Request; userId: string; artifactId: string; cursor?: string | null;
}) {
  if (!generatedArtifactRevisionEnabled() || !/^[A-Za-z0-9_-]{1,64}$/.test(input.artifactId)) throw unavailable();
  const source = await prisma.messageArtifact.findFirst({
    where: { id: input.artifactId, userId: input.userId, status: "ready" },
    select: { id: true, conversationId: true, lineageId: true,
      conversation: { select: { userId: true, password: true } } },
  });
  if (!source || source.conversation.userId !== input.userId) throw unavailable();
  if (!hasConversationUnlockGrant(input.request, input.userId, source.conversationId, source.conversation.password)) {
    throw new GeneratedArtifactLineageError("CONVERSATION_LOCKED", 423);
  }
  const root = source.lineageId ?? source.id;
  const scope = { userId: input.userId, conversationId: source.conversationId, status: "ready",
    OR: [{ lineageId: root }, { id: root, lineageId: null }] };
  let before;
  if (input.cursor) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.cursor)) throw unavailable();
    const cursor = await prisma.messageArtifact.findFirst({ where: { ...scope, id: input.cursor },
      select: { id: true, createdAt: true } });
    if (!cursor) throw unavailable();
    before = { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] };
  }
  const rows = await prisma.messageArtifact.findMany({
    where: { AND: [scope, ...(before ? [before] : [])] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: PAGE_SIZE + 1,
    select: { ...PUBLIC_CHAT_MESSAGE_SELECT.artifacts.select, createdAt: true },
  });
  const page = rows.slice(0, PAGE_SIZE);
  return {
    artifacts: page.map((row) => ({
      id: row.id, ordinal: row.ordinal, format: row.format, filename: row.filename,
      mediaType: row.mediaType, byteSize: row.byteSize, status: row.status,
      ...(row.failureCode ? { failureCode: row.failureCode } : {}),
      ...(row.modelId ? { modelId: row.modelId } : {}),
      parentArtifactId: row.parentArtifactId,
      lineageId: row.lineageId ?? row.id,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: rows.length > PAGE_SIZE ? page[page.length - 1].id : null,
  };
}

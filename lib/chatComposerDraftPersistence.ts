import "server-only";

import type { Prisma } from "@prisma/client";

import {
  CHAT_DRAFT_REVISION_CONFLICT,
  decideDraftCas,
  draftConversationId,
  parseStoredDraftReferences,
  type ChatComposerDraftPut,
} from "@/lib/chatComposerDraftCore";
import {
  accountAttachmentPrefix,
  resolveMessageAttachmentReferences,
} from "@/lib/messageAttachmentStorage";
import { prisma } from "@/lib/prisma";

const DRAFT_SELECT = {
  scopeKey: true,
  conversationId: true,
  text: true,
  attachmentReferences: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class ChatDraftRevisionConflictError extends Error {
  readonly code = CHAT_DRAFT_REVISION_CONFLICT;

  constructor(readonly currentRevision: number | null) {
    super("The Chat draft changed before this request was applied.");
    this.name = "ChatDraftRevisionConflictError";
  }
}
const normalizeDraftRow = (row: {
  scopeKey: string;
  conversationId: string | null;
  text: string;
  attachmentReferences: Prisma.JsonValue;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  ...row,
  attachmentReferences: parseStoredDraftReferences(row.attachmentReferences),
});

export async function readChatComposerDraft(userId: string, scopeKey: string) {
  const row = await prisma.chatComposerDraft.findUnique({
    where: { userId_scopeKey: { userId, scopeKey } },
    select: DRAFT_SELECT,
  });
  return row ? normalizeDraftRow(row) : null;
}

async function validateAttachmentOwnership(input: {
  userId: string;
  userEmail: string | null | undefined;
  scopeKey: string;
  draft: ChatComposerDraftPut;
}) {
  if (input.draft.attachmentReferences.length === 0) return;
  if (!input.userEmail) {
    throw new Error("CHAT_DRAFT_ATTACHMENT_ACCOUNT_ADDRESS_REQUIRED");
  }
  await resolveMessageAttachmentReferences({
    userId: input.userId,
    ownPrefix: accountAttachmentPrefix(input.userEmail),
    conversationId: draftConversationId(input.scopeKey),
    references: input.draft.attachmentReferences,
  });
}

export async function writeChatComposerDraft(input: {
  userId: string;
  userEmail: string | null | undefined;
  scopeKey: string;
  draft: ChatComposerDraftPut;
}) {
  await validateAttachmentOwnership(input);

  const current = await prisma.chatComposerDraft.findUnique({
    where: { userId_scopeKey: { userId: input.userId, scopeKey: input.scopeKey } },
    select: { revision: true },
  });
  const decision = decideDraftCas(current?.revision ?? null, input.draft.expectedRevision);
  if (decision.action === "conflict") {
    throw new ChatDraftRevisionConflictError(decision.currentRevision);
  }

  const attachmentReferences = input.draft.attachmentReferences as Prisma.InputJsonValue;
  if (decision.action === "create") {
    try {
      const created = await prisma.chatComposerDraft.create({
        data: {
          userId: input.userId,
          scopeKey: input.scopeKey,
          conversationId: draftConversationId(input.scopeKey),
          text: input.draft.text,
          attachmentReferences,
          revision: decision.nextRevision,
        },
        select: DRAFT_SELECT,
      });
      return normalizeDraftRow(created);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
        const raced = await prisma.chatComposerDraft.findUnique({
          where: { userId_scopeKey: { userId: input.userId, scopeKey: input.scopeKey } },
          select: { revision: true },
        });
        throw new ChatDraftRevisionConflictError(raced?.revision ?? null);
      }
      throw error;
    }
  }

  const updated = await prisma.chatComposerDraft.updateMany({
    where: {
      userId: input.userId,
      scopeKey: input.scopeKey,
      revision: input.draft.expectedRevision,
    },
    data: {
      text: input.draft.text,
      attachmentReferences,
      revision: decision.nextRevision,
    },
  });
  if (updated.count !== 1) {
    const raced = await prisma.chatComposerDraft.findUnique({
      where: { userId_scopeKey: { userId: input.userId, scopeKey: input.scopeKey } },
      select: { revision: true },
    });
    throw new ChatDraftRevisionConflictError(raced?.revision ?? null);
  }

  const row = await prisma.chatComposerDraft.findUniqueOrThrow({
    where: { userId_scopeKey: { userId: input.userId, scopeKey: input.scopeKey } },
    select: DRAFT_SELECT,
  });
  return normalizeDraftRow(row);
}

export async function deleteChatComposerDraft(input: {
  userId: string;
  scopeKey: string;
  expectedRevision: number;
}) {
  const deleted = await prisma.chatComposerDraft.deleteMany({
    where: {
      userId: input.userId,
      scopeKey: input.scopeKey,
      revision: input.expectedRevision,
    },
  });
  if (deleted.count === 1) return;

  const current = await prisma.chatComposerDraft.findUnique({
    where: { userId_scopeKey: { userId: input.userId, scopeKey: input.scopeKey } },
    select: { revision: true },
  });
  throw new ChatDraftRevisionConflictError(current?.revision ?? null);
}

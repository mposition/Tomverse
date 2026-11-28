import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { assertConversationCapacity, assertMessageCapacity } from "@/lib/apiSecurity";
import { autoAvailabilityFor } from "@/lib/autoAvailability";
import { mayStoreSelectionMode } from "@/lib/autoRoutingUi";
import {
  branchTitle,
  isBranchableAnswer,
  messagesToCopy,
  omittedFilesNote,
  orderedCreatedAt,
} from "@/lib/chatBranchCore";
import { createConversation } from "@/lib/conversationCreation";
import { isChatConversationKind } from "@/lib/conversationKindGuard";
import { CHAT_PRODUCT_KEY } from "@/lib/conversationProduct";
import { scopedMessageId } from "@/lib/messageRequestIdentity";
import { prisma } from "@/lib/prisma";

/**
 * Why a conversation cannot be branched, as the code the route answers with.
 *
 * Each is a state of the source, never a permission: ownership is checked
 * first and answers 403/404 like every conversation route.
 */
export type BranchRefusal =
  | "BRANCH_NOT_FOUND"
  | "BRANCH_FORBIDDEN"
  | "BRANCH_NOT_CHAT"
  | "BRANCH_TEMPORARY"
  | "BRANCH_LOCKED"
  | "BRANCH_EXTERNAL_CONTINUATION"
  | "BRANCH_PROJECT_ARCHIVED"
  | "BRANCH_ANSWER_NOT_FOUND"
  | "BRANCH_ANSWER_NOT_FINISHED";

export const BRANCH_REFUSAL_STATUS: Record<BranchRefusal, number> = {
  BRANCH_NOT_FOUND: 404,
  BRANCH_FORBIDDEN: 403,
  BRANCH_NOT_CHAT: 409,
  BRANCH_TEMPORARY: 409,
  BRANCH_LOCKED: 409,
  BRANCH_EXTERNAL_CONTINUATION: 409,
  BRANCH_PROJECT_ARCHIVED: 409,
  BRANCH_ANSWER_NOT_FOUND: 404,
  BRANCH_ANSWER_NOT_FINISHED: 409,
};

export type BranchResult =
  | {
      ok: true;
      conversationId: string;
      title: string;
      copiedMessages: number;
      /** Turns whose attachments or generated files were not copied. */
      turnsWithOmittedFiles: number;
    }
  | { ok: false; code: BranchRefusal };

const oneLine = (name: string) =>
  name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * Copies the standing text turns up to one answer into a new Chat
 * conversation of the same account. Nothing of the source changes.
 *
 * - Same product, model, search mode, project and assistant as the source; the
 *   conversation limits (count and messages) apply as to any new conversation.
 * - Attachments and generated files are not copied (their stored objects are
 *   owned one-to-one by their message): the turn that carried them says so in
 *   its text, which is also what a later model turn reads.
 * - Locked, temporary, image, Review and imported conversations are refused:
 *   a copy would move private or provider-bound content out of its protection.
 */
export async function branchConversationAtAnswer(input: {
  userId: string;
  conversationId: string;
  messageId: string;
  titleTemplate: string | null;
  filesTemplate: string | null;
}): Promise<BranchResult> {
  const { userId, conversationId } = input;
  const source = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      userId: true,
      title: true,
      kind: true,
      productKey: true,
      password: true,
      temporaryExpiresAt: true,
      selectedModels: true,
      disabledPanels: true,
      webSearchMode: true,
      selectionMode: true,
      memoryMode: true,
      projectId: true,
      assistantProfileVersionId: true,
      continuationBridge: { select: { id: true } },
      project: { select: { archivedAt: true } },
    },
  });
  if (!source) return { ok: false, code: "BRANCH_NOT_FOUND" };
  if (source.userId !== userId) return { ok: false, code: "BRANCH_FORBIDDEN" };
  if (!isChatConversationKind(source.kind) || source.productKey !== CHAT_PRODUCT_KEY) {
    return { ok: false, code: "BRANCH_NOT_CHAT" };
  }
  if (source.temporaryExpiresAt !== null) return { ok: false, code: "BRANCH_TEMPORARY" };
  if (source.password !== null) return { ok: false, code: "BRANCH_LOCKED" };
  if (source.continuationBridge) return { ok: false, code: "BRANCH_EXTERNAL_CONTINUATION" };
  if (source.project?.archivedAt) return { ok: false, code: "BRANCH_PROJECT_ARCHIVED" };

  const ordered = await prisma.message.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      role: true,
      content: true,
      status: true,
      modelId: true,
      supersededAt: true,
      researchRunId: true,
      createdAt: true,
      searchMetadata: true,
    },
  });
  // The browser holds either the request id of a message sent in this page or
  // the stored id of one loaded from history (lib/chatSupersededMessages.ts).
  const wanted = new Set([input.messageId, scopedMessageId(conversationId, input.messageId)]);
  const target = ordered.find((message) => wanted.has(message.id));
  if (!target) return { ok: false, code: "BRANCH_ANSWER_NOT_FOUND" };
  if (!isBranchableAnswer(target)) return { ok: false, code: "BRANCH_ANSWER_NOT_FINISHED" };
  const copied = messagesToCopy(ordered, target.id) ?? [];
  const copiedIds = copied.map((message) => message.id);

  const [attachments, artifacts] = await Promise.all([
    prisma.messageAttachment.findMany({
      where: { messageId: { in: copiedIds } },
      orderBy: [{ messageId: "asc" }, { ordinal: "asc" }],
      select: { messageId: true, name: true },
    }),
    prisma.messageArtifact.findMany({
      where: { messageId: { in: copiedIds } },
      select: { messageId: true, filename: true },
    }),
  ]);
  const filesByMessage = new Map<string, string[]>();
  for (const file of [
    ...attachments.map((row) => ({ messageId: row.messageId, name: row.name })),
    ...artifacts.map((row) => ({ messageId: row.messageId, name: row.filename })),
  ]) {
    filesByMessage.set(file.messageId, [...(filesByMessage.get(file.messageId) ?? []), oneLine(file.name)]);
  }

  // Auto is carried over only where this account is still offered it.
  let selectionMode: "manual" | "auto" = "manual";
  if (source.selectionMode === "auto") {
    const availability = await autoAvailabilityFor(userId, { productKey: source.productKey }).catch(() => null);
    if (availability && mayStoreSelectionMode("auto", availability)) selectionMode = "auto";
  }

  const title = branchTitle(source.title, input.titleTemplate);
  const times = orderedCreatedAt(copied.map((message) => message.createdAt));
  const rows = copied.map((message, index) => {
    const names = filesByMessage.get(message.id);
    const note = names?.length ? `\n\n${omittedFilesNote(names, input.filesTemplate)}` : "";
    return {
      id: randomUUID(),
      role: message.role,
      content: `${message.content}${note}`,
      status: "normal",
      modelId: message.modelId,
      searchMetadata: message.searchMetadata,
      createdAt: times[index]!,
    };
  });
  const bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row.content, "utf8"), 0);

  const created = await prisma.$transaction(
    async (tx) => {
      await assertConversationCapacity(tx, userId);
      const conversation = await createConversation(
        tx,
        {
          userId,
          title,
          productKey: CHAT_PRODUCT_KEY,
          selectionMode,
          selectedModels: source.selectedModels,
          disabledPanels: source.disabledPanels,
          webSearchMode: source.webSearchMode,
          projectId: source.projectId,
          assistantProfileVersionId: source.assistantProfileVersionId,
          ...(source.memoryMode === "off" ? { memoryMode: "off" as const } : {}),
        },
        { id: true }
      );
      await assertMessageCapacity(tx, userId, conversation.id, rows.length, bytes);
      await tx.message.createMany({
        data: rows.map((row) => ({
          id: row.id,
          conversationId: conversation.id,
          role: row.role,
          content: row.content,
          status: row.status,
          modelId: row.modelId,
          createdAt: row.createdAt,
          ...(row.searchMetadata === null ? {} : { searchMetadata: row.searchMetadata as Prisma.InputJsonValue }),
        })),
      });
      return conversation;
    },
    { timeout: 30_000 }
  );

  return {
    ok: true,
    conversationId: created.id,
    title,
    copiedMessages: rows.length,
    turnsWithOmittedFiles: filesByMessage.size,
  };
}

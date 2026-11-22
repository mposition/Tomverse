import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import { ResearchPreviewRunError } from "@/lib/deepResearchSettlementHandoff";
import {
  RESEARCH_RESOURCE_LIMITS, type ResearchManifestEntry, type ResearchPrivateManifestEntry, type ResearchSourceSelection,
} from "@/lib/researchEngineContract";
import { canonicalResearchUrl } from "@/lib/researchEngineEvidence";
import { extractResearchDocument, RESEARCH_READABLE_MEDIA_TYPES } from "@/lib/researchEngineDocuments";
import { validateResearchPageUrl } from "@/lib/researchPreviewPageRead";

/**
 * Selected private sources. A selection is resolved once, on the server, into
 * an owner-checked manifest entry with a revision digest; before every model
 * dispatch that would read it, the entry is re-validated against current
 * ownership, locks, deletion and Memory settings. A worker holds no cookie or
 * secret: a password-protected conversation must be unlocked when selected,
 * and any later password change revokes the grant.
 */

const digest = (...parts: Array<string | number | null | undefined>) =>
  `sha256:${createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\u0000")).digest("hex")}`;

const refuse = (code: string, message: string) => new ResearchPreviewRunError(409, code, message);

/** Project workspace integration point. No Project service exists on this branch; see researchProjectSourceAdapter. */
export type ResearchProjectSourceAdapter = {
  available(): boolean;
  resolve(input: { userId: string; projectId: string; materialId?: string }): Promise<{ revision: string; label: string } | null>;
  revalidate(input: { userId: string; projectId: string; materialId?: string; revision: string }): Promise<boolean>;
  load(input: { userId: string; projectId: string; materialId?: string }): Promise<{ text: string; label: string } | null>;
};

/** Default: unavailable. A real adapter is installed only once a Project service ships. */
let projectAdapter: ResearchProjectSourceAdapter = {
  available: () => false,
  resolve: async () => null,
  revalidate: async () => false,
  load: async () => null,
};
export const setResearchProjectSourceAdapter = (adapter: ResearchProjectSourceAdapter | null) => {
  projectAdapter = adapter ?? { available: () => false, resolve: async () => null, revalidate: async () => false, load: async () => null };
};
export const researchProjectSourcesAvailable = () => projectAdapter.available();

async function memoryAllowed(userId: string) {
  const settings = await prisma.userMemorySettings.findUnique({ where: { userId }, select: { masterEnabled: true } });
  return settings?.masterEnabled !== false;
}

export async function resolveResearchSelections(input: {
  userId: string; request: Request; selections: readonly ResearchSourceSelection[];
}): Promise<ResearchManifestEntry[]> {
  if (input.selections.length > RESEARCH_RESOURCE_LIMITS.maxManifestEntries) throw refuse("RESEARCH_TOO_MANY_SOURCES", "Too many sources were selected.");
  const entries: ResearchManifestEntry[] = [];
  let urls = 0; let privates = 0;
  const seen = new Set<string>();
  for (const selection of input.selections) {
    const dedupe = JSON.stringify(selection);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    if (selection.type === "url") {
      if (++urls > RESEARCH_RESOURCE_LIMITS.maxUserUrls) throw refuse("RESEARCH_TOO_MANY_URLS", "Too many URLs were provided.");
      const canonical = canonicalResearchUrl(selection.url);
      if (!canonical) throw refuse("RESEARCH_URL_UNSUPPORTED", "Only public https URLs can be researched.");
      try { validateResearchPageUrl(canonical); } catch { throw refuse("RESEARCH_URL_UNSUPPORTED", "Only public https URLs can be researched."); }
      entries.push({ type: "url", key: `W${urls}`, url: canonical });
      continue;
    }
    const key = `P${++privates}`;
    if (selection.type === "attachment") {
      const row = await prisma.messageAttachment.findFirst({ where: { id: selection.attachmentId, userId: input.userId, unavailableAt: null },
        select: { id: true, conversationId: true, name: true, mediaType: true, size: true, objectKey: true,
          conversation: { select: { userId: true, password: true, passwordVersion: true } } } });
      if (!row || row.conversation.userId !== input.userId) throw refuse("RESEARCH_SOURCE_UNAVAILABLE", "A selected file is unavailable.");
      if (row.conversation.password != null && !hasConversationUnlockGrant(input.request, input.userId, row.conversationId, row.conversation.passwordVersion)) {
        throw refuse("RESEARCH_CONVERSATION_LOCKED", "Unlock the conversation that holds this file before selecting it.");
      }
      if (!RESEARCH_READABLE_MEDIA_TYPES.has(row.mediaType.split(";")[0]!.toLowerCase())) throw refuse("RESEARCH_FILE_UNSUPPORTED", "This file type cannot be researched.");
      entries.push({ type: "attachment", key, attachmentId: row.id, conversationId: row.conversationId,
        revision: digest(row.objectKey, row.size, row.conversation.password == null ? null : row.conversation.passwordVersion),
        label: row.name.slice(0, 200) });
    } else if (selection.type === "conversation") {
      const conversation = await prisma.conversation.findFirst({ where: { id: selection.conversationId, userId: input.userId },
        select: { id: true, title: true, password: true, passwordVersion: true } });
      if (!conversation) throw refuse("RESEARCH_SOURCE_UNAVAILABLE", "A selected conversation is unavailable.");
      if (conversation.password != null && !hasConversationUnlockGrant(input.request, input.userId, conversation.id, conversation.passwordVersion)) {
        throw refuse("RESEARCH_CONVERSATION_LOCKED", "Unlock the selected conversation first.");
      }
      const messages = await prisma.message.findMany({ where: { conversationId: conversation.id, role: { in: ["user", "assistant"] } },
        select: { id: true, content: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 2_000 });
      let from = selection.fromMessageId ? messages.findIndex((message) => message.id === selection.fromMessageId) : 0;
      const to = selection.toMessageId ? messages.findIndex((message) => message.id === selection.toMessageId) : messages.length - 1;
      if (from < 0 || to < 0 || to < from) throw refuse("RESEARCH_SOURCE_UNAVAILABLE", "The selected conversation range is unavailable.");
      if (to - from + 1 > 400) from = to - 399;
      const range = messages.slice(from, to + 1);
      if (!range.length) throw refuse("RESEARCH_SOURCE_UNAVAILABLE", "The selected conversation range is empty.");
      const passwordVersion = conversation.password == null ? null : conversation.passwordVersion;
      entries.push({ type: "conversation", key, conversationId: conversation.id, messageIds: range.map((message) => message.id),
        passwordVersion, revision: digest(...range.map((message) => digest(message.id, message.content)), passwordVersion),
        label: (conversation.title ?? "Conversation").slice(0, 200) });
    } else if (selection.type === "memory") {
      if (!(await memoryAllowed(input.userId))) throw refuse("RESEARCH_MEMORY_DISABLED", "Memory is turned off for this account.");
      const item = await prisma.memoryItem.findFirst({ where: { id: selection.memoryItemId, userId: input.userId, status: "active", sensitivity: "standard" },
        select: { id: true, revision: true, statement: true } });
      if (!item) throw refuse("RESEARCH_SOURCE_UNAVAILABLE", "A selected memory is unavailable.");
      entries.push({ type: "memory", key, memoryItemId: item.id, revision: digest(item.id, item.revision),
        label: item.statement.slice(0, 80) });
    } else if (selection.type === "knowledge") {
      const file = await prisma.assistantKnowledgeFile.findFirst({ where: { id: selection.knowledgeFileId, userId: input.userId, processingStatus: "ready" },
        select: { id: true, name: true, digest: true, retrievalVersion: true } });
      if (!file) throw refuse("RESEARCH_SOURCE_UNAVAILABLE", "A selected knowledge file is unavailable.");
      entries.push({ type: "knowledge", key, knowledgeFileId: file.id, revision: digest(file.digest, file.retrievalVersion),
        label: file.name.slice(0, 200) });
    } else if (selection.type === "project") {
      if (!projectAdapter.available()) throw refuse("RESEARCH_PROJECT_UNAVAILABLE", "Project sources are not available yet.");
      const resolved = await projectAdapter.resolve({ userId: input.userId, projectId: selection.projectId, materialId: selection.materialId });
      if (!resolved) throw refuse("RESEARCH_SOURCE_UNAVAILABLE", "A selected project source is unavailable.");
      entries.push({ type: "project", key, projectId: selection.projectId, ...(selection.materialId ? { materialId: selection.materialId } : {}),
        revision: resolved.revision, label: resolved.label.slice(0, 200) });
    }
  }
  return entries;
}

/** True only if the grant recorded at selection still holds right now. */
export async function revalidateResearchPrivateEntry(userId: string, entry: ResearchPrivateManifestEntry): Promise<boolean> {
  switch (entry.type) {
    case "attachment": {
      const row = await prisma.messageAttachment.findFirst({ where: { id: entry.attachmentId, userId, conversationId: entry.conversationId, unavailableAt: null },
        select: { objectKey: true, size: true, conversation: { select: { userId: true, password: true, passwordVersion: true } } } });
      return Boolean(row && row.conversation.userId === userId &&
        digest(row.objectKey, row.size, row.conversation.password == null ? null : row.conversation.passwordVersion) === entry.revision);
    }
    case "conversation": {
      const conversation = await prisma.conversation.findFirst({ where: { id: entry.conversationId, userId },
        select: { password: true, passwordVersion: true } });
      if (!conversation) return false;
      const passwordVersion = conversation.password == null ? null : conversation.passwordVersion;
      if (passwordVersion !== entry.passwordVersion) return false;
      const messages = await prisma.message.findMany({ where: { id: { in: entry.messageIds }, conversationId: entry.conversationId },
        select: { id: true, content: true } });
      if (messages.length !== entry.messageIds.length) return false;
      const byId = new Map(messages.map((message) => [message.id, message]));
      return digest(...entry.messageIds.map((id) => digest(id, byId.get(id)!.content)), passwordVersion) === entry.revision;
    }
    case "memory": {
      if (!(await memoryAllowed(userId))) return false;
      const item = await prisma.memoryItem.findFirst({ where: { id: entry.memoryItemId, userId, status: "active", sensitivity: "standard" },
        select: { id: true, revision: true } });
      return Boolean(item && digest(item.id, item.revision) === entry.revision);
    }
    case "knowledge": {
      const file = await prisma.assistantKnowledgeFile.findFirst({ where: { id: entry.knowledgeFileId, userId, processingStatus: "ready" },
        select: { digest: true, retrievalVersion: true } });
      return Boolean(file && digest(file.digest, file.retrievalVersion) === entry.revision);
    }
    case "project":
      return projectAdapter.available() && projectAdapter.revalidate({ userId, projectId: entry.projectId, materialId: entry.materialId, revision: entry.revision });
  }
}

export type LoadedPrivateText = { text: string; method: string; truncated: boolean } | { unavailable: string };

/** Reads private text for the run's owner only, after re-validation. */
export async function loadResearchPrivateText(userId: string, entry: ResearchPrivateManifestEntry): Promise<LoadedPrivateText> {
  if (!(await revalidateResearchPrivateEntry(userId, entry))) return { unavailable: "revoked" };
  switch (entry.type) {
    case "attachment": {
      const row = await prisma.messageAttachment.findFirstOrThrow({ where: { id: entry.attachmentId, userId }, select: { objectKey: true, mediaType: true } });
      const { readOwnR2ObjectBytes } = await import("@/lib/r2");
      let bytes: Buffer;
      try { bytes = await readOwnR2ObjectBytes(row.objectKey, { maxBytes: RESEARCH_RESOURCE_LIMITS.maxReadBytes }); }
      catch { return { unavailable: "storage_unavailable" }; }
      const extracted = await extractResearchDocument(bytes, row.mediaType);
      return extracted.ok ? { text: extracted.text, method: extracted.method, truncated: extracted.truncated } : { unavailable: extracted.reason };
    }
    case "conversation": {
      const messages = await prisma.message.findMany({ where: { id: { in: entry.messageIds }, conversationId: entry.conversationId, conversation: { userId } },
        select: { id: true, role: true, content: true } });
      const byId = new Map(messages.map((message) => [message.id, message]));
      const text = entry.messageIds.map((id, index) => {
        const message = byId.get(id)!;
        return `[Message ${index + 1}] ${message.role}\n${message.content}`;
      }).join("\n\n");
      const truncated = text.length > RESEARCH_RESOURCE_LIMITS.maxExtractedCharacters;
      return { text: truncated ? text.slice(0, RESEARCH_RESOURCE_LIMITS.maxExtractedCharacters) : text, method: "conversation_messages", truncated };
    }
    case "memory": {
      const item = await prisma.memoryItem.findFirstOrThrow({ where: { id: entry.memoryItemId, userId }, select: { statement: true } });
      return { text: item.statement, method: "memory_item", truncated: false };
    }
    case "knowledge": {
      const chunks = await prisma.assistantKnowledgeChunk.findMany({ where: { fileId: entry.knowledgeFileId, userId },
        orderBy: { ordinal: "asc" }, select: { ordinal: true, content: true } });
      const text = chunks.map((chunk) => `## Part ${chunk.ordinal + 1}\n${chunk.content}`).join("\n\n");
      return { text: text.slice(0, RESEARCH_RESOURCE_LIMITS.maxExtractedCharacters), method: "knowledge_chunks",
        truncated: text.length > RESEARCH_RESOURCE_LIMITS.maxExtractedCharacters };
    }
    case "project": {
      const loaded = await projectAdapter.load({ userId, projectId: entry.projectId, materialId: entry.materialId });
      return loaded ? { text: loaded.text, method: "project_material", truncated: false } : { unavailable: "project_unavailable" };
    }
  }
}

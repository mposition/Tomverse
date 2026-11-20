"use client";

import { createContext, useCallback, useContext, useRef } from "react";
import type { ChatStreamArtifact } from "@/lib/generatedArtifactCore";
import type { ConversationDraft, DraftUpdate } from "@/lib/conversationDraftStore";
import { appendArtifactRevisionDraft, artifactRevisionDraftConflict } from "@/lib/generatedArtifactRevisionDraft";
import { chatAttachmentErrorCopyKey } from "@/lib/chatAttachmentErrorCopy";
import { discardResponseBody } from "@/lib/discardResponseBody";
import type { ChatAttachment } from "@/components/chat/types";

type RevisionAction = (artifact: ChatStreamArtifact) => Promise<string | null>;
export const GeneratedArtifactRevisionContext = createContext<RevisionAction | null>(null);
export const useArtifactRevisionAction = () => useContext(GeneratedArtifactRevisionContext);

export function useGeneratedArtifactRevision(input: {
  enabled: boolean;
  scopeKey: string;
  conversationId: string | null;
  readDraft: (scopeKey: string) => ConversationDraft;
  updateDraft: (update: DraftUpdate<ConversationDraft>, scopeKey: string) => void;
  t: (key: string) => string;
}): RevisionAction | null {
  const operations = useRef(new Map<string, { id: string; pending?: Promise<string | null> }>());
  const { enabled, scopeKey, conversationId, readDraft, updateDraft, t } = input;
  const prepare = useCallback(async (artifact: ChatStreamArtifact): Promise<string | null> => {
    if (!enabled || !conversationId) return t("chat.artifactRevisionFailed");
    const conflictCopy = (conflict: "count" | "name" | "size") => t(conflict === "count"
      ? "chat.attachmentCountError" : conflict === "size"
        ? "chat.attachmentTotalSizeError" : "chat.artifactRevisionNameConflict");
    const conflict = artifactRevisionDraftConflict(readDraft(scopeKey), artifact.filename);
    if (conflict) return conflictCopy(conflict);
    const key = `${scopeKey}\0${artifact.id}`;
    const operation = operations.current.get(key) ?? { id: crypto.randomUUID() };
    if (operation.pending) return operation.pending;
    const pending = (async () => {
      try {
        const response = await fetch("/api/chat", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "generated-artifact-copy", artifactId: artifact.id,
            conversationId, operationId: operation.id }),
        });
        const payload = await response.json().catch(() => null) as {
          uploadId?: string; name?: string; mediaType?: string; size?: number;
          kind?: ChatAttachment["kind"]; code?: string;
          revisionMode?: "workbook" | "workbook-values";
        } | null;
        if (!response.ok) {
          const copy = chatAttachmentErrorCopyKey(payload?.code);
          return response.status === 423 ? t("chat.artifactDownloadLocked")
            : t(copy ?? "chat.artifactRevisionFailed");
        }
        if (!payload?.uploadId || !payload.name || !payload.mediaType ||
            !Number.isFinite(payload.size) || !["text", "file"].includes(payload.kind ?? "")) {
          return t("chat.artifactRevisionFailed");
        }
        const attachment: ChatAttachment = { id: `upload:${payload.uploadId}`,
          uploadId: payload.uploadId, name: payload.name, mediaType: payload.mediaType,
          size: payload.size!, kind: payload.kind! };
        const office = artifact.format === "docx" || artifact.format === "pptx";
        const promptKey = artifact.format === "xlsx"
          ? payload.revisionMode === "workbook-values"
            ? "chat.artifactRevisionWorkbookValuesPrompt" : "chat.artifactRevisionWorkbookPrompt"
          : office ? "chat.artifactRevisionOfficePrompt" : "chat.artifactRevisionPrompt";
        const request = t(promptKey)
          .replaceAll("{filename}", payload.name);
        let appendConflict: "count" | "name" | "size" | null = null;
        updateDraft((current) => {
          const result = appendArtifactRevisionDraft(current, attachment, request);
          appendConflict = result.conflict;
          return result.draft;
        }, scopeKey);
        if (appendConflict) {
          // The user may have filled the last slot while the source was read.
          // Only the unused independent upload is eligible for this cleanup.
          const cleanup = await fetch("/api/chat", { method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uploadId: payload.uploadId }) });
          await discardResponseBody(cleanup);
          operations.current.delete(key);
          return conflictCopy(appendConflict);
        }
        operations.current.delete(key);
        return null;
      } catch {
        // Keep the operation id: a lost response may already have stored it.
        return t("chat.artifactRevisionFailed");
      } finally {
        operation.pending = undefined;
      }
    })();
    operation.pending = pending;
    operations.current.set(key, operation);
    return pending;
  }, [enabled, scopeKey, conversationId, readDraft, updateDraft, t]);
  return enabled && conversationId ? prepare : null;
}

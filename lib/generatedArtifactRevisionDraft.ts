import type { ChatAttachment } from "@/components/chat/types";
import type { ConversationDraft } from "@/lib/conversationDraftStore";

export function artifactRevisionDraftConflict(
  draft: ConversationDraft,
  filename: string
): "count" | "name" | null {
  if (draft.attachments.length >= 5) return "count";
  const name = filename.normalize("NFKC").toLowerCase();
  return draft.attachments.some((item) =>
    item.name.normalize("NFKC").toLowerCase() === name
  ) ? "name" : null;
}

/** The visible request and the independent upload are one ordinary draft edit. */
export function appendArtifactRevisionDraft(
  draft: ConversationDraft,
  attachment: ChatAttachment,
  request: string
): { draft: ConversationDraft; conflict: "count" | "name" | null } {
  if (attachment.uploadId && draft.attachments.some((item) => item.uploadId === attachment.uploadId)) {
    return { draft, conflict: null };
  }
  const conflict = artifactRevisionDraftConflict(draft, attachment.name);
  if (conflict) return { draft, conflict };
  return {
    draft: {
      text: draft.text ? `${request}\n\n${draft.text}` : request,
      attachments: [...draft.attachments, attachment],
    },
    conflict: null,
  };
}

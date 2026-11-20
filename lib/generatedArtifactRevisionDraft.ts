import type { ChatAttachment } from "@/components/chat/types";
import type { ConversationDraft } from "@/lib/conversationDraftStore";
import {
  CHAT_MAX_ATTACHMENTS_PER_MESSAGE,
  CHAT_MAX_TOTAL_ATTACHMENT_BYTES,
} from "@/lib/chatAttachmentLimits";

export function artifactRevisionDraftConflict(
  draft: ConversationDraft,
  filename: string
): "count" | "name" | null {
  if (draft.attachments.length >= CHAT_MAX_ATTACHMENTS_PER_MESSAGE) return "count";
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
): { draft: ConversationDraft; conflict: "count" | "name" | "size" | null } {
  if (attachment.uploadId && draft.attachments.some((item) => item.uploadId === attachment.uploadId)) {
    return { draft, conflict: null };
  }
  const conflict = artifactRevisionDraftConflict(draft, attachment.name);
  if (conflict) return { draft, conflict };
  // The copy is sized only once it exists, so the message total is checked
  // here: the server refuses a message past it (ATTACHMENT_TOTAL_TOO_LARGE).
  const draftBytes = draft.attachments.reduce(
    (sum, item) => sum + (Number.isFinite(item.size) ? item.size : 0),
    0
  );
  if (draftBytes + attachment.size > CHAT_MAX_TOTAL_ATTACHMENT_BYTES) {
    return { draft, conflict: "size" };
  }
  return {
    draft: {
      text: draft.text ? `${request}\n\n${draft.text}` : request,
      attachments: [...draft.attachments, attachment],
    },
    conflict: null,
  };
}

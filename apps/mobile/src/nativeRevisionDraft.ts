import { deviceDraftKey, readDeviceDraft, writeDeviceDraft, type DraftStorage } from "@tomverse/chat-core/device-draft";
import { appendArtifactRevisionDraft, artifactRevisionDraftConflict } from "../../../lib/generatedArtifactRevisionDraft";
import { attachmentKindForFormat, resolveChatAttachmentFormat } from "../../../lib/chatAttachmentFormats";
import type { ChatAttachment } from "../../../components/chat/types";
import type { MobileAttachment } from "./chatTransport";

export type NativeFileUpdate = MobileAttachment[] | ((files: MobileAttachment[]) => MobileAttachment[]);
export type NativeRevisionDraft = { text: string; files: MobileAttachment[] };
const filesKey = (owner: string, conversation: string | null) => `${deviceDraftKey(owner, conversation)}:files`;

export function readNativeDraftFiles(storage: DraftStorage, owner: string, conversation: string | null, now = Date.now()): MobileAttachment[] {
  try {
    const value = JSON.parse(storage.getItem(filesKey(owner, conversation)) ?? "null");
    if (!value || !Array.isArray(value.files) || value.files.length > 10 ||
      typeof value.savedAt !== "number" || value.savedAt > now || now - value.savedAt >= 86_400_000) return [];
    return value.files.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const file = item as Record<string, unknown>;
      if (typeof file.uploadId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(file.uploadId) ||
        typeof file.name !== "string" || !file.name || file.name.length > 255 ||
        typeof file.mediaType !== "string" || file.mediaType.length > 200 ||
        typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 50 * 1024 * 1024) return [];
      return [{ uploadId: file.uploadId, name: file.name, mediaType: file.mediaType, size: file.size }];
    });
  } catch { return []; }
}

export function writeNativeDraftFiles(storage: DraftStorage, owner: string, conversation: string | null, files: MobileAttachment[]) {
  try {
    if (files.length) storage.setItem(filesKey(owner, conversation), JSON.stringify({ files: files.map(({ uploadId, name, mediaType, size }) => ({ uploadId, name, mediaType, size })), savedAt: Date.now() }));
    else storage.removeItem(filesKey(owner, conversation));
  } catch { /* The active draft remains in memory. */ }
}

const asAttachment = (file: MobileAttachment): ChatAttachment => {
  const format = resolveChatAttachmentFormat({ filename: file.name, declaredMediaType: file.mediaType });
  return { ...file, id: `upload:${file.uploadId}`, kind: format ? attachmentKindForFormat(format) : "file" };
};
export const nativeRevisionConflict = (files: MobileAttachment[], name: string) =>
  artifactRevisionDraftConflict({ text: "", attachments: files.map(asAttachment) }, name);

export function appendNativeRevisionDraft(draft: NativeRevisionDraft, file: MobileAttachment, request: string): {
  draft: NativeRevisionDraft; conflict: "count" | "name" | "text" | "size" | null;
} {
  const appended = appendArtifactRevisionDraft({ text: draft.text, attachments: draft.files.map(asAttachment) }, asAttachment(file), request);
  if (appended.conflict) return { draft, conflict: appended.conflict };
  if (appended.draft.text.length > 40_000) return { draft, conflict: "text" };
  if (appended.draft.text === draft.text && appended.draft.attachments.length === draft.files.length) return { draft, conflict: null };
  return { draft: { text: appended.draft.text, files: appended.draft.attachments.map(({ uploadId, name, mediaType, size }) => ({ uploadId: uploadId!, name, mediaType, size })) }, conflict: null };
}

export const readNativeRevisionDraft = (storage: DraftStorage, owner: string, conversation: string | null): NativeRevisionDraft => ({
  text: readDeviceDraft(storage, owner, conversation), files: readNativeDraftFiles(storage, owner, conversation),
});
export function writeNativeRevisionDraft(storage: DraftStorage, owner: string, conversation: string | null, draft: NativeRevisionDraft) {
  writeDeviceDraft(storage, owner, conversation, draft.text);
  writeNativeDraftFiles(storage, owner, conversation, draft.files);
}

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { LanguageProvider, useLanguage } from "@/components/LanguageProvider";
import { Paperclip, X } from "lucide-react";
import { chatAttachmentAcceptAttribute, resolveChatAttachmentFormat } from "../../../../lib/chatAttachmentFormats";
import { CHAT_MAX_ATTACHMENTS_PER_MESSAGE, CHAT_MAX_ATTACHMENT_BYTES, CHAT_MAX_TOTAL_ATTACHMENT_BYTES } from "../../../../lib/chatAttachmentLimits";
import type { Language } from "../../../../lib/language";
import { desktopFilesCopy } from "../../../../locales/desktopFiles";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import type { AttachmentUpload } from "../attachment-contract";
import type { ChatConversation } from "../chat-contract";

type DraftFile = { id: string; name: string; size: number; mediaType: string } &
  ({ file: File; receipt?: AttachmentUpload } | { file?: never; receipt: AttachmentUpload });
type Transfer = { id?: string; cancelled: boolean };
const noFiles: DraftFile[] = [];

type AttachmentNotice = "unsupportedFiles" | "cleanupUnconfirmed" | "uploadUnconfirmed" | "cancelledUpload" | "googleDriveError";

export function useAttachmentDraft(scope: string, enabled: boolean, language: Language, googleDrive = false) {
  const [drafts, setDrafts] = useState<Record<string, DraftFile[]>>({});
  const [notice, setNotice] = useState<AttachmentNotice | null>(null);
  const [uploading, setUploading] = useState(false);
  const transfer = useRef<Transfer | null>(null);
  const hasDrafts = useRef(false);
  const files = drafts[scope] ?? noFiles;

  function cancel() {
    if (!transfer.current) return;
    transfer.current.cancelled = true;
    if (transfer.current.id) void window.desktop.cancelAttachmentUpload(transfer.current.id).catch(() => {});
  }

  useEffect(() => window.desktop.subscribe((snapshot) => {
    if (snapshot.account.stage === "connected") return;
    if (transfer.current) transfer.current.cancelled = true;
    if (!hasDrafts.current) return;
    hasDrafts.current = false;
    setDrafts({});
    setNotice(null);
  }), []);

  function add(incoming: FileList | readonly File[]) {
    if (!enabled || transfer.current) return;
    const next: DraftFile[] = [];
    let total = files.reduce((sum, item) => sum + item.size, 0);
    let rejected = false;
    for (const file of Array.from(incoming)) {
      const format = resolveChatAttachmentFormat({ filename: file.name, declaredMediaType: file.type });
      if (!format || file.name.length > 120 || !file.size || file.size > CHAT_MAX_ATTACHMENT_BYTES ||
          total + file.size > CHAT_MAX_TOTAL_ATTACHMENT_BYTES || files.length + next.length >= CHAT_MAX_ATTACHMENTS_PER_MESSAGE) {
        rejected = true;
        continue;
      }
      total += file.size;
      next.push({ id: crypto.randomUUID(), file, name: file.name, size: file.size, mediaType: format.mediaType });
    }
    setNotice(rejected ? "unsupportedFiles" : null);
    if (next.length) {
      hasDrafts.current = true;
      setDrafts((previous) => ({ ...previous, [scope]: [...(previous[scope] ?? []), ...next] }));
    }
  }

  const remainingSlots = CHAT_MAX_ATTACHMENTS_PER_MESSAGE - files.length;
  const remainingBytes = CHAT_MAX_TOTAL_ATTACHMENT_BYTES - files.reduce((total, file) => total + file.size, 0);

  async function importDrive() {
    if (!enabled || !googleDrive || transfer.current || remainingSlots < 1 || remainingBytes < 1) return;
    const id = crypto.randomUUID();
    const attempt = { id, cancelled: false };
    transfer.current = attempt;
    setUploading(true);
    setNotice(null);
    try {
      const result = await window.desktop.importDriveAttachments({ requestId: id, slots: remainingSlots, remainingBytes });
      if (attempt.cancelled) {
        await Promise.allSettled(result.files.map(({ uploadId }) => window.desktop.discardAttachment(uploadId)));
        return;
      }
      if (result.files.length) {
        hasDrafts.current = true;
        const next = result.files.map((receipt) => ({
          id: crypto.randomUUID(), name: receipt.name, size: receipt.size, mediaType: receipt.mediaType, receipt,
        }));
        setDrafts((previous) => ({ ...previous, [scope]: [...(previous[scope] ?? []), ...next] }));
      }
      if (result.incomplete) setNotice("googleDriveError");
    } catch {
      if (!attempt.cancelled) setNotice("googleDriveError");
    } finally {
      if (transfer.current === attempt) transfer.current = null;
      setUploading(false);
    }
  }

  async function remove(item: DraftFile) {
    if (uploading) return;
    setDrafts((previous) => ({ ...previous, [scope]: (previous[scope] ?? []).filter(({ id }) => id !== item.id) }));
    setNotice(null);
    if (item.receipt) {
      try { await window.desktop.discardAttachment(item.receipt.uploadId); }
      catch { setNotice("cleanupUnconfirmed"); }
    }
  }

  async function prepare() {
    if (!files.length) return [];
    if (!enabled || transfer.current) return null;
    const attempt: Transfer = { cancelled: false };
    transfer.current = attempt;
    setUploading(true);
    setNotice(null);
    const ids: string[] = [];
    try {
      for (const item of files) {
        if (attempt.cancelled) return null;
        if (item.receipt) { ids.push(item.receipt.uploadId); continue; }
        if (!item.file) return null;
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        if (attempt.cancelled) return null;
        attempt.id = item.id;
        const receipt = await window.desktop.uploadAttachment({
          requestId: item.id, name: item.name, mediaType: item.mediaType, bytes,
        });
        if (attempt.cancelled) {
          await window.desktop.discardAttachment(receipt.uploadId).catch(() => {});
          return null;
        }
        ids.push(receipt.uploadId);
        setDrafts((previous) => ({ ...previous, [scope]: (previous[scope] ?? []).map((file) =>
          file.id === item.id ? { ...file, receipt } : file) }));
      }
      return ids;
    } catch {
      if (!attempt.cancelled) setNotice("uploadUnconfirmed");
      return null;
    } finally {
      if (attempt.cancelled && hasDrafts.current) setNotice("cancelledUpload");
      if (transfer.current === attempt) transfer.current = null;
      setUploading(false);
    }
  }

  return {
    enabled, files, language, notice, uploading, add, remove, prepare, cancel,
    googleDrive: enabled && googleDrive, importDrive, driveFull: remainingSlots < 1 || remainingBytes < 1,
    clear: () => setDrafts((previous) => ({ ...previous, [scope]: [] })),
    onDrop(event: DragEvent) {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      add(event.dataTransfer.files);
    },
    onDragOver(event: DragEvent) {
      if (event.dataTransfer.types.includes("Files")) event.preventDefault();
    },
    onPaste(event: ClipboardEvent) {
      if (!event.clipboardData.files.length) return;
      event.preventDefault();
      add(event.clipboardData.files);
    },
  };
}

export type DesktopAttachmentDraft = ReturnType<typeof useAttachmentDraft>;

export function AttachmentPicker({ draft, busy = false, id, tool = false }: { draft: DesktopAttachmentDraft; busy?: boolean; id?: string; tool?: boolean }) {
  const picker = useRef<HTMLInputElement>(null);
  if (!draft.enabled) return null;
  return <>
    <input id={id} type="file" hidden ref={picker} multiple accept={chatAttachmentAcceptAttribute()}
      onChange={(event) => {
        if (event.currentTarget.files) draft.add(event.currentTarget.files);
        event.currentTarget.value = "";
      }} />
    <button className={tool ? "composer-tool-row" : "icon"} type="button" disabled={busy || draft.uploading}
      {...(tool ? { "aria-labelledby": "tools-attach-label", "aria-describedby": draft.googleDrive ? "tools-attach-description" : undefined }
        : { "aria-label": desktopShellCopy[draft.language].attachFiles })}
      onClick={(event) => {
        picker.current?.click();
        const menu = event.currentTarget.closest("details");
        if (menu && tool) menu.open = false;
      }}>{tool ? <><span className="composer-tool-icon"><Paperclip size={18} /></span>
        <ToolAttachLabel drive={draft.googleDrive} /></> : <Paperclip size={17} />}</button>
  </>;
}

/** The "+" menu row text, worded as on the web: the title, and where a file can come from. */
function ToolAttachLabel({ drive }: { drive: boolean }) {
  const { t } = useLanguage();
  return <span><strong id="tools-attach-label">{t("chat.attachFile")}</strong>
    {drive && <small id="tools-attach-description">{t("chat.attachSourceSubtitle")}</small>}</span>;
}

export function AttachmentDraftStatus({ draft, busy = false }: { draft: DesktopAttachmentDraft; busy?: boolean }) {
  const copy = desktopFilesCopy[draft.language];
  const { removeReference } = desktopShellCopy[draft.language];
  return <>
    {draft.files.length > 0 && <ul className="attachment-draft" aria-label={copy.filesToAttach}>
      {draft.files.map((item) => <li key={item.id}><span>{item.name}</span>
        <button className="icon" type="button" disabled={busy || draft.uploading} aria-label={removeReference.replace("{path}", () => item.name)}
          onClick={() => void draft.remove(item)}><X size={14} /></button>
      </li>)}
    </ul>}
    {draft.uploading && <div className="attachment-progress">
      <p role="status">{copy.uploading}</p><button className="soft" type="button" onClick={draft.cancel}>{copy.cancelUpload}</button>
    </div>}
    {draft.notice && <p className="notice" role="status">{draft.notice === "googleDriveError" ?
      <LanguageProvider initialLang={draft.language} forceInitialLang><GoogleDriveError /></LanguageProvider> : copy[draft.notice]}</p>}
  </>;
}

function GoogleDriveError() {
  const { t } = useLanguage();
  return <>{t("chat.googleDriveError")}</>;
}

export function SavedAttachments({ message, language }: { message: ChatConversation["messages"][number]; language: Language }) {
  if (!message.attachments?.length) return null;
  const copy = desktopFilesCopy[language];
  return <ul className="saved-attachments" aria-label={copy.attachedFiles}>
    {message.attachments.map((item) => <li key={item.id}><Paperclip size={14} />
      <span>{item.name}{item.unavailableAt && ` · ${copy.unavailable}`}</span>
    </li>)}
  </ul>;
}

import type { ResearchPreviewControls } from "../../../components/chat/useResearchPreview";
import { researchPreviewCopy } from "../../../locales/researchPreview";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useVoiceRecorder, isVoiceRecorderBusy } from "../../../components/chat/useVoiceRecorder";
import type { mobileCopy } from "../../../locales/mobile";
import type { ChatTransport, Conversation, MobileAttachment } from "./chatTransport";
import { AppIcon } from "./AppIcon";
import { chatAttachmentAcceptAttribute } from "../../../lib/chatAttachmentFormats";
import { mobileErrorText } from "../../../locales/mobileErrors";
import type { MobileLanguage } from "../../../locales/mobile";
import { mobileParityCopy } from "../../../locales/mobileParity";
import { mobileVoiceError, mobileVoiceCopy, mobileVoicePrivacy } from "../../../locales/mobileVoice";
import { ComposerTools, type ToolChange, type ComposerAction } from "./ComposerTools";
import { WorkspaceNavigation, type MobileProduct } from "./WorkspaceNavigation";
import { useCompactBottomDock, useVisibleViewportHeight } from "../../../components/chat/useVisualViewport";
import { mobileComposerCopy } from "../../../locales/mobileComposer";
import { UploadProgressDialog, type UploadProgress } from "./UploadProgressDialog";
import type { NativeFileUpdate } from "./nativeRevisionDraft";
import { mobileArtifactRevisionCopy } from "../../../locales/mobileArtifactRevision";
import { mobileUploadCopy } from "../../../locales/mobileUpload";
import {
  CHAT_MAX_ATTACHMENTS_PER_MESSAGE,
  CHAT_MAX_ATTACHMENT_BYTES,
  CHAT_MAX_TOTAL_ATTACHMENT_BYTES,
} from "../../../lib/chatAttachmentLimits";

type Props = {
  researchPreview?: ResearchPreviewControls;
  locationIdentity?: string | null;
  files?: MobileAttachment[]; onFilesChange?: (update: NativeFileUpdate) => void; onRemoveFile?: (file: MobileAttachment) => void;
  onFileUploaded?: (file: MobileAttachment) => "added" | "count" | "name" | "stale";
  voiceConversation?: (disabled: boolean) => ReactNode;
  copy: typeof mobileCopy.en; transport: ChatTransport; draft: string; setDraft: (text: string) => void;
  language: MobileLanguage;
  conversation?: Conversation | null; onConfigureTools?: (input: ToolChange) => Promise<void>;
  extraTools?: ComposerAction[];
  inputMaxLength?: number;
  product?: MobileProduct; onProductChange?: (product: MobileProduct) => void;
  productBusy?: boolean; productLoading?: boolean; selectionControl?: ReactNode;
  offline?: boolean; disabled: boolean; streaming: boolean; onSend: (text: string, files: MobileAttachment[]) => Promise<void | boolean>; onStop: () => void;
};
export function Composer({ researchPreview, locationIdentity = null, files: controlledFiles, onFilesChange, onRemoveFile, onFileUploaded, copy, language, transport, draft, setDraft, disabled, offline = false, streaming, onSend, onStop, conversation, onConfigureTools, extraTools, inputMaxLength = 40000, voiceConversation, product = "chat", onProductChange, productBusy, productLoading, selectionControl }: Props) {
  const shortViewport = useCompactBottomDock();
  const visibleHeight = useVisibleViewportHeight();
  const compact = shortViewport || (visibleHeight > 0 && visibleHeight < 640);
  const [localFiles, setLocalFiles] = useState<MobileAttachment[]>([]);
  const files = controlledFiles ?? localFiles;
  const setFiles = onFilesChange ?? setLocalFiles;
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const uploading = upload !== null;
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const [tools, setTools] = useState(false);
  const parityCopy = mobileParityCopy(language);
  const researchCopy = researchPreviewCopy[language];
  const researchBlocked = Boolean(researchPreview?.selected && (!researchPreview.offered || files.length || uploading || !draft.trim() || draft.trim().length > 4000));
  const input = useRef<HTMLTextAreaElement>(null);
  const voiceCopy = mobileVoiceCopy(language);
  useEffect(() => { const node = input.current; if (node) { node.style.height = "0px"; node.style.height = `${Math.min(120, Math.max(44, node.scrollHeight))}px`; } }, [draft]);
  const composing = useRef(false);
  const [previousConversation, setPreviousConversation] = useState(conversation?.id);
  if (previousConversation !== conversation?.id) {
    setPreviousConversation(conversation?.id);
    if (previousConversation) { if (!onFilesChange) setLocalFiles([]); setError(""); setTools(false); }
  }
  const voice = useVoiceRecorder({
    scopeId: `mobile-composer:${conversation?.id ?? "new"}`,
    onTranscript: (text) => setDraft(draft ? `${draft}\n${text}` : text),
    fetchImpl: async (_input, init) => {
      try { const transcript = await transport.transcribe(init?.body as Blob, init?.signal ?? undefined); return Response.json({ transcript }); }
      catch (error) {
        const refusal = error as { status?: number; code?: string };
        if (refusal.status && refusal.status >= 400 && refusal.status <= 599) return Response.json({ code: refusal.code ?? "VOICE_TRANSCRIPTION_FAILED" }, { status: refusal.status });
        throw error;
      }
    },
  });
  const voiceBusy = isVoiceRecorderBusy(voice.state);
  async function attach(selected: FileList | null) {
    if (disabled || offline || streaming || uploading || !selected?.length) return;
    if (files.length + selected.length > CHAT_MAX_ATTACHMENTS_PER_MESSAGE) { setError(copy.fileLimit); return; }
    const pending = Array.from(selected);
    // The server's per-file and per-message byte limits, checked before any
    // upload so a file it would refuse is never read into memory.
    const attachedBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
    if (pending.some((file) => file.size > CHAT_MAX_ATTACHMENT_BYTES) ||
        pending.reduce((sum, file) => sum + file.size, attachedBytes) > CHAT_MAX_TOTAL_ATTACHMENT_BYTES) {
      setError(mobileUploadCopy[language].sizeLimit); return;
    }
    setUpload({ file: pending[0], completed: 0, total: pending.length }); setError("");
    try {
      for (const [completed, file] of pending.entries()) {
        setUpload({ file, completed, total: pending.length });
        const uploaded = await transport.upload(file);
        const added = onFileUploaded?.(uploaded);
        if (added === "stale") break;
        if (added === "count" || added === "name") {
          void transport.discardAttachment?.(uploaded.uploadId).catch(() => {});
          setError(added === "name" ? mobileArtifactRevisionCopy(language).nameConflict : copy.fileLimit); break;
        }
        if (!onFileUploaded) setFiles((previous) => [...previous, uploaded]);
      }
    } catch (error) { setError(mobileErrorText(error, language, parityCopy.uploadFailed)); }
    finally { setUpload(null); if (picker.current) picker.current.value = ""; if (photos.current) photos.current.value = ""; }
  }
  function submit() {
    if (researchBlocked || disabled || offline || streaming || uploading || voiceBusy || composing.current || (!draft.trim() && files.length === 0)) return;
    const sent = new Set(files.map(file => file.uploadId));
    void onSend(draft, files).then(result => { if (result !== false) setFiles(current => current.filter(file => !sent.has(file.uploadId))); });
  }
  return <div className="composer-area" data-compact={compact || undefined}>
    {onProductChange && !compact && <WorkspaceNavigation product={product} language={language} disabled={productBusy || streaming || uploading || voiceBusy} loading={productLoading} onChange={onProductChange} />}
    {researchPreview?.selected && <div className="research-run-card" data-testid="native-research-preview-notice">
      <strong>{researchCopy.researchPreviewTitle} · {conversation?.selectedModels[0] ?? researchPreview.modelId ?? ""}</strong>
      <p className="research-preview-question">{draft}</p>
      <details><summary>{researchCopy.researchPreviewDescription}</summary><p>{researchPreview.features?.pageReading ? researchCopy.researchPreviewScopeWithPages : researchCopy.researchPreviewScope}</p>{researchPreview.features?.pageReading && <p>{researchCopy.researchPreviewPageLimits}</p>}{researchPreview.features?.durableRuns && <p>{researchCopy.researchPreviewRunLimits}</p>}</details>
      {researchPreview.estimatedCredits !== undefined && <p>{researchCopy.researchPreviewEstimate.replace("{credits}", String(researchPreview.estimatedCredits))}</p>}
      {researchPreview.features?.durableRuns && <p>{researchCopy.researchPreviewDurableHint}</p>}
      {researchBlocked && <p role="status">{files.length ? researchCopy.researchPreviewAttachments : !draft.trim() || draft.trim().length > 4000 ? researchCopy.researchPreviewQuestionLimit : researchPreview.pending ? researchCopy.researchPreviewChecking : researchCopy.researchPreviewUnavailable}</p>}
      <button type="button" onClick={() => researchPreview.onSelectedChange(false)}>{researchCopy.researchPreviewClear}</button>
    </div>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {voice.state.status === "error" && <p role="alert" className="notice error">{mobileVoiceError(language, voice.state.code, voice.serverCode)}<button onClick={voice.dismissError}>×</button></p>}
    {files.length > 0 && <ul className="attachments">{files.map((file) => <li key={file.uploadId}>{file.name}<button aria-label={`${copy.remove}: ${file.name}`} onClick={() => onRemoveFile ? onRemoveFile(file) : setFiles((items) => items.filter((item) => item.uploadId !== file.uploadId))}>×</button></li>)}</ul>}
    <input data-testid="file-picker" ref={picker} type="file" multiple hidden accept={chatAttachmentAcceptAttribute({})} onChange={event => void attach(event.target.files)} />
    <input data-testid="photo-picker" ref={photos} type="file" multiple hidden accept="image/*" onChange={event => void attach(event.target.files)} />
    <form className={`composer compact-composer${voiceBusy ? " is-recording" : ""}`} onSubmit={event => { event.preventDefault(); submit(); }}>
      <textarea ref={input} maxLength={inputMaxLength} aria-label={copy.placeholder} placeholder={copy.placeholder} rows={1} value={draft} disabled={disabled || streaming || voiceBusy}
        onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
      <div className="composer-toolbar">
      <div className="composer-tool-controls">
        <button className="composer-add" type="button" aria-label={copy.attach} aria-expanded={tools} disabled={disabled || offline || streaming || uploading || voiceBusy} onClick={() => setTools(true)}><AppIcon name="attach" /><span>{mobileComposerCopy[language].tools}</span></button>
        {selectionControl}
      </div>
      <div className="composer-actions">
        {voiceBusy ? <><span className="voice-clock" role="status">{voice.state.status === "transcribing" ? voiceCopy.transcribing : `${voiceCopy.recording} ${voice.elapsedSeconds}s`}</span><button type="button" onClick={voice.cancel} aria-label={copy.cancelVoice}>×</button></> : <button type="button" aria-label={copy.voice} disabled={disabled || offline || streaming || uploading} onClick={voice.start}><AppIcon name="mic" /></button>}
        <div className="composer-primary-action" data-voice-default={!draft.trim() && !files.length && !streaming && !voiceBusy}>
          {voiceConversation?.(disabled || offline || streaming || uploading || voiceBusy || !!draft.trim() || files.length > 0)}
          {voiceBusy ? <button type="button" className="send" onClick={voice.stop} disabled={voice.state.status !== "recording"} aria-label={copy.finishVoice}>■</button> : streaming ? <button type="button" className="send" aria-label={copy.stop} onClick={onStop}>■</button> : <button type="submit" className="send" aria-label={copy.send} disabled={researchBlocked || disabled || offline || uploading || (!draft.trim() && !files.length)}><AppIcon name="send" /></button>}
        </div>
      </div>
      </div>
    </form>
    {voiceBusy && <p className="voice-privacy">{mobileVoicePrivacy(language)}</p>}
    {!voiceBusy && voice.elapsedSeconds > 0 && draft && <p className="composer-progress">{copy.voiceReview}</p>}
    {upload && <UploadProgressDialog progress={upload} language={language} />}
    {tools && <ComposerTools researchPreview={researchPreview} researchAttachments={files.length > 0 || uploading} locationIdentity={locationIdentity} extraTools={extraTools} transport={transport} language={language} conversation={conversation} onChange={onConfigureTools} onClose={() => setTools(false)} onFiles={() => { setTools(false); picker.current?.click(); }} onPhotos={() => { setTools(false); photos.current?.click(); }} />}
  </div>;
}

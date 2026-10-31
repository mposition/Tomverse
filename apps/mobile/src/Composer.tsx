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

type Props = {
  locationIdentity?: string | null;
  voiceConversation?: (disabled: boolean) => ReactNode;
  copy: typeof mobileCopy.en; transport: ChatTransport; draft: string; setDraft: (text: string) => void;
  language: MobileLanguage;
  conversation?: Conversation | null; onConfigureTools?: (input: ToolChange) => Promise<void>;
  extraTools?: ComposerAction[];
  product?: MobileProduct; onProductChange?: (product: MobileProduct) => void;
  productBusy?: boolean; productLoading?: boolean; selectionControl?: ReactNode;
  offline?: boolean; disabled: boolean; streaming: boolean; onSend: (text: string, files: MobileAttachment[]) => Promise<void | boolean>; onStop: () => void;
};
export function Composer({ locationIdentity = null, copy, language, transport, draft, setDraft, disabled, offline = false, streaming, onSend, onStop, conversation, onConfigureTools, extraTools, voiceConversation, product = "chat", onProductChange, productBusy, productLoading, selectionControl }: Props) {
  const shortViewport = useCompactBottomDock();
  const visibleHeight = useVisibleViewportHeight();
  const compact = shortViewport || (visibleHeight > 0 && visibleHeight < 640);
  const [files, setFiles] = useState<MobileAttachment[]>([]);
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const uploading = upload !== null;
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const [tools, setTools] = useState(false);
  const parityCopy = mobileParityCopy(language);
  const input = useRef<HTMLTextAreaElement>(null);
  const voiceCopy = mobileVoiceCopy(language);
  useEffect(() => { const node = input.current; if (node) { node.style.height = "0px"; node.style.height = `${Math.min(120, Math.max(44, node.scrollHeight))}px`; } }, [draft]);
  const composing = useRef(false);
  const previousConversation = useRef(conversation?.id);
  useEffect(() => {
    if (previousConversation.current && previousConversation.current !== conversation?.id) { setFiles([]); setError(""); setTools(false); }
    previousConversation.current = conversation?.id;
  }, [conversation?.id]);
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
    if (files.length + selected.length > 5) { setError(copy.fileLimit); return; }
    const pending = Array.from(selected);
    setUpload({ file: pending[0], completed: 0, total: pending.length }); setError("");
    try {
      for (const [completed, file] of pending.entries()) {
        setUpload({ file, completed, total: pending.length });
        const uploaded = await transport.upload(file);
        setFiles((previous) => [...previous, uploaded]);
      }
    } catch (error) { setError(mobileErrorText(error, language, parityCopy.uploadFailed)); }
    finally { setUpload(null); if (picker.current) picker.current.value = ""; if (photos.current) photos.current.value = ""; }
  }
  function submit() {
    if (disabled || offline || streaming || uploading || voiceBusy || composing.current || (!draft.trim() && files.length === 0)) return;
    void onSend(draft, files).then(result => { if (result !== false) setFiles([]); });
  }
  return <div className="composer-area" data-compact={compact || undefined}>
    {onProductChange && !compact && <WorkspaceNavigation product={product} language={language} disabled={productBusy || streaming || uploading || voiceBusy} loading={productLoading} onChange={onProductChange} />}
    {error && <p role="alert" className="notice error">{error}</p>}
    {voice.state.status === "error" && <p role="alert" className="notice error">{mobileVoiceError(language, voice.state.code, voice.serverCode)}<button onClick={voice.dismissError}>×</button></p>}
    {files.length > 0 && <ul className="attachments">{files.map((file) => <li key={file.uploadId}>{file.name}<button aria-label={`${copy.remove}: ${file.name}`} onClick={() => setFiles((items) => items.filter((item) => item.uploadId !== file.uploadId))}>×</button></li>)}</ul>}
    <input data-testid="file-picker" ref={picker} type="file" multiple hidden accept={chatAttachmentAcceptAttribute({})} onChange={event => void attach(event.target.files)} />
    <input data-testid="photo-picker" ref={photos} type="file" multiple hidden accept="image/*" onChange={event => void attach(event.target.files)} />
    <form className={`composer compact-composer${voiceBusy ? " is-recording" : ""}`} onSubmit={event => { event.preventDefault(); submit(); }}>
      <textarea ref={input} maxLength={40000} aria-label={copy.placeholder} placeholder={copy.placeholder} rows={1} value={draft} disabled={disabled || streaming || voiceBusy}
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
          {voiceBusy ? <button type="button" className="send" onClick={voice.stop} disabled={voice.state.status !== "recording"} aria-label={copy.finishVoice}>■</button> : streaming ? <button type="button" className="send" aria-label={copy.stop} onClick={onStop}>■</button> : <button type="submit" className="send" aria-label={copy.send} disabled={disabled || offline || uploading || (!draft.trim() && !files.length)}><AppIcon name="send" /></button>}
        </div>
      </div>
      </div>
    </form>
    {voiceBusy && <p className="voice-privacy">{mobileVoicePrivacy(language)}</p>}
    {!voiceBusy && voice.elapsedSeconds > 0 && draft && <p className="composer-progress">{copy.voiceReview}</p>}
    {upload && <UploadProgressDialog progress={upload} language={language} />}
    {tools && <ComposerTools locationIdentity={locationIdentity} extraTools={extraTools} transport={transport} language={language} conversation={conversation} onChange={onConfigureTools} onClose={() => setTools(false)} onFiles={() => { setTools(false); picker.current?.click(); }} onPhotos={() => { setTools(false); photos.current?.click(); }} />}
  </div>;
}

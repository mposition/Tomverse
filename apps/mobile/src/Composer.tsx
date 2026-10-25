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
import { NativeLocationControl } from "./NativeLocationControl";
import { ComposerTools, type ToolChange, type ComposerAction } from "./ComposerTools";

type Props = {
  locationIdentity?: string | null;
  voiceConversation?: (disabled: boolean) => ReactNode;
  copy: typeof mobileCopy.en; transport: ChatTransport; draft: string; setDraft: (text: string) => void;
  language: MobileLanguage;
  conversation?: Conversation | null; onConfigureTools?: (input: ToolChange) => Promise<void>;
  extraTools?: ComposerAction[];
  offline?: boolean; disabled: boolean; streaming: boolean; onSend: (text: string, files: MobileAttachment[]) => Promise<void | boolean>; onStop: () => void;
};
export function Composer({ locationIdentity = null, copy, language, transport, draft, setDraft, disabled, offline = false, streaming, onSend, onStop, conversation, onConfigureTools, extraTools, voiceConversation }: Props) {
  const [files, setFiles] = useState<MobileAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const [tools, setTools] = useState(false);
  const parityCopy = mobileParityCopy(language);
  const input = useRef<HTMLTextAreaElement>(null);
  const voiceCopy = mobileVoiceCopy(language);
  useEffect(() => { const node = input.current; if (node) { node.style.height = "0px"; node.style.height = `${Math.min(120, Math.max(40, node.scrollHeight))}px`; } }, [draft]);
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
    if (disabled || offline || streaming || !selected?.length) return;
    if (files.length + selected.length > 5) { setError(copy.fileLimit); return; }
    setUploading(true); setError("");
    try {
      for (const file of Array.from(selected)) {
        const uploaded = await transport.upload(file);
        setFiles((previous) => [...previous, uploaded]);
      }
    } catch (error) { setError(mobileErrorText(error, language, parityCopy.uploadFailed)); }
    finally { setUploading(false); if (picker.current) picker.current.value = ""; if (photos.current) photos.current.value = ""; }
  }
  function submit() {
    if (disabled || offline || streaming || uploading || voiceBusy || composing.current || (!draft.trim() && files.length === 0)) return;
    void onSend(draft, files).then(result => { if (result !== false) setFiles([]); });
  }
  return <div className="composer-area">
    {transport.location && <NativeLocationControl session={transport.location} identity={locationIdentity} language={language} compact />}
    {error && <p role="alert" className="notice error">{error}</p>}
    {voice.state.status === "error" && <p role="alert" className="notice error">{mobileVoiceError(language, voice.state.code, voice.serverCode)}<button onClick={voice.dismissError}>×</button></p>}
    {files.length > 0 && <ul className="attachments">{files.map((file) => <li key={file.uploadId}>{file.name}<button aria-label={`${copy.remove}: ${file.name}`} onClick={() => setFiles((items) => items.filter((item) => item.uploadId !== file.uploadId))}>×</button></li>)}</ul>}
    <input data-testid="file-picker" ref={picker} type="file" multiple hidden accept={chatAttachmentAcceptAttribute({})} onChange={event => void attach(event.target.files)} />
    <input data-testid="photo-picker" ref={photos} type="file" multiple hidden accept="image/*" onChange={event => void attach(event.target.files)} />
    <form className={`composer compact-composer${voiceBusy ? " is-recording" : ""}`} onSubmit={event => { event.preventDefault(); submit(); }}>
      <button className="composer-add" type="button" aria-label={copy.attach} aria-expanded={tools} disabled={disabled || offline || streaming || uploading || voiceBusy} onClick={() => setTools(true)}><AppIcon name="attach" /></button>
      <textarea ref={input} maxLength={40000} aria-label={copy.placeholder} placeholder={copy.placeholder} rows={1} value={draft} disabled={disabled || streaming || voiceBusy}
        onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
      <div className="composer-actions">
        {voiceBusy ? <><span className="voice-clock" role="status">{voice.state.status === "transcribing" ? voiceCopy.transcribing : `${voiceCopy.recording} ${voice.elapsedSeconds}s`}</span><button type="button" onClick={voice.cancel} aria-label={copy.cancelVoice}>×</button></> : <button type="button" aria-label={copy.voice} disabled={disabled || offline || streaming || uploading} onClick={voice.start}><AppIcon name="mic" /></button>}
        <div className="composer-primary-action" data-voice-default={!draft.trim() && !files.length && !streaming && !voiceBusy}>
          {voiceConversation?.(disabled || offline || streaming || uploading || voiceBusy || !!draft.trim() || files.length > 0)}
          {voiceBusy ? <button type="button" className="send" onClick={voice.stop} disabled={voice.state.status !== "recording"} aria-label={copy.finishVoice}>■</button> : streaming ? <button type="button" className="send" aria-label={copy.stop} onClick={onStop}>■</button> : <button type="submit" className="send" aria-label={copy.send} disabled={disabled || offline || uploading || (!draft.trim() && !files.length)}><AppIcon name="send" /></button>}
        </div>
      </div>
    </form>
    {voiceBusy && <p className="voice-privacy">{mobileVoicePrivacy(language)}</p>}
    {!voiceBusy && voice.elapsedSeconds > 0 && draft && <p className="composer-progress">{copy.voiceReview}</p>}
    {uploading && <p role="status" className="composer-progress">{copy.loading}</p>}
    {tools && <ComposerTools locationIdentity={locationIdentity} extraTools={extraTools} transport={transport} language={language} conversation={conversation} onChange={onConfigureTools} onClose={() => setTools(false)} onFiles={() => { setTools(false); picker.current?.click(); }} onPhotos={() => { setTools(false); photos.current?.click(); }} />}
  </div>;
}

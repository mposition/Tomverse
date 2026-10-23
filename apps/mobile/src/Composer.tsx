import { useEffect, useRef, useState } from "react";
import { useVoiceRecorder, isVoiceRecorderBusy } from "../../../components/chat/useVoiceRecorder";
import type { mobileCopy } from "../../../locales/mobile";
import type { ChatTransport, Conversation, MobileAttachment } from "./chatTransport";
import { AppIcon } from "./AppIcon";
import { chatAttachmentAcceptAttribute } from "../../../lib/chatAttachmentFormats";
import { mobileErrorText } from "../../../locales/mobileErrors";
import type { MobileLanguage } from "../../../locales/mobile";
import { mobileParityCopy } from "../../../locales/mobileParity";
import { ComposerTools, type ToolChange } from "./ComposerTools";

type Props = {
  copy: typeof mobileCopy.en; transport: ChatTransport; draft: string; setDraft: (text: string) => void;
  language: MobileLanguage;
  conversation?: Conversation | null; onConfigureTools?: (input: ToolChange) => Promise<void>;
  offline?: boolean; disabled: boolean; streaming: boolean; onSend: (text: string, files: MobileAttachment[]) => Promise<void>; onStop: () => void;
};
export function Composer({ copy, language, transport, draft, setDraft, disabled, offline = false, streaming, onSend, onStop, conversation, onConfigureTools }: Props) {
  const [files, setFiles] = useState<MobileAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const [tools, setTools] = useState(false);
  const parityCopy = mobileParityCopy(language);
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
      const transcript = await transport.transcribe(init?.body as Blob, init?.signal ?? undefined);
      return Response.json({ transcript });
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
    void onSend(draft, files); setFiles([]);
  }
  return <div className="composer-area">
    {error && <p role="alert" className="notice error">{error}</p>}
    {voice.state.status === "error" && <p role="alert" className="notice error">{copy.microphone}<button onClick={voice.dismissError}>×</button></p>}
    {files.length > 0 && <ul className="attachments">{files.map((file) => <li key={file.uploadId}>{file.name}<button aria-label={`${copy.remove}: ${file.name}`} onClick={() => setFiles((items) => items.filter((item) => item.uploadId !== file.uploadId))}>×</button></li>)}</ul>}
    <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <textarea maxLength={40000} aria-label={copy.placeholder} placeholder={copy.placeholder} rows={2} value={draft} disabled={disabled || streaming || voiceBusy}
        onChange={(event) => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); submit(); } }} />
      <div className="composer-actions"><div className="input-tools">
        <input data-testid="file-picker" ref={picker} type="file" multiple hidden accept={chatAttachmentAcceptAttribute({})} onChange={(event) => void attach(event.target.files)} />
        <input data-testid="photo-picker" ref={photos} type="file" multiple hidden accept="image/*" onChange={(event) => void attach(event.target.files)} />
        <button type="button" aria-label={copy.attach} aria-expanded={tools} disabled={disabled || offline || streaming || uploading || voiceBusy} onClick={() => setTools(true)}><AppIcon name="attach" /></button>
        {voiceBusy ? <><button type="button" onClick={voice.stop} disabled={voice.state.status !== "recording"} aria-label={copy.finishVoice}>■ {voice.elapsedSeconds}s</button><button type="button" onClick={voice.cancel} aria-label={copy.cancelVoice}>×</button></> : <button type="button" aria-label={copy.voice} disabled={disabled || offline || streaming || uploading} onClick={voice.start}><AppIcon name="mic" /></button>}
        {uploading && <span role="status">{copy.loading}</span>}
      </div>{streaming ? <button type="button" className="send" aria-label={copy.stop} onClick={onStop}>■</button> : <button type="submit" className="send" aria-label={copy.send} disabled={disabled || offline || uploading || voiceBusy || (!draft.trim() && !files.length)}><AppIcon name="send" /></button>}</div>
    </form><p className="composer-footnote">{copy.voiceReview}</p>
    {tools && <ComposerTools transport={transport} language={language} conversation={conversation} onChange={onConfigureTools} onClose={() => setTools(false)} onFiles={() => { setTools(false); picker.current?.click(); }} onPhotos={() => { setTools(false); photos.current?.click(); }} />}
  </div>;
}

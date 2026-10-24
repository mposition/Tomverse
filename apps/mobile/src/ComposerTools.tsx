import { useEffect, useState } from "react";
import { Sheet } from "./Sheet";
import type { AssistantSummary, ChatTransport, Conversation } from "./chatTransport";
import type { MobileLanguage } from "../../../locales/mobile";
import { mobileCopy } from "../../../locales/mobile";
import { mobileParityCopy } from "../../../locales/mobileParity";

export type ComposerAction = { label: string; disabled?: boolean; onSelect: () => void };
export type ToolChange = { webSearchMode?: "off" | "always"; memoryMode?: "inherit" | "on" | "off"; assistantProfileId?: string | null };
export function ComposerTools({ transport, language, conversation, onChange, onFiles, onPhotos, onClose, extraTools }: {
  transport: ChatTransport; language: MobileLanguage; conversation?: Conversation | null;
  extraTools?: ComposerAction[];
  onChange?: (input: ToolChange) => Promise<void>; onFiles: () => void; onPhotos: () => void; onClose: () => void;
}) {
  const c = mobileParityCopy(language);
  const [profiles, setProfiles] = useState<AssistantSummary[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void transport.mobileCapabilities?.().then(async capability => {
      if (capability.assistants && transport.assistants) { const rows = await transport.assistants(); if (active) setProfiles(rows); }
    }).catch(() => { /* Account features are unavailable until their server activation. Core attachments remain usable. */ });
    return () => { active = false; };
  }, [transport]);
  async function change(input: ToolChange) {
    if (!onChange || busy) return;
    setBusy(true); setError("");
    try { await onChange(input); } catch { setError(c.unavailable); }
    finally { setBusy(false); }
  }
  return <Sheet title={c.tools} closeLabel={mobileCopy[language].close} onClose={() => { if (!busy) onClose(); }}>
    <div className="composer-tools">
      <div className="file-sources"><button onClick={onPhotos}>{c.photos}</button><button onClick={onFiles}>{c.files}</button></div><p className="field-hint">{c.filePrivacy}</p>
      <label className="switch-field"><span>{c.search}<small>{c.searchHint}</small></span><input type="checkbox" role="switch" checked={conversation ? conversation.webSearchMode === "always" : true} disabled={busy || !onChange} onChange={event => void change({ webSearchMode: event.target.checked ? "always" : "off" })} /></label>
      <label>{c.memory}<select aria-label={c.memory} value={conversation?.memoryMode ?? "inherit"} disabled={busy || !onChange} onChange={event => void change({ memoryMode: event.target.value as "inherit" | "on" | "off" })}><option value="inherit">{c.inherit}</option><option value="on">{c.on}</option><option value="off">{c.off}</option></select></label>
      <label>{c.assistant}<select aria-label={c.assistant} value={conversation?.assistantProfileId ?? ""} disabled={busy || !onChange || !profiles.length} onChange={event => void change({ assistantProfileId: event.target.value || null })}><option value="">{c.noAssistant}</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
      {extraTools?.map(action => <button className="tool-action" key={action.label} disabled={busy || action.disabled} onClick={() => { onClose(); action.onSelect(); }}>{action.label}<span aria-hidden="true">↗</span></button>)}
      {error && <p role="alert">{error}</p>}
    </div>
  </Sheet>;
}

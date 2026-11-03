import { useEffect, useState } from "react";
import { ArrowUpRight, Camera, ChevronRight, File, Globe, UserRound } from "lucide-react";
import { NativeLocationControl } from "./NativeLocationControl";
import { Sheet } from "./Sheet";
import type { AssistantSummary, ChatTransport, Conversation } from "./chatTransport";
import type { MobileLanguage } from "../../../locales/mobile";
import { mobileCopy } from "../../../locales/mobile";
import { mobileParityCopy } from "../../../locales/mobileParity";
import { mobileComposerToolsCopy } from "../../../locales/mobileComposerTools";
import "./composerTools.css";

export type ComposerAction = { label: string; disabled?: boolean; onSelect: () => void };
export type ToolChange = { webSearchMode?: "off" | "always"; assistantProfileId?: string | null };
export function ComposerTools({ locationIdentity = null, transport, language, conversation, onChange, onFiles, onPhotos, onClose, extraTools }: {
  locationIdentity?: string | null;
  transport: ChatTransport; language: MobileLanguage; conversation?: Conversation | null;
  extraTools?: ComposerAction[];
  onChange?: (input: ToolChange) => Promise<void>; onFiles: () => void; onPhotos: () => void; onClose: () => void;
}) {
  const c = mobileParityCopy(language);
  const tools = mobileComposerToolsCopy(language);
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
  return <Sheet className="composer-tools-sheet" title={tools.title} closeLabel={mobileCopy[language].close} onClose={() => { if (!busy) onClose(); }}>
    <div className="composer-tools">
      <div className="tool-attachments">
        <div className="tool-attachment-actions">
          <button type="button" aria-label={tools.photosAction} onClick={onPhotos}><Camera size={24} aria-hidden="true" /><span>{tools.photos}</span></button>
          <button type="button" aria-label={tools.filesAction} onClick={onFiles}><File size={24} aria-hidden="true" /><span>{tools.files}</span></button>
        </div>
        <p className="tool-attachment-hint">{tools.attachmentsHint}</p>
      </div>
      <div className="tool-settings">
        <label className="tool-row tool-switch-row">
          <Globe className="tool-icon" size={22} aria-hidden="true" />
          <span className="tool-copy">{tools.search}<small>{tools.searchHint}</small></span>
          <input className="tool-switch" type="checkbox" role="switch" aria-label={tools.search} checked={conversation ? conversation.webSearchMode === "always" : true} disabled={busy || !onChange} onChange={event => void change({ webSearchMode: event.target.checked ? "always" : "off" })} />
        </label>
        {transport.location && <NativeLocationControl presentation="tools" session={transport.location} identity={locationIdentity} language={language} />}
        <label className="tool-row tool-assistant">
          <UserRound className="tool-icon" size={22} aria-hidden="true" /><span className="tool-copy">{tools.assistant}</span>
          <select aria-label={tools.assistant} value={conversation?.assistantProfileId ?? ""} disabled={busy || !onChange || !profiles.length} onChange={event => void change({ assistantProfileId: event.target.value || null })}>
            <option value="">{tools.defaultAssistant}</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
          <span className="tool-selected" aria-hidden="true">{profiles.find(profile => profile.id === conversation?.assistantProfileId)?.name ?? tools.defaultAssistant}<ChevronRight size={18} /></span>
        </label>
        {extraTools?.map(action => <button type="button" className="tool-row tool-action" key={action.label} disabled={busy || action.disabled} onClick={() => { onClose(); action.onSelect(); }}>{action.label}<ArrowUpRight size={20} aria-hidden="true" /></button>)}
      </div>
      <p className="tool-scope">{tools.applies}</p>
      {error && <p className="tool-error" role="alert">{error}</p>}
    </div>
  </Sheet>;
}

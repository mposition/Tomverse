import { useEffect, useState } from "react";
import { mobileCopy, mobileLanguages, type MobileLanguage } from "../../../locales/mobile";
import { mobileParityCopy } from "../../../locales/mobileParity";
import type { ChatTransport, MemoryPreferences, MobileModel, UserPreferences } from "./chatTransport";
import type { DeviceSecurity } from "./authBridgeContract";

export function SettingsScreen({ transport, signedIn, language, theme, onLanguage, onTheme, onAccount, onSignOut }: {
  transport: ChatTransport; signedIn: boolean; language: MobileLanguage; theme: string;
  onLanguage: (language: MobileLanguage) => void; onTheme: (theme: string) => void;
  onAccount: () => void; onSignOut: () => void;
}) {
  const copy = mobileCopy[language]; const c = mobileParityCopy(language);
  const [now, setNow] = useState(() => Date.now());
  const [tab, setTab] = useState("general");
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [storedZone, setStoredZone] = useState("");
  const [models, setModels] = useState<MobileModel[]>([]);
  const [memory, setMemory] = useState<MemoryPreferences | null>(null);
  const [security, setSecurity] = useState<DeviceSecurity | null>(null);
  const [loading, setLoading] = useState(false); const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""); const [uncertain, setUncertain] = useState(false);
  async function refresh() {
    setNow(Date.now()); setLoading(true); setMessage(""); setUncertain(false); setMemoryDirty(false);
    const values = await Promise.allSettled([
      signedIn && transport.preferences ? transport.preferences() : Promise.resolve(null),
      signedIn && transport.memoryPreferences ? transport.memoryPreferences() : Promise.resolve(null),
      transport.deviceSecurity?.() ?? Promise.resolve(null), transport.models(),
    ]);
    if (values[0].status === "fulfilled") { setPreferences(values[0].value); setStoredZone(values[0].value?.timeZone ?? ""); }
    else setMessage(c.unavailable);
    if (values[1].status === "fulfilled") setMemory(values[1].value);
    if (values[2].status === "fulfilled") setSecurity(values[2].value);
    if (values[3].status === "fulfilled") setModels(values[3].value);
    setLoading(false);
  }
  useEffect(() => { queueMicrotask(() => void refresh()); /* Only the account/transport changes the readback scope. */ }, [transport, signedIn]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    if (!preferences || busy || uncertain || !transport.savePreferences) return;
    setBusy(true); setMessage("");
    try {
      await transport.savePreferences({ theme: theme as UserPreferences["theme"], language, defaultModel: preferences.defaultModel, imageHandoffAutoGenerate: preferences.imageHandoffAutoGenerate,
        ...(preferences.timeZone !== storedZone ? { timeZone: preferences.timeZone, timeZoneSource: "user" as const } : {}) });
      if (memoryDirty && memory && transport.saveMemoryPreferences) await transport.saveMemoryPreferences(memory);
      setMemoryDirty(false); setStoredZone(preferences.timeZone); setMessage(c.saved);
    } catch { setUncertain(true); setMessage(c.unavailable); }
    finally { setBusy(false); }
  }
  const changeLocked = Boolean(preferences?.timeZoneChangeAllowedAt && Date.parse(preferences.timeZoneChangeAllowedAt) > now);
  return <div className="native-settings">
    <nav className="settings-tabs" aria-label={c.settings}>{["general", "intelligence", "security", "privacy"].map(item => <button key={item} aria-current={tab === item ? "page" : undefined} onClick={() => { setTab(item); setMessage(""); }}>{c[item as "general"]}</button>)}</nav>
    {loading && <p role="status">{copy.loading}</p>}
    {message && <p role="status" className="notice">{message}</p>}
    {tab === "general" && <section className="settings-fields">
      <label>{copy.language}<select value={language} onChange={event => onLanguage(event.target.value as MobileLanguage)}>{mobileLanguages.map(value => <option value={value} key={value}>{({ en: "English", ko: "한국어", zh: "中文", de: "Deutsch", fr: "Français", es: "Español", pt: "Português" })[value]}</option>)}</select></label>
      <label>{copy.theme}<select value={theme} onChange={event => onTheme(event.target.value)}>{["system", "light", "dark"].map(value => <option key={value} value={value}>{copy[value as "system"]}</option>)}</select></label>
      {preferences && <><label>{c.timeZone}<input value={preferences.timeZone} disabled={busy || changeLocked} onChange={event => setPreferences({ ...preferences, timeZone: event.target.value })} /></label><p className="field-hint">{c.timeZoneHint}</p></>}
    </section>}
    {tab === "intelligence" && <section className="settings-fields">
      {preferences && <><label>{c.defaultModel}<select value={preferences.defaultModel} disabled={busy} onChange={event => setPreferences({ ...preferences, defaultModel: event.target.value })}>{models.map(model => <option value={model.id} key={model.id}>{model.name} · {model.minimumPlan}</option>)}</select></label><p className="field-hint">{c.autoHint}</p>
      <label className="switch-field">{c.imageAuto}<input type="checkbox" role="switch" checked={preferences.imageHandoffAutoGenerate} disabled={busy} onChange={event => setPreferences({ ...preferences, imageHandoffAutoGenerate: event.target.checked })} /></label></>}
      {memory ? <><label className="switch-field">{c.memory}<input type="checkbox" role="switch" checked={memory.masterEnabled} disabled={busy} onChange={event => { setMemoryDirty(true); setMemory({ ...memory, masterEnabled: event.target.checked }); }} /></label><label className="switch-field">{c.memoryStyle}<input type="checkbox" role="switch" checked={memory.styleEnabled} disabled={busy || !memory.masterEnabled} onChange={event => { setMemoryDirty(true); setMemory({ ...memory, styleEnabled: event.target.checked }); }} /></label><label>{c.memoryDefault}<select value={memory.defaultConversationMode} disabled={busy || !memory.masterEnabled} onChange={event => { setMemoryDirty(true); setMemory({ ...memory, defaultConversationMode: event.target.value as "on" | "off" }); }}><option value="on">{c.on}</option><option value="off">{c.off}</option></select></label></> : <p>{c.unavailable}</p>}
    </section>}
    {tab === "security" && <section className="settings-fields"><label className="switch-field">{c.deviceLock}<input type="checkbox" role="switch" checked={security?.enabled ?? false} disabled={!signedIn || !security?.available || busy || !transport.setDeviceLock} onChange={event => {
      const enabled = event.target.checked; setBusy(true); setMessage("");
      void transport.setDeviceLock!(enabled, c.unlockHint).then(async () => { setSecurity(await transport.deviceSecurity!()); setMessage(c.saved); }).catch(() => setMessage(c.deviceUnavailable)).finally(() => setBusy(false));
    }} /></label><p>{c.deviceHint}</p>{!security?.available && <p role="status">{c.deviceUnavailable}</p>}</section>}
    {tab === "privacy" && <section className="settings-fields"><button onClick={onAccount} disabled={!signedIn}>{copy.account}</button><a href="https://tomverse.app/privacy" target="_blank" rel="noreferrer">{copy.privacy} ↗</a><a href="https://tomverse.app/support" target="_blank" rel="noreferrer">{copy.support} ↗</a>{signedIn && <button onClick={onSignOut}>{copy.signOut}</button>}</section>}
    {uncertain && <button disabled={busy} onClick={() => void refresh()}>{c.retry}</button>}
    {preferences && ["general", "intelligence"].includes(tab) && <footer className="sheet-footer"><button className="primary" disabled={loading || busy || uncertain} onClick={() => void save()}>{busy ? copy.loading : c.save}</button></footer>}
  </div>;
}

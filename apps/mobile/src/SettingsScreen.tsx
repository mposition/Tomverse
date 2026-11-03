import { useEffect, useId, useMemo, useRef, useState } from "react";
import { mobileCopy, mobileLanguages, type MobileLanguage } from "../../../locales/mobile";
import { mobileParityCopy } from "../../../locales/mobileParity";
import type { ChatTransport, MemoryPreferences, MobileModel, UserPreferences } from "./chatTransport";
import type { DeviceSecurity } from "./authBridgeContract";
import { ACCOUNT_SETTINGS_TABS, type AccountSettingsTab } from "../../../lib/accountSettingsEvents";
import { mobileSettingsCopy } from "../../../locales/mobileSettings";
import { NativeBillingPanel } from "./NativeBillingPanel";
import { Browser } from "@capacitor/browser";
import { TOMVERSE_API_ORIGIN } from "./authBridge";
import { Bot, Brain, ChevronDown, ChevronRight, Clock3, CreditCard, Database, ExternalLink, Globe2, KeyRound, LockKeyhole, LogOut, Mail, MessageSquare, Settings2, Sun, UserRound, type LucideIcon } from "lucide-react";
import { mobileSettingsDesignCopy } from "../../../locales/mobileSettingsDesign";
import "./settings.css";

const tabIcons: Record<AccountSettingsTab, LucideIcon> = { account: UserRound, preferences: Settings2, assistants: Bot, ai: Brain, data: Database, plan: CreditCard };

export function SettingsScreen({ transport, signedIn, language, theme, onLanguage, onTheme, onAccount, onSignOut, initialTab = "account" }: {
  transport: ChatTransport; signedIn: boolean; language: MobileLanguage; theme: string;
  onLanguage: (language: MobileLanguage) => void; onTheme: (theme: string) => void;
  onAccount: () => void; onSignOut: () => void;
  initialTab?: AccountSettingsTab;
}) {
  const copy = mobileCopy[language]; const c = mobileParityCopy(language); const navigation = mobileSettingsCopy(language);
  const design = mobileSettingsDesignCopy(language);
  const [now, setNow] = useState(() => Date.now());
  const [tab, setTab] = useState<AccountSettingsTab>(initialTab);
  const [detail, setDetail] = useState<"memory" | null>(null);
  const entryPrefix = useId();
  const memoryEntry = useRef<HTMLButtonElement>(null);
  const previousDetail = useRef(detail);
  const [failedReads, setFailedReads] = useState<string[]>([]);
  const [account, setAccount] = useState<Awaited<ReturnType<ChatTransport["account"]>> | null>(null);
  const [assistants, setAssistants] = useState<Awaited<ReturnType<NonNullable<ChatTransport["assistants"]>>>>([]);
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
      signedIn ? transport.account() : Promise.resolve(null),
      signedIn && transport.assistants ? transport.assistants() : Promise.resolve([]),
    ]);
    if (values[0].status === "fulfilled") { setPreferences(values[0].value); setStoredZone(values[0].value?.timeZone ?? ""); }
    if (values[1].status === "fulfilled") setMemory(values[1].value);
    if (values[2].status === "fulfilled") setSecurity(values[2].value);
    if (values[3].status === "fulfilled") setModels(values[3].value);
    if (values[4].status === "fulfilled") setAccount(values[4].value);
    if (values[5].status === "fulfilled") setAssistants(values[5].value);
    setFailedReads(values.flatMap((value, index) => value.status === "rejected" ? [(["preferences", "memory", "security", "models", "account", "assistants"] as const)[index]] : []));
    setLoading(false);
  }
  useEffect(() => { queueMicrotask(() => void refresh()); /* Only the account/transport changes the readback scope. */ }, [transport, signedIn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (previousDetail.current && !detail) memoryEntry.current?.focus();
    previousDetail.current = detail;
  }, [detail]);
  useEffect(() => {
    if (initialTab === "data") queueMicrotask(() => document.getElementById(`${entryPrefix}-account-data`)?.closest("button")?.focus());
  }, [entryPrefix, initialTab]);
  async function save() {
    const savingMemory = detail === "memory";
    if (busy || uncertain || (savingMemory ? !memory || !memoryDirty || !transport.saveMemoryPreferences : !preferences || !transport.savePreferences)) return;
    setBusy(true); setMessage("");
    try {
      if (!detail && preferences && transport.savePreferences) await transport.savePreferences({ theme: theme as UserPreferences["theme"], language, defaultModel: preferences.defaultModel,
        ...(preferences.timeZone !== storedZone ? { timeZone: preferences.timeZone, timeZoneSource: "user" as const } : {}) });
      if (detail === "memory" && memoryDirty && memory && transport.saveMemoryPreferences) await transport.saveMemoryPreferences(memory);
      if (savingMemory) setMemoryDirty(false);
      else if (preferences) setStoredZone(preferences.timeZone);
      setMessage(c.saved);
    } catch { setUncertain(true); setMessage(c.unavailable); }
    finally { setBusy(false); }
  }
  const changeLocked = Boolean(preferences?.timeZoneChangeAllowedAt && Date.parse(preferences.timeZoneChangeAllowedAt) > now);
  const timeZoneOptions = useMemo(() => {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
    return [...new Set(["UTC", preferences?.timeZone || "UTC", ...(intl.supportedValuesOf?.("timeZone") || [])])].sort();
  }, [preferences?.timeZone]);
  const website = (path: string) => { void Browser.open({ url: new URL(path, TOMVERSE_API_ORIGIN).href }).catch(() => setMessage(c.unavailable)); };
  const entry = (id: string, title: string, description: string, onClick: () => void, disabled = false) => {
    const Icon = ({ notifications: Mail, login: KeyRound, memory: Brain, import: MessageSquare, "account-data": Database } as Record<string, LucideIcon>)[id] || ChevronRight;
    return <button type="button" className="settings-entry" ref={id === "memory" ? memoryEntry : undefined} aria-label={title} aria-describedby={`${entryPrefix}-${id}`} disabled={disabled} onClick={onClick}><Icon className="settings-row-icon" size={21} aria-hidden="true" /><span className="settings-row-copy"><strong>{title}</strong><small id={`${entryPrefix}-${id}`}>{description}</small></span><ChevronRight size={18} aria-hidden="true" /></button>;
  };
  const readFailed = detail === "memory" ? failedReads.includes("memory") : ({ account: ["account", "security"], preferences: ["preferences"], assistants: ["assistants"], ai: ["preferences", "models"], data: [], plan: [] }[tab]).some(key => failedReads.includes(key));
  const toggle = (Icon: LucideIcon, title: string, checked: boolean, disabled: boolean, onChange: (value: boolean) => void) => <label className="settings-toggle-row"><Icon size={21} aria-hidden="true" /><span>{title}</span><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /></label>;
  return <div className="native-settings">
    {detail ? <button type="button" className="settings-detail-back" onClick={() => { setDetail(null); setMessage(""); }}><span aria-hidden="true">← </span>{navigation.back}</button> : <nav className="settings-tabs" aria-label={c.settings}>{ACCOUNT_SETTINGS_TABS.map(item => { const Icon = tabIcons[item]; return <button key={item} data-testid={`native-settings-tab-${item}`} aria-current={tab === item ? "page" : undefined} onClick={() => { setTab(item); setMessage(""); }}><Icon size={18} aria-hidden="true" /><span>{navigation[item]}</span></button>; })}</nav>}
    {loading && <p role="status">{copy.loading}</p>}
    {message && <p role="status" className="notice">{message}</p>}
    {readFailed && <p role="status" className="notice">{c.unavailable}</p>}
    {!detail && tab === "account" && <section className="settings-fields">
      <h3>{design.accountInformation}</h3>
      <div className="settings-group"><div className="settings-profile"><span className="settings-avatar" aria-hidden="true"><UserRound size={25} /></span><div><strong>{account?.name || account?.email || "Tomverse"}</strong>{account?.name && <small>{account.email}</small>}</div></div>
      {entry("notifications", navigation.emailNotifications, navigation.emailOptional, () => website("/settings/notifications"), !signedIn)}
      </div>
      <h3>{navigation.security}</h3>
      <div className="settings-group"><div className="settings-security-control"><label className="switch-field"><LockKeyhole className="settings-row-icon" size={21} aria-hidden="true" /><span>{c.deviceLock}</span><input type="checkbox" role="switch" checked={security?.enabled ?? false} disabled={!signedIn || !security?.available || busy || !transport.setDeviceLock} onChange={event => {
        const enabled = event.target.checked; setBusy(true); setMessage("");
        void transport.setDeviceLock!(enabled, c.unlockHint).then(async () => { setSecurity(await transport.deviceSecurity!()); setMessage(c.saved); }).catch(() => setMessage(c.deviceUnavailable)).finally(() => setBusy(false));
      }} /></label><details className="settings-help"><summary>{design.deviceSummary}</summary><p>{c.deviceHint}</p>{!security?.available && <p role="status">{c.deviceUnavailable}</p>}</details></div>
      {entry("login", navigation.loginMethods, navigation.manageOnWeb, () => website("/chat?settings=account"), !signedIn)}
      </div>
      {signedIn && <button type="button" className="settings-sign-out" onClick={onSignOut}><LogOut size={18} aria-hidden="true" />{copy.signOut}</button>}
    </section>}
    {!detail && tab === "preferences" && <section className="settings-fields">
      <h3>{design.appearance}</h3><div className="settings-group settings-appearance"><div className="settings-control-title"><Sun size={21} aria-hidden="true" /><strong>{navigation.theme}</strong></div><div className="settings-theme-options" role="group" aria-label={navigation.theme}>{(["light", "dark", "system"] as const).map(value => <button key={value} type="button" aria-pressed={theme === value} onClick={() => onTheme(value)}><span>{navigation[value]}</span></button>)}</div></div>
      <h3>{design.languageAndTime}</h3><div className="settings-group">
      <label className="settings-value-row"><Globe2 className="settings-row-icon" size={21} aria-hidden="true" /><span>{navigation.language}</span><select aria-label={navigation.language} value={language} onChange={event => onLanguage(event.target.value as MobileLanguage)}>{["en", "zh", "ko", "fr", "de", "es", "pt"].filter(value => mobileLanguages.includes(value as MobileLanguage)).map(value => <option value={value} key={value}>{({ en: "English", ko: "한국어", zh: "中文", de: "Deutsch", fr: "Français", es: "Español", pt: "Português" })[value as MobileLanguage]}</option>)}</select><ChevronRight size={17} aria-hidden="true" /></label>
      {preferences && <div className="settings-time-zone"><label className="settings-value-row"><Clock3 className="settings-row-icon" size={21} aria-hidden="true" /><span>{navigation.timeZone}</span><select aria-label={navigation.timeZone} value={preferences.timeZone} disabled={busy || changeLocked} onChange={event => setPreferences({ ...preferences, timeZone: event.target.value })}>{timeZoneOptions.map(zone => <option key={zone} value={zone}>{zone}</option>)}</select><ChevronRight size={17} aria-hidden="true" /></label><p className="field-hint">{navigation.timeZoneHint}</p></div>}
      </div>
    </section>}
    {!detail && tab === "assistants" && <section className="settings-fields">
      <h3>{navigation.assistants}</h3>
      {!!assistants.length && <div className="settings-group settings-assistant-list">{assistants.map(assistant => <article className="settings-assistant" key={assistant.id}><span className="settings-assistant-avatar" aria-hidden="true"><Bot size={22} /></span><div><strong>{assistant.name}</strong>{assistant.description && <p>{assistant.description}</p>}</div></article>)}</div>}
      {!loading && !readFailed && !assistants.length && <div className="settings-group settings-empty"><Bot size={28} aria-hidden="true" /><p>{navigation.noAssistants}</p></div>}
      <button type="button" className="settings-inline-action" disabled={!signedIn} onClick={() => website("/settings/assistants")}><ExternalLink size={18} aria-hidden="true" /><span>{navigation.manageOnWeb}</span><ChevronRight size={18} aria-hidden="true" /></button>
    </section>}
    {!detail && tab === "ai" && <section className="settings-fields">
      <h3>{navigation.newConversationModels}</h3>
      {preferences && <div className="settings-group"><div className="settings-select-block"><label className="settings-select-control"><span><Brain size={21} aria-hidden="true" />{c.defaultModel}</span><span className="settings-select-value"><select value={preferences.defaultModel} disabled={busy} onChange={event => setPreferences({ ...preferences, defaultModel: event.target.value })}>{models.map(model => <option value={model.id} key={model.id}>{model.name} · {model.minimumPlan}</option>)}</select><ChevronDown size={17} aria-hidden="true" /></span></label><p className="field-hint">{c.autoHint}</p></div>
      </div>}
      <h3>{navigation.profilesAndMemory}</h3>
      <div className="settings-group">{entry("memory", navigation.memory, navigation.memoryDescription, () => setDetail("memory"), !signedIn)}</div>
    </section>}
    {detail === "memory" && <section className="settings-fields"><h3>{navigation.memory}</h3>
      {memory ? <div className="settings-group">{toggle(Brain, c.memory, memory.masterEnabled, busy, value => { setMemoryDirty(true); setMemory({ ...memory, masterEnabled: value }); })}{toggle(Settings2, c.memoryStyle, memory.styleEnabled, busy || !memory.masterEnabled, value => { setMemoryDirty(true); setMemory({ ...memory, styleEnabled: value }); })}<div className="settings-select-block"><label className="settings-select-control"><span><MessageSquare size={21} aria-hidden="true" />{c.memoryDefault}</span><span className="settings-select-value"><select value={memory.defaultConversationMode} disabled={busy || !memory.masterEnabled} onChange={event => { setMemoryDirty(true); setMemory({ ...memory, defaultConversationMode: event.target.value as "on" | "off" }); }}><option value="on">{c.on}</option><option value="off">{c.off}</option></select><ChevronDown size={17} aria-hidden="true" /></span></label></div></div> : <p>{c.unavailable}</p>}
      <button type="button" className="settings-inline-action" onClick={() => website("/settings/memory")}><ExternalLink size={18} aria-hidden="true" /><span>{navigation.manageOnWeb}</span><ChevronRight size={18} aria-hidden="true" /></button>
    </section>}
    {!detail && tab === "data" && <section className="settings-fields"><h3>{navigation.dataManagement}</h3>
      <div className="settings-group">{entry("import", navigation.externalImport, navigation.importDescription, () => website("/settings/imports"), !signedIn)}
      {entry("account-data", navigation.accountData, navigation.accountDataDescription, onAccount, !signedIn)}</div>
      <div className="settings-resource-links"><a href="https://tomverse.app/privacy" target="_blank" rel="noreferrer"><LockKeyhole size={16} aria-hidden="true" />{copy.privacy}<ExternalLink size={14} aria-hidden="true" /></a><a href="https://tomverse.app/support" target="_blank" rel="noreferrer"><MessageSquare size={16} aria-hidden="true" />{copy.support}<ExternalLink size={14} aria-hidden="true" /></a></div>
    </section>}
    {!detail && tab === "plan" && (import.meta.env.VITE_NATIVE_BILLING_ENABLED === "true" && signedIn ? <NativeBillingPanel language={language} /> : <p>{signedIn ? c.unavailable : loginCopyForPlan(language)}</p>)}
    {(uncertain || readFailed) && <button disabled={busy || loading} onClick={() => void refresh()}>{c.retry}</button>}
    {(preferences && ["preferences", "ai"].includes(tab) || detail === "memory" && memory) && <footer className="sheet-footer"><button className="primary" disabled={loading || busy || uncertain || detail === "memory" && !memoryDirty} onClick={() => void save()}>{busy ? copy.loading : c.save}</button></footer>}
  </div>;
}

const loginCopyForPlan = (language: MobileLanguage) => mobileCopy[language].signIn;

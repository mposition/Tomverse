import { useCallback, useEffect, useRef, useState } from "react";
import { SUPPORTED_LANGUAGES, type Language } from "../../../../lib/language";
import type { AccountSettingsTab } from "../../../../lib/accountSettingsEvents";
import { ASSISTANT_PROFILE_LIMITS } from "../../../../lib/assistantProfileVersioning";
import { CONSENT_REQUIRED_PURPOSES } from "../../../../lib/emailPreferenceCore";
import { MARKETING_ALLOWED_COUNTRY_CODES } from "../../../../lib/emailJurisdictionCore";
import { MEMORY_KINDS } from "../../../../lib/memoryValidatorCore";
import { desktopControlsCopy } from "../../../../locales/desktopControls";
import { desktopPrivacyCopy } from "../../../../locales/desktopPrivacy";
import { desktopChatCopy } from "../../../../locales/desktopChat";
import type { AccountPreferences, AccountSettingsResult, DesktopAccountSettingsInput } from "../account-settings-contract";
import type { ChatModel } from "../chat-contract";
import { desktopImportFilePrivacy, ExternalConversationImport } from "./ExternalConversationImport";
import { AccountDataPanel, DeleteAccountSection } from "./AccountDataSettings";
import { AssistantExtras } from "./AssistantExtras";
import { DeleteMemory, MemoryDataActions, MemoryScope } from "./MemoryExtras";
import { AccountSettingRow, ActionStatus, dictionaries, languageLabel, ReadStatus, useSettingsRead, type Common } from "./settings-shared";

export { AccountSettingRow };

const loadPreferences = () => window.desktop.accountSettings<"preferences">({ action: "preferences" });
const loadEmail = () => window.desktop.accountSettings<"email">({ action: "email" });
const loadMemory = () => window.desktop.accountSettings<"memory">({ action: "memory" });
const loadAssistants = () => window.desktop.accountSettings<"assistants">({ action: "assistants" });
const loadLoginMethods = () => window.desktop.accountSettings<"loginMethods">({ action: "loginMethods" });
const loadKeys = () => window.desktop.accountSettings<"keys">({ action: "keys" });
const loadUsage = () => window.desktop.accountSettings<"usage">({ action: "usage" });
const loadImportCapacity = () => window.desktop.accountSettings<"importCapacity">({ action: "importCapacity" });
const loadImportRuns = () => window.desktop.accountSettings<"importRuns">({ action: "importRuns" });


function Preferences({ language, onApply }: Common & { onApply(settings: AccountPreferences): void }) {
  const copy = dictionaries[language].auth;
  const state = useSettingsRead(loadPreferences);
  const [editedPreferences, setDraft] = useState<AccountPreferences>();
  const [openedAt] = useState(Date.now);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const baseline = state.data;
  const draft = editedPreferences ?? baseline;
  useEffect(() => { if (baseline) onApply(baseline); }, [baseline, onApply]);
  useEffect(() => {
    let current = true;
    void window.desktop.chatModels().then(rows => { if (current) setModels(rows); }, () => {});
    return () => { current = false; };
  }, []);
  if (!baseline || !draft) return <ReadStatus language={language} failed={state.failed} retry={state.reload} />;
  const locked = !!draft.timeZoneChangeAllowedAt && Date.parse(draft.timeZoneChangeAllowedAt) > openedAt;
  const changedModels = draft.newConversationModelIds.length !== baseline.newConversationModelIds.length ||
    draft.newConversationModelIds.some((id, index) => id !== baseline.newConversationModelIds[index]);
  const changes = {
    ...(draft.theme !== baseline.theme ? { theme: draft.theme } : {}),
    ...(draft.language !== baseline.language ? { language: draft.language } : {}),
    ...(draft.timeZone !== baseline.timeZone ? { timeZone: draft.timeZone } : {}),
    ...(changedModels ? { newConversationModelIds: draft.newConversationModelIds } : {}),
  };
  const edited = Object.keys(changes).length > 0;
  const zones = Array.from(new Set(["UTC", draft.timeZone, baseline.timeZone, ...Intl.supportedValuesOf("timeZone")]));
  return <form data-testid="native-account-preferences" onSubmit={event => {
    event.preventDefault();
    if (!edited || busy) return;
    setBusy(true);
    setFailed(false);
    void (async () => {
      await window.desktop.accountSettings<"savePreferences">({ action: "savePreferences", changes });
      const updated = await loadPreferences();
      setDraft(undefined);
      state.setData(updated);
    })().catch(() => setFailed(true)).finally(() => setBusy(false));
  }}>
    <AccountSettingRow label={<label htmlFor="account-settings-theme">{copy.theme}</label>}>
      <select id="account-settings-theme" value={draft.theme} disabled={busy}
        onChange={event => setDraft({ ...draft, theme: event.currentTarget.value as AccountPreferences["theme"] })}>
        <option value="system">{copy.systemTheme}</option><option value="dark">{copy.darkTheme}</option><option value="light">{copy.lightTheme}</option>
      </select>
    </AccountSettingRow>
    <AccountSettingRow label={<label htmlFor="account-settings-language">{copy.language}</label>}>
      <select id="account-settings-language" value={draft.language} disabled={busy}
        onChange={event => setDraft({ ...draft, language: event.currentTarget.value as Language })}>
        {SUPPORTED_LANGUAGES.map(option => <option key={option} value={option} lang={option}>{languageLabel(option)}</option>)}
      </select>
    </AccountSettingRow>
    <AccountSettingRow label={<label htmlFor="account-settings-zone">{copy.timeZone}</label>}
      description={locked && draft.timeZoneChangeAllowedAt
        ? copy.timeZoneChangeLocked.replace("{date}", new Date(draft.timeZoneChangeAllowedAt).toLocaleDateString(language))
        : copy.timeZoneDescription}>
      <select id="account-settings-zone" value={draft.timeZone} disabled={busy || locked}
        onChange={event => setDraft({ ...draft, timeZone: event.currentTarget.value })}>
        {zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}
      </select>
    </AccountSettingRow>
    {draft.newConversationModelIds.length > 0 && <AccountSettingRow label={<label htmlFor="account-settings-model">{copy.defaultModel}</label>}>
      <select id="account-settings-model" value={draft.newConversationModelIds[0]} disabled={busy || !models.length}
        onChange={event => {
          const id = event.currentTarget.value;
          setDraft({ ...draft, newConversationModelIds: [id, ...draft.newConversationModelIds.slice(1).filter(model => model !== id)] });
        }}>
        {!models.some(model => model.id === draft.newConversationModelIds[0]) &&
          <option value={draft.newConversationModelIds[0]}>{draft.newConversationModelIds[0]}</option>}
        {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select>
    </AccountSettingRow>}
    <div className="account-settings-actions">
      <button type="button" className="soft" disabled={busy || !edited} onClick={() => { setDraft(undefined); setFailed(false); }}>
        {copy.cancel}
      </button>
      <button type="submit" className="primary" disabled={busy || !edited}>{copy.ok}</button>
    </div>
    <ActionStatus language={language} failed={failed} />
  </form>;
}

function LoginMethods({ language }: Common) {
  const state = useSettingsRead(loadLoginMethods);
  const copy = dictionaries[language].auth;
  if (!state.data) return <ReadStatus language={language} failed={state.failed} retry={state.reload} />;
  const providers: Record<string, string> = { apple: "Apple", google: "Google", "azure-ad": "Microsoft" };
  return <div data-testid="native-account-login-methods">
    {state.data.methods.map(method => <AccountSettingRow key={method.type === "email" ? "email" : method.provider}
      label={method.type === "email" ? copy.emailLoginEmailInputLabel : providers[method.provider] ?? method.provider}>
      <span>{(method.type === "email" ? method.enabled : method.linked) ? "✓" : "—"}</span>
    </AccountSettingRow>)}
  </div>;
}

function EmailNotifications({ language }: Common) {
  const state = useSettingsRead(loadEmail);
  const copy = dictionaries[language].emailNotifications;
  const [country, setCountry] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!state.data) return <ReadStatus language={language} failed={state.failed} retry={state.reload} />;
  const selectedCountry = country ?? state.data.country.selfDeclared ?? "";
  const countries = new Intl.DisplayNames(language, { type: "region" });
  function update(changes: Extract<DesktopAccountSettingsInput, { action: "saveEmail" }>["changes"]) {
    setBusy(true); setFailed(false);
    void window.desktop.accountSettings<"saveEmail">({ action: "saveEmail", changes })
      .then(result => { state.setData(result); setCountry(undefined); }, () => setFailed(true)).finally(() => setBusy(false));
  }
  return <section className="desktop-setting-section" data-testid="native-account-email">
    <h3>{copy.title}</h3>
    <AccountSettingRow label={<label htmlFor="account-email-country">{copy.countryLabel}</label>} description={copy.countryDescription}>
      <select id="account-email-country" value={selectedCountry} disabled={busy} onChange={event => setCountry(event.currentTarget.value)}>
        <option value="">{copy.countryPlaceholder}</option>
        {MARKETING_ALLOWED_COUNTRY_CODES.map(code => <option key={code} value={code}>{countries.of(code) ?? code}</option>)}
      </select>
    </AccountSettingRow>
    {state.data.preferences.map(preference => {
      const info = copy.purpose[preference.purpose];
      const pending = preference.confirmation === "pending";
      const consent = CONSENT_REQUIRED_PURPOSES.has(preference.purpose);
      const toggle = { purpose: preference.purpose, enabled: !preference.enabled };
      return <AccountSettingRow key={preference.purpose} label={info.title}
        description={pending ? copy.confirmationPendingNote : info.description}>
        {preference.locked ? <span>{copy.alwaysOn}</span> : consent && !preference.enabled
          ? <div className="account-settings-actions">
            {pending && <button className="soft" type="button" disabled={busy}
              onClick={() => update({ purpose: preference.purpose, enabled: false, cancelRequestOnly: true })}>{copy.confirmationCancel}</button>}
            <button className="soft" type="button" disabled={busy || !selectedCountry}
              onClick={() => update({ ...toggle, country: selectedCountry })}>{pending ? copy.confirmationResend : copy.confirmationSend}</button>
          </div>
          : <input type="checkbox" aria-label={info.title} disabled={busy} checked={preference.enabled}
            onChange={() => update(toggle)} />}
      </AccountSettingRow>;
    })}
    <div className="account-settings-actions">
      <button type="button" className="soft" disabled={busy || !selectedCountry || selectedCountry === state.data.country.selfDeclared}
        onClick={() => update({ country: selectedCountry })}>{copy.countrySave}</button>
      <button type="button" className="soft" disabled={busy}
        onClick={() => update({ withdrawAllMarketing: true })}>{copy.withdrawAll}</button>
    </div>
    {failed && <p role="alert">{copy.noticeActionFailed}</p>}
  </section>;
}

function Account({ language }: Common) {
  const [email, setEmail] = useState(false);
  const copy = dictionaries[language].emailNotifications;
  return <>
    <LoginMethods language={language} />
    <AccountSettingRow label={copy.title} description={copy.description}>
      <button className="soft" type="button" aria-expanded={email} onClick={() => setEmail(!email)}>{copy.dataTabOpen}</button>
    </AccountSettingRow>
    {email && <EmailNotifications language={language} />}
    <DeleteAccountSection language={language} />
  </>;
}

function StoredMemories({ language }: Common) {
  const [offset, setOffset] = useState(0);
  const load = useCallback(() => window.desktop.accountSettings<"memories">({ action: "memories", offset }), [offset]);
  const state = useSettingsRead(load);
  const [kind, setKind] = useState<(typeof MEMORY_KINDS)[number]>("preference");
  const [statement, setStatement] = useState("");
  const [groundsText, setGroundsText] = useState("");
  const [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = dictionaries[language].memoryReview;
  if (editing) return <MemoryDetail id={editing} language={language} close={() => { setEditing(undefined); state.reload(); }} />;
  if (!state.data) return <ReadStatus language={language} failed={state.failed} retry={state.reload} />;
  return <section className="desktop-setting-section" data-testid="native-account-memories">
    <h3>{copy.pageTitle}</h3>
    {state.data.memories.length === 0 && <p>{copy.activeEmpty}</p>}
    {state.data.memories.map(memory => <AccountSettingRow key={memory.id} label={memory.statement} description={copy.kind[memory.kind]}>
      <span>{copy.status[memory.status as keyof typeof copy.status] ?? memory.status}</span>
      <button className="soft" type="button" disabled={busy} onClick={() => setEditing(memory.id)}
        aria-label={(memory.status === "active" ? copy.edit : copy.dataTabOpen) + " · " + memory.statement}>
        {memory.status === "active" ? copy.edit : dictionaries[language].externalImport.viewDetail}
      </button>
    </AccountSettingRow>)}
    {state.data.total > 50 && <div className="account-settings-actions">
      <button type="button" className="soft" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{"‹"}</button>
      <button type="button" className="soft" disabled={offset + 50 >= state.data.total} onClick={() => setOffset(offset + 50)}>{copy.loadMore}</button>
    </div>}
    <form className="account-settings-form desktop-setting-section" onSubmit={event => {
      event.preventDefault();
      if (busy || !statement.trim() || !groundsText.trim()) return;
      setBusy(true); setFailed(false);
      void window.desktop.accountSettings<"addMemory">({ action: "addMemory", kind, statement, groundsText })
        .then(() => { setStatement(""); setGroundsText(""); state.reload(); }, () => setFailed(true)).finally(() => setBusy(false));
    }}>
      <h3>{copy.createTitle}</h3>
      <label>{copy.createKindLabel}<select value={kind} disabled={busy}
        onChange={event => setKind(event.currentTarget.value as typeof kind)}>
        {MEMORY_KINDS.map(kind => <option key={kind} value={kind}>{copy.kind[kind]}</option>)}
      </select></label>
      <label>{copy.createStatementLabel}<textarea maxLength={1_000} value={statement} disabled={busy} required
        onChange={event => setStatement(event.currentTarget.value)} /></label>
      <label>{copy.createGroundsLabel}<textarea maxLength={2_000} value={groundsText} disabled={busy} required
        onChange={event => setGroundsText(event.currentTarget.value)} /></label>
      <button className="primary" type="submit" disabled={busy || !statement.trim() || !groundsText.trim()}>{copy.createSubmit}</button>
    </form>
    <ActionStatus language={language} failed={failed} />
  </section>;
}

function MemoryDetail({ id, language, close }: Common & { id: string; close(): void }) {
  const load = useCallback(() => window.desktop.accountSettings<"memoryDetail">({ action: "memoryDetail", id }), [id]);
  const state = useSettingsRead(load);
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = dictionaries[language].memoryReview;
  const memory = state.data?.memory;
  const statement = draft ?? memory?.statement ?? "";

  async function update(values: Extract<DesktopAccountSettingsInput, { action: "updateMemory" }>["values"]) {
    setBusy(true); setFailed(false);
    try {
      await window.desktop.accountSettings<"updateMemory">({ action: "updateMemory", id, values });
      setDraft(undefined);
      state.reload();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return <section className="desktop-setting-section" data-testid="native-memory-detail">
    <div className="account-settings-actions">
      <button className="soft" type="button" disabled={busy} onClick={close}>{dictionaries[language].externalImport.back}</button>
    </div>
    {memory ? <>
      <h3>{copy.kind[memory.kind]}</h3>
      <p>{copy.status[memory.status as keyof typeof copy.status] ?? memory.status}
        {memory.pinned && " · " + copy.pinnedBadge}{memory.sensitivity === "sensitive" && " · " + copy.sensitiveBadge}</p>
      {memory.expiresAt && <p>{copy.expires.replace("{date}", new Date(memory.expiresAt).toLocaleDateString(language))}</p>}
      {memory.status === "active" ? <form className="account-settings-form" onSubmit={event => {
        event.preventDefault();
        if (!busy && statement.trim()) void update({ action: "edit", statement });
      }}>
        <label>{copy.createStatementLabel}<textarea required disabled={busy} maxLength={1_000}
          value={statement} onChange={event => setDraft(event.currentTarget.value)} /></label>
        <div className="account-settings-actions">
          <button type="button" className="soft" disabled={busy || failed || draft !== undefined}
            onClick={() => void update({ action: memory.pinned ? "unpin" : "pin" })}>{memory.pinned ? copy.unpin : copy.pin}</button>
          <button type="submit" className="primary" disabled={busy || failed || !statement.trim() || statement === memory.statement}>{copy.save}</button>
        </div>
      </form> : <p>{memory.statement}</p>}
      {memory.status === "active" && memory.revision !== undefined && <MemoryScope language={language} id={id}
        revision={memory.revision} projectId={memory.projectId ?? null} onMoved={state.reload} />}
      <DeleteMemory language={language} id={id} onDeleted={close} />
      {memory.evidence.length > 0 && <ul>{memory.evidence.map(evidence => <li key={evidence.id}>
        {evidence.manualContent ? <>{copy.evidenceManual} {evidence.manualContent}</> :
          <>{copy.evidenceExternal}{evidence.sourceTitle && " · " + evidence.sourceTitle}</>}
      </li>)}</ul>}
      {!!state.data?.conflicts.length && <><p>{copy.conflictNotice}</p>
        <ul>{state.data.conflicts.map(conflict => <li key={conflict.id}>{conflict.statement}</li>)}</ul>
      </>}
    </> : <ReadStatus language={language} failed={state.failed} retry={state.reload} />}
    {failed && <div className="desktop-settings-feedback">
      <p role="alert">{copy.errorGeneric}</p>
      <button type="button" className="soft" onClick={() => { setFailed(false); state.reload(); }}>
        {desktopControlsCopy[language].retrySettings}
      </button>
    </div>}
  </section>;
}

function Memory({ language }: Common) {
  const state = useSettingsRead(loadMemory);
  const [browse, setBrowse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = dictionaries[language].memoryReview;
  if (!state.data) return <ReadStatus language={language} failed={state.failed} retry={state.reload} />;
  const saved = state.data;
  function update(values: AccountSettingsResult<"memory">) {
    setBusy(true); setFailed(false);
    void window.desktop.accountSettings<"saveMemory">({ action: "saveMemory", values })
      .then(state.setData, () => setFailed(true)).finally(() => setBusy(false));
  }
  return <div data-testid="native-account-memory">
    <AccountSettingRow label={<label htmlFor="account-memory-master">{copy.masterToggleLabel}</label>}>
      <input id="account-memory-master" type="checkbox" disabled={busy} checked={saved.masterEnabled}
        onChange={event => update({ ...saved, masterEnabled: event.currentTarget.checked })} />
    </AccountSettingRow>
    <AccountSettingRow label={<label htmlFor="account-memory-style">{copy.styleToggleLabel}</label>}>
      <input id="account-memory-style" type="checkbox" disabled={busy || !saved.masterEnabled} checked={saved.styleEnabled}
        onChange={event => update({ ...saved, styleEnabled: event.currentTarget.checked })} />
    </AccountSettingRow>
    <AccountSettingRow label={<label htmlFor="account-memory-default">{copy.defaultModeLabel}</label>}>
      <input id="account-memory-default" type="checkbox" disabled={busy || !saved.masterEnabled} checked={saved.defaultConversationMode === "on"}
        onChange={event => update({ ...saved, defaultConversationMode: event.currentTarget.checked ? "on" : "off" })} />
    </AccountSettingRow>
    <AccountSettingRow label={copy.dataTabTitle} description={copy.dataTabDescription}>
      <button className="soft" type="button" aria-expanded={browse} onClick={() => setBrowse(!browse)}>{copy.dataTabOpen}</button>
    </AccountSettingRow>
    {browse && <StoredMemories language={language} />}
    <ActionStatus language={language} failed={failed} />
    <MemoryDataActions language={language} />
  </div>;
}

function Assistants({ language }: Common) {
  const state = useSettingsRead(loadAssistants);
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = dictionaries[language].assistantProfiles;
  if (editing) return <AssistantEditor id={editing} language={language} close={() => { setEditing(undefined); state.reload(); }} />;
  if (!state.data) return <ReadStatus language={language} failed={state.failed} retry={state.reload} />;
  return <div data-testid="native-account-assistants">
    {state.data.profiles.map(profile => <AccountSettingRow key={profile.id} label={profile.name}
      description={profile.description || (!profile.published && copy.draftStatus)}>
      <button className="soft" type="button" disabled={busy} aria-label={copy.editTitle + " · " + profile.name}
        onClick={() => setEditing(profile.id)}>{copy.editTitle}</button>
    </AccountSettingRow>)}
    <form className="desktop-setting-section account-settings-form" onSubmit={event => {
      event.preventDefault();
      if (!name.trim() || !instructions.trim() || busy) return;
      setBusy(true); setFailed(false);
      void window.desktop.accountSettings<"createAssistant">({ action: "createAssistant", name, description: description || undefined, instructions })
        .then(() => { setName(""); setDescription(""); setInstructions(""); state.reload(); }, () => setFailed(true)).finally(() => setBusy(false));
    }}>
      <h3>{copy.newTitle}</h3>
      <label>{copy.nameLabel}<input required maxLength={ASSISTANT_PROFILE_LIMITS.maxNameCharacters} value={name} disabled={busy} onChange={event => setName(event.currentTarget.value)} /></label>
      <label>{copy.descriptionLabel}<textarea maxLength={ASSISTANT_PROFILE_LIMITS.maxDescriptionCharacters} value={description} disabled={busy}
        onChange={event => setDescription(event.currentTarget.value)} /></label>
      <label>{copy.instructionsLabel}<textarea required maxLength={ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters}
        value={instructions} disabled={busy} onChange={event => setInstructions(event.currentTarget.value)} /></label>
      <button type="submit" className="primary" disabled={busy || !name.trim() || !instructions.trim()}>{copy.createAction}</button>
    </form>
    <ActionStatus language={language} failed={failed} />
  </div>;
}

function AssistantEditor({ id, language, close }: Common & { id: string; close(): void }) {
  const load = useCallback(() => window.desktop.accountSettings<"assistant">({ action: "assistant", id }), [id]);
  const state = useSettingsRead(load);
  const copy = dictionaries[language];
  return <div>
    <div className="account-settings-actions">
      <button className="soft" type="button" onClick={close}>{copy.externalImport.back}</button>
    </div>
    {state.data ? <>
      <AssistantEditorForm key={state.data.profile.currentVersion?.id ?? id} profile={state.data.profile}
        language={language} reload={state.reload} />
      <AssistantExtras language={language} id={id} name={state.data.profile.name} reloadProfile={state.reload} onDeleted={close} />
    </> : <ReadStatus language={language} failed={state.failed} retry={state.reload} />}
  </div>;
}

function AssistantEditorForm({ profile, language, reload }: Common & {
  profile: AccountSettingsResult<"assistant">["profile"]; reload(): void;
}) {
  const current = profile.currentVersion;
  const copy = dictionaries[language].assistantProfiles;
  const [identity, setIdentity] = useState({ name: profile.name, icon: profile.icon ?? "", description: profile.description ?? "" });
  const [instructions, setInstructions] = useState(current?.instructions ?? "");
  const [starters, setStarters] = useState(current?.starters.join("\n") ?? "");
  const [models, setModels] = useState<ChatModel[]>([]);
  const [modelIds, setModelIds] = useState<string[]>(current?.models ?? []);
  const [search, setSearch] = useState(current?.toolPolicy.webSearch ?? false);
  const [research, setResearch] = useState(current?.toolPolicy.deepResearch ?? false);
  const [memory, setMemory] = useState(current?.memoryPolicy.useAccountMemory ?? false);
  const [files, setFiles] = useState(() => new Set(current?.knowledgeManifest.map(file => file.fileId)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    let visible = true;
    void window.desktop.chatModels().then(result => { if (visible) setModels(result); }, () => {});
    return () => { visible = false; };
  }, []);
  const availableModels = models.filter(model => !modelIds.includes(model.id));
  const lines = starters.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const ownFiles = profile.knowledgeFiles.filter(file => file.processingStatus === "ready" || files.has(file.id));
  const canPublish = lines.length <= ASSISTANT_PROFILE_LIMITS.maxStarters &&
    lines.every(line => line.length <= ASSISTANT_PROFILE_LIMITS.maxStarterCharacters);

  async function save(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setError(false); setNotice("");
    try { setNotice(await action()); }
    catch { setError(true); setUncertain(true); }
    finally { setBusy(false); }
  }

  return <div data-testid="native-assistant-editor">
    <form className="desktop-setting-section account-settings-form" onSubmit={event => {
      event.preventDefault();
      void save(async () => {
        await window.desktop.accountSettings<"saveAssistantIdentity">({ action: "saveAssistantIdentity", id: profile.id,
          values: { name: identity.name, icon: identity.icon || null, description: identity.description || null } });
        return copy.noticeSaved;
      });
    }}>
      <h3>{copy.identityHeading}</h3>
      <label>{copy.nameLabel}<input required value={identity.name} maxLength={ASSISTANT_PROFILE_LIMITS.maxNameCharacters}
        onChange={event => setIdentity({ ...identity, name: event.currentTarget.value })} /></label>
      <label>{copy.iconLabel}<input value={identity.icon} maxLength={ASSISTANT_PROFILE_LIMITS.maxIconCharacters}
        onChange={event => setIdentity({ ...identity, icon: event.currentTarget.value })} /></label>
      <label>{copy.descriptionLabel}<textarea value={identity.description} maxLength={ASSISTANT_PROFILE_LIMITS.maxDescriptionCharacters}
        onChange={event => setIdentity({ ...identity, description: event.currentTarget.value })} /></label>
      <button type="submit" className="soft" disabled={busy || uncertain || !identity.name.trim()}>{copy.saveIdentity}</button>
    </form>
    <form className="desktop-setting-section account-settings-form" onSubmit={event => {
      event.preventDefault();
      void save(async () => {
        const result = await window.desktop.accountSettings<"publishAssistant">({ action: "publishAssistant", id: profile.id, values: {
          instructions, starters: lines, modelIds, expectedRevision: current?.revision ?? null,
          toolPolicy: { webSearch: search, deepResearch: research }, memoryPolicy: { useAccountMemory: memory },
          knowledgeFileIds: ownFiles.filter(file => files.has(file.id)).map(file => file.id),
        } });
        if (result.outcome === "published") { reload(); return copy.noticePublished; }
        return copy.noticeUnchanged;
      });
    }}>
      <h3>{copy.behaviourHeading}</h3>
      <p>{copy.behaviourHint}</p>
      <label>{copy.instructionsLabel}<textarea value={instructions} maxLength={ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters}
        onChange={event => setInstructions(event.currentTarget.value)} /></label>
      <label>{copy.modelsLabel}<select value="" disabled={!availableModels.length || modelIds.length >= ASSISTANT_PROFILE_LIMITS.maxModels}
        onChange={event => setModelIds([...modelIds, event.currentTarget.value])}>
        <option value="" disabled>{modelIds.length ? copy.modelModeExplicit : copy.modelModeDefault}</option>
        {availableModels.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}
      </select></label>
      {modelIds.map(modelId => <AccountSettingRow key={modelId} label={models.find(model => model.id === modelId)?.name ?? modelId}>
        <button className="soft" type="button" aria-label={copy.knowledgeRemove.replace("{name}", modelId)}
          onClick={() => setModelIds(modelIds.filter(id => id !== modelId))}>×</button>
      </AccountSettingRow>)}
      <AccountSettingRow label={<label htmlFor="assistant-search">{copy.toolWebSearch}</label>}>
        <input id="assistant-search" type="checkbox" checked={search} onChange={event => setSearch(event.currentTarget.checked)} />
      </AccountSettingRow>
      <AccountSettingRow label={<label htmlFor="assistant-research">{copy.toolDeepResearch}</label>}>
        <input id="assistant-research" type="checkbox" checked={research} onChange={event => setResearch(event.currentTarget.checked)} />
      </AccountSettingRow>
      <AccountSettingRow label={<label htmlFor="assistant-memory">{copy.memoryLabel}</label>}>
        <input id="assistant-memory" type="checkbox" checked={memory} onChange={event => setMemory(event.currentTarget.checked)} />
      </AccountSettingRow>
      <label>{copy.startersLabel}<textarea value={starters} onChange={event => setStarters(event.currentTarget.value)} /></label>
      {ownFiles.length > 0 && <fieldset><legend>{copy.knowledgeLabel}</legend>{ownFiles.map(file =>
        <AccountSettingRow key={file.id} label={<label htmlFor={"assistant-file-" + file.id}>{file.name}</label>}>
          <input id={"assistant-file-" + file.id} type="checkbox" checked={files.has(file.id)} onChange={event => {
            const next = new Set(files);
            if (event.currentTarget.checked) next.add(file.id); else next.delete(file.id);
            setFiles(next);
          }} />
        </AccountSettingRow>)}</fieldset>}
      {!canPublish && <p role="alert">{copy.noticeTooLarge}</p>}
      <button className="primary" type="submit" disabled={busy || uncertain || !canPublish}>{copy.saveChanges}</button>
    </form>
    <section className="desktop-setting-section">
      <h3>{copy.historyHeading}</h3>
      {profile.versions.length === 0 ? <p>{copy.historyEmpty}</p> : <ol>{profile.versions.map(version => <li key={version.id}>
        {copy.historyEntry.replace("{revision}", String(version.revision))}{version.id === current?.id ? " · " + copy.historyCurrent : ""}
      </li>)}</ol>}
    </section>
    {notice && <p role="status">{notice}</p>}
    {error && <div className="desktop-settings-feedback">
      <p role="alert">{copy.noticeFailed}</p>
      <button className="soft" type="button" onClick={reload}>{desktopControlsCopy[language].retrySettings}</button>
    </div>}
  </div>;
}

function ImportedConversations({ language, onContinue }: Common & { onContinue(id: string): Promise<void> }) {
  const [offset, setOffset] = useState(0);
  const load = useCallback(() => window.desktop.accountSettings<"imports">({ action: "imports", offset }), [offset]);
  const state = useSettingsRead(load);
  const capacity = useSettingsRead(loadImportCapacity);
  const runs = useSettingsRead(loadImportRuns);
  const [opening, setOpening] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [failed, setFailed] = useState(false);
  const [viewing, setViewing] = useState<string>();
  const keys = useRef(new Map<string, string>());
  const copy = desktopChatCopy[language];
  const importCopy = dictionaries[language].externalImport;
  const format = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  if (viewing) return <ImportedConversation language={language} id={viewing} onBack={() => setViewing(undefined)} />;
  if (showImport) return <ExternalConversationImport copy={importCopy} language={language} onClose={saved => {
    setShowImport(false);
    if (saved) {
      capacity.reload();
      runs.reload();
      if (offset) setOffset(0);
      else state.reload();
    }
  }} />;
  const next = state.data && state.data.offset + state.data.limit;
  const storage = capacity.data;
  return <div data-testid="native-account-imports">
    <section className="desktop-setting-section" aria-label={importCopy.capacityTitle}>
      <h3>{importCopy.capacityTitle}</h3>
      {storage?.usage && storage.limits && <>
        <p>{importCopy.capacityUsage
          .replace("{used}", format.format(storage.usage.normalizedTextBytes / (1024 * 1024)) + " MB")
          .replace("{limit}", format.format(storage.limits.maxNormalizedTextBytes / (1024 * 1024)) + " MB")}</p>
        <p>{importCopy.capacityConversations.replace("{used}", format.format(storage.usage.externalConversations))
          .replace("{limit}", format.format(storage.limits.maxExternalConversations))}</p>
      </>}
      {!storage && <ReadStatus language={language} failed={capacity.failed} retry={capacity.reload} />}
      <button type="button" className="primary" disabled={opening || !storage} onClick={() => setShowImport(true)}>{importCopy.newImportCta}</button>
    </section>
    <section className="desktop-setting-section" aria-label={importCopy.detailConversations}>
    <h3>{importCopy.detailConversations}</h3>
    {!state.data && <ReadStatus language={language} failed={state.failed} retry={state.reload} />}
    {state.data?.conversations.length === 0 && <p>{importCopy.conversationsEmpty}</p>}
    {state.data?.conversations.map(conversation => <AccountSettingRow key={conversation.id} label={conversation.title} description={conversation.provider}>
      <button className="soft" type="button" disabled={opening || conversation.titleWithheld} onClick={() => setViewing(conversation.id)}
        aria-label={importCopy.viewDetail + " · " + conversation.title}>{importCopy.viewDetail}</button>
      <button className="soft" type="button" disabled={opening || !state.data?.continuationEnabled || conversation.titleWithheld} onClick={() => {
        const key = keys.current.get(conversation.id) ?? crypto.randomUUID();
        keys.current.set(conversation.id, key);
        setFailed(false); setOpening(true);
        void window.desktop.accountSettings<"continueImport">({ action: "continueImport", id: conversation.id, key })
          .then(result => onContinue(result.conversationId)).catch(() => setFailed(true)).finally(() => setOpening(false));
      }}>{copy.continueImported}</button>
    </AccountSettingRow>)}
    {state.data && next !== undefined && (offset > 0 || next < state.data.total) && <div className="account-settings-actions">
      <button type="button" className="soft" aria-label="Previous page" disabled={opening || offset === 0}
        onClick={() => setOffset(Math.max(0, offset - 50))}>‹</button>
      <button type="button" className="soft" aria-label="Next page" disabled={opening || next >= state.data.total}
        onClick={() => setOffset(next)}>›</button>
    </div>}
    </section>
    <section className="desktop-setting-section" aria-label={importCopy.historyTitle}>
      <h3>{importCopy.historyTitle}</h3>
      {!runs.data ? <ReadStatus language={language} failed={runs.failed} retry={runs.reload} />
        : runs.data.imports.length === 0 ? <p>{importCopy.historyEmpty}</p>
        : runs.data.imports.map(run => <AccountSettingRow key={run.id} label={run.provider}
          description={new Date(run.createdAt).toLocaleString(language)}>
          <span>{importCopy.historyConversations.replace("{count}", format.format(run.conversationCount))}</span>
          <small>{run.status === "completed" ? importCopy.statusCompleted : run.status === "failed" ? importCopy.statusFailed
            : run.status === "cancelled" ? importCopy.statusCancelled : importCopy.statusStaging}</small>
        </AccountSettingRow>)}
    </section>
    <ActionStatus language={language} failed={failed} />
  </div>;
}

function ImportedConversation({ language, id, onBack }: Common & { id: string; onBack(): void }) {
  const [offset, setOffset] = useState(0);
  const load = useCallback(() => window.desktop.accountSettings<"importConversation">({ action: "importConversation", id, offset }), [id, offset]);
  const state = useSettingsRead(load);
  const copy = dictionaries[language].externalImport;
  const data = state.data;
  return <section className="desktop-setting-section" data-testid="native-import-conversation">
    <button type="button" className="soft" onClick={onBack}>{copy.backToImports}</button>
    {!data ? <ReadStatus language={language} failed={state.failed} retry={state.reload} /> : <>
      <h3>{data.title}</h3>
      <ol className="thread">{data.messages.map(message => <li key={message.id} className={`entry entry--${message.role}`}>
        <strong>{message.role === "user" ? copy.viewerRoleUser : copy.viewerRoleAssistant}</strong>
        <p>{message.content}</p>
        {message.sourceModelLabel && <small>{copy.viewerSourceModel.replace("{label}", message.sourceModelLabel)}</small>}
        {message.truncated && <small>{copy.viewerTruncatedNotice}</small>}
      </li>)}</ol>
      <div className="account-settings-actions">
        {offset > 0 && <button type="button" className="soft" aria-label="Previous page"
          onClick={() => setOffset(Math.max(0, offset - data.limit))}>‹</button>}
        {offset + data.limit < data.messageTotal && <button type="button" className="soft" onClick={() => setOffset(offset + data.limit)}>{copy.loadMore}</button>}
      </div>
    </>}
  </section>;
}

function Keys({ language }: Common) {
  const state = useSettingsRead(loadKeys);
  const copy = dictionaries[language].externalApi;
  const [form, setForm] = useState<{ id?: string; name: string; cap: string; expiry: string }>();
  const [generated, setGenerated] = useState<string>();
  const [revoke, setRevoke] = useState<{ id: string; name: string }>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!state.data) return <ReadStatus language={language} failed={state.failed} retry={state.reload} />;
  const { keys, enabled, limits } = state.data;
  function run(action: () => Promise<void>) {
    setBusy(true); setFailed(false);
    void action().then(() => state.reload(), () => setFailed(true)).finally(() => setBusy(false));
  }
  const active = keys.filter(key => key.state === "active").length;
  const max = limits?.maxCreditCap ?? 0;
  const cap = form?.cap ? Number(form.cap) : null;
  const invalidCap = cap !== null && (!Number.isSafeInteger(cap) || cap < 1 || cap > max);
  return <div data-testid="native-account-api-keys">
    <h3>{copy.keysTitle}</h3>
    {!enabled && <p>{copy.unavailable}</p>}
    {keys.length === 0 && <p>{copy.noKeys}</p>}
    {keys.map(key => <AccountSettingRow key={key.id} label={key.name}
      description={<><code>{key.keyPrefix}</code> · {key.state === "active" ? copy.stateActive
        : key.state === "expired" ? copy.stateExpired : copy.stateRevoked}</>}>
      {key.state === "active" && <div className="account-settings-actions">
        <button type="button" className="soft" disabled={busy || !enabled || !limits}
          onClick={() => { setForm({ id: key.id, name: key.name, cap: String(key.creditCap ?? ""), expiry: "" }); setRevoke(undefined); }}>
          {copy.rename}
        </button>
        <button type="button" className="soft" disabled={busy}
          onClick={() => { setRevoke(key); setForm(undefined); }}>{copy.revoke}</button>
      </div>}
    </AccountSettingRow>)}
    {revoke && <div className="desktop-setting-section" role="group" aria-label={copy.revoke}>
      <p>{copy.revokeConfirm.replace("{name}", () => revoke.name)}</p>
      <div className="account-settings-actions">
        <button type="button" className="soft" disabled={busy} onClick={() => setRevoke(undefined)}>{copy.cancel}</button>
        <button type="button" className="soft" disabled={busy} onClick={() => run(async () => {
          await window.desktop.accountSettings<"revokeKey">({ action: "revokeKey", id: revoke.id });
          setRevoke(undefined);
        })}>{copy.revoke}</button>
      </div>
    </div>}
    {enabled && limits && !form && !generated && <div className="account-settings-actions">
      <button type="button" className="soft" disabled={busy || active >= limits.maxKeys}
        onClick={() => { setForm({ name: "", cap: "", expiry: "" }); setRevoke(undefined); }}>{copy.newKey}</button>
    </div>}
    {form && limits && <form className="desktop-setting-section account-settings-form" onSubmit={event => {
      event.preventDefault();
      if (busy || !form.name.trim() || invalidCap) return;
      run(async () => {
        if (form.id) {
          await window.desktop.accountSettings<"updateKey">({ action: "updateKey", id: form.id, name: form.name, creditCap: cap });
        } else {
          const created = await window.desktop.accountSettings<"createKey">({ action: "createKey", name: form.name,
            creditCap: cap, expiresInDays: form.expiry ? Number(form.expiry) : null });
          setGenerated(created.key);
        }
        setForm(undefined);
      });
    }}>
      <h3>{form.id ? copy.rename : copy.createTitle}</h3>
      <label>{copy.nameLabel}<input required maxLength={80} value={form.name} disabled={busy}
        onChange={event => setForm({ ...form, name: event.currentTarget.value })} /></label>
      <label>{copy.capLabel}<input type="number" min={1} max={max} step={1} value={form.cap} disabled={busy}
        onChange={event => setForm({ ...form, cap: event.currentTarget.value })} /></label>
      {!form.id && <label>{copy.expiryLabel}<select value={form.expiry} disabled={busy}
        onChange={event => setForm({ ...form, expiry: event.currentTarget.value })}>
        <option value="">{copy.expiryNever}</option>
        {limits.expiryDays.map(days => <option key={days} value={days}>{copy.expiryDays.replace("{days}", String(days))}</option>)}
      </select></label>}
      <div className="account-settings-actions">
        <button type="button" className="soft" disabled={busy} onClick={() => setForm(undefined)}>{copy.cancel}</button>
        <button type="submit" className="primary" disabled={busy || !form.name.trim() || invalidCap}>
          {form.id ? copy.save : copy.createButton}
        </button>
      </div>
    </form>}
    {generated && <section className="desktop-setting-section account-settings-form">
      <h3>{copy.createdTitle}</h3><p>{copy.createdBody}</p>
      <input aria-label={copy.createdTitle} readOnly value={generated} onFocus={event => event.currentTarget.select()} />
      <button className="soft" type="button" onClick={() => setGenerated(undefined)}>{copy.done}</button>
    </section>}
    <ActionStatus language={language} failed={failed} />
  </div>;
}

function Plan({ language }: Common) {
  const state = useSettingsRead(loadUsage);
  const copy = dictionaries[language].auth;
  if (!state.data) return <ReadStatus language={language} failed={state.failed} retry={state.reload} />;
  const format = (value: number | null) => value === null ? "—" : new Intl.NumberFormat(language).format(value);
  const { plan, balances } = state.data;
  return <div data-testid="native-account-plan">
    <AccountSettingRow label={copy.usageAndPlan}><strong>{plan}</strong></AccountSettingRow>
    <AccountSettingRow label={copy.dailyCreditsRemaining}>{format(balances.dailyRemainingCredits)}</AccountSettingRow>
    <AccountSettingRow label={copy.planCreditsRemaining}>{format(balances.planRemainingCredits)}</AccountSettingRow>
    <AccountSettingRow label={copy.purchasedCreditsRemaining}>{format(balances.purchasedRemainingCredits)}</AccountSettingRow>
  </div>;
}

export function LocalPreferences({ language, theme, setLanguage, setTheme }: Common & {
  theme: AccountPreferences["theme"];
  setLanguage(language: Language): void;
  setTheme(theme: AccountPreferences["theme"]): void;
}) {
  const copy = dictionaries[language].auth;
  return <>
    <AccountSettingRow label={<label htmlFor="local-settings-language">{copy.language}</label>}>
      <select id="local-settings-language" value={language} onChange={event => setLanguage(event.currentTarget.value as Language)}>
        {SUPPORTED_LANGUAGES.map(option => <option key={option} value={option} lang={option}>{languageLabel(option)}</option>)}
      </select>
    </AccountSettingRow>
    <AccountSettingRow label={<label htmlFor="local-settings-theme">{copy.theme}</label>}>
      <select id="local-settings-theme" value={theme} onChange={event => setTheme(event.currentTarget.value as AccountPreferences["theme"])}>
        <option value="system">{copy.systemTheme}</option><option value="dark">{copy.darkTheme}</option><option value="light">{copy.lightTheme}</option>
      </select>
    </AccountSettingRow>
  </>;
}

export function LocalMemoryPrivacy({ language, openHistory }: Common & { openHistory(): void }) {
  const copy = desktopPrivacyCopy(language);
  return <section className="desktop-setting-section">
    <h3>{copy.title}</h3>
    <p>{copy.summary}</p>
    <AccountSettingRow label={copy.chat} description={copy.chatMemory}>
      <span>{desktopControlsCopy[language].signIn}</span>
    </AccountSettingRow>
    <AccountSettingRow label={copy.codeMemory} description={copy.codeTransfer}><span>{copy.selectedOnly}</span></AccountSettingRow>
    <AccountSettingRow label={copy.providers} description={copy.providerPolicy}><span /></AccountSettingRow>
    <AccountSettingRow label={copy.localHistory} description={copy.historyDetail}>
      <button className="soft" type="button" onClick={openHistory}>{copy.manageHistory}</button>
    </AccountSettingRow>
  </section>;
}

export function AccountSettings({ tab, language, onApply, onContinue, onOpenImports, onBackToData }: Common & {
  tab: AccountSettingsTab | "imports";
  onApply(settings: AccountPreferences): void;
  onContinue(id: string): Promise<void>;
  onOpenImports(): void;
  onBackToData(): void;
}) {
  switch (tab) {
    case "account": return <Account language={language} />;
    case "preferences": return <Preferences language={language} onApply={onApply} />;
    case "assistants": return <Assistants language={language} />;
    case "ai": return <Memory language={language} />;
    case "data": {
      const copy = dictionaries[language].externalImport;
      return <>
        <AccountSettingRow label={copy.dataTabTitle} description={desktopImportFilePrivacy[language]}>
          <button type="button" className="soft" onClick={onOpenImports}>{copy.dataTabOpen}</button>
        </AccountSettingRow>
        <AccountDataPanel language={language} />
      </>;
    }
    case "imports": return <>
      <button type="button" className="soft" onClick={onBackToData}>{dictionaries[language].settingsNav.backToSettings}</button>
      <ImportedConversations language={language} onContinue={onContinue} />
    </>;
    case "developer": return <Keys language={language} />;
    case "plan": return <Plan language={language} />;
  }
}

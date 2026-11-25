import { useEffect, useState } from "react";
import { getModelFinderCombination } from "../../../../lib/modelFinder";
import { getModel } from "../../../../lib/models";
import type { ChatModel } from "../chat-contract";
import { desktopAccountDataCopy } from "../../../../locales/desktopAccountData";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import { MODEL_FINDER_PRIORITY_IDS, MODEL_FINDER_TASK_IDS } from "../account-settings-contract";
import { AccountSettingRow, dictionaries, useSettingsRead, type Common } from "./settings-shared";

const providerNames: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", xai: "xAI", deepseek: "DeepSeek",
  meta: "Meta", mistral: "Mistral", perplexity: "Perplexity", qwen: "Qwen", fal: "fal", bfl: "Black Forest Labs" };

const loadReviewProviders = () => window.desktop.accountSettings<"reviewProviders">({ action: "reviewProviders" });
const loadModelFinder = () => window.desktop.accountSettings<"modelFinder">({ action: "modelFinder" });

/**
 * The providers a new Easy Review starts with. A server that does not offer the setting
 * answers without the options: the section stays hidden instead of showing an error.
 */
export function ReviewProviderDefaults({ language }: Common) {
  const words = desktopAccountDataCopy[language];
  const state = useSettingsRead(loadReviewProviders);
  // undefined = untouched; null = follow the platform; an array = a personal choice.
  const [draft, setDraft] = useState<string[] | null>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!state.data) return null;
  const data = state.data;
  const max = data.reviewEasyMaxProviders;
  const available = data.reviewEasyProviderOptions;
  const inherited = (data.reviewEasyPlatformProviders ?? []).filter(provider => available.includes(provider)).slice(0, max);
  const stored = data.reviewEasyDefaultProviders === null ? null
    : data.reviewEasyDefaultProviders.filter(provider => available.includes(provider)).slice(0, max);
  const current = draft === undefined ? stored : draft;
  const selected = current ?? inherited;
  const changed = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(stored);
  return <section className="desktop-setting-section" data-testid="native-review-providers">
    <h3>{words.reviewProvidersTitle}</h3>
    <p>{words.reviewProvidersHelp}</p>
    {available.length === 0 ? <p>{words.reviewProvidersNone}</p> : <>
      <AccountSettingRow label={<label htmlFor="review-providers-source">{words.reviewProvidersHelp}</label>}>
        <select id="review-providers-source" value={current === null ? "platform" : "personal"} disabled={busy}
          onChange={event => { setSaved(false); setDraft(event.currentTarget.value === "platform" ? null : inherited); }}>
          <option value="platform">{words.reviewProvidersInherit}</option>
          <option value="personal">{words.reviewProvidersPersonal}</option>
        </select>
      </AccountSettingRow>
      <fieldset disabled={busy || current === null}>
        {available.map(provider => <AccountSettingRow key={provider} label={<label htmlFor={"review-provider-" + provider}>{providerNames[provider] ?? provider}</label>}>
          <input id={"review-provider-" + provider} type="checkbox" checked={selected.includes(provider)}
            disabled={!selected.includes(provider) && selected.length >= max}
            onChange={event => {
              setSaved(false);
              setDraft(event.currentTarget.checked ? [...selected, provider] : selected.filter(item => item !== provider));
            }} />
        </AccountSettingRow>)}
      </fieldset>
      <p>{words.reviewProvidersLimit.replace("{count}", String(max))}</p>
      <div className="account-settings-actions">
        <button type="button" className="primary" data-testid="native-review-providers-save" disabled={busy || !changed || (current !== null && current.length === 0)}
          onClick={() => {
            if (draft === undefined) return;
            setBusy(true); setFailed(false); setSaved(false);
            void (async () => {
              await window.desktop.accountSettings<"saveReviewProviders">({ action: "saveReviewProviders", providers: draft });
              const fresh = await loadReviewProviders();
              setDraft(undefined);
              state.setData(fresh);
              setSaved(true);
            })().catch(() => setFailed(true)).finally(() => setBusy(false));
          }}>{words.reviewProvidersSave}</button>
      </div>
    </>}
    {saved && <p role="status">{words.saved}</p>}
    {failed && <p className="notice" role="alert">{desktopShellCopy[language].actionFailed}</p>}
  </section>;
}

const lookup = (dictionary: unknown, path: string) =>
  path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], dictionary);

/** Model Finder: two questions, a suggested combination, saved as the default for new chats. */
export function ModelFinderPanel({ language }: Common) {
  const copy = dictionaries[language].modelFinder;
  const dictionary = dictionaries[language];
  const state = useSettingsRead(loadModelFinder);
  const [stage, setStage] = useState<"idle" | "tasks" | "priority" | "result">("idle");
  const [tasks, setTasks] = useState<(typeof MODEL_FINDER_TASK_IDS)[number][]>([]);
  const [priority, setPriority] = useState<(typeof MODEL_FINDER_PRIORITY_IDS)[number]>();
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [savedDefault, setSavedDefault] = useState<string>();
  const [models, setModels] = useState<ChatModel[]>([]);
  useEffect(() => {
    let current = true;
    void window.desktop.chatModels().then(rows => { if (current) setModels(rows); }, () => {});
    return () => { current = false; };
  }, []);
  // The live catalogue names a model; the bundled one is only a fallback for an id it does not list.
  const nameOf = (id: string) => models.find(model => model.id === id)?.name ?? getModel(id)?.name ?? id;
  if (!state.data) return null;
  const combo = priority && tasks.length ? getModelFinderCombination({ tasks, priority }) : [];
  const chosen = combo.filter(pick => !excluded.has(pick.modelId));
  const roles = copy.roles as Record<string, string>;
  const save = (values: Parameters<typeof window.desktop.accountSettings<"saveModelFinder">>[0]["values"]) => {
    setBusy(true); setFailed(false);
    void window.desktop.accountSettings<"saveModelFinder">({ action: "saveModelFinder", values })
      .then(result => { setSavedDefault(result.defaultModelId); setStage("idle"); state.reload(); }, () => setFailed(true))
      .finally(() => setBusy(false));
  };
  return <section className="desktop-setting-section" data-testid="native-model-finder">
    <h3>{copy.settingsCtaHeading}</h3>
    <p>{copy.settingsCtaDescription}</p>
    {stage === "idle" && <div className="account-settings-actions">
      <button type="button" className="soft" disabled={busy} onClick={() => { setSavedDefault(undefined); setTasks([]); setPriority(undefined); setExcluded(new Set()); setStage("tasks"); }}>
        {copy.settingsCta}</button>
      <button type="button" className="soft" disabled={busy} onClick={() => save({ mode: "default" })}>{copy.useDefault}</button>
    </div>}
    {stage === "tasks" && <fieldset className="account-settings-form">
      <legend>{copy.tasksTitle}</legend>
      <p>{copy.tasksHint}</p>
      {MODEL_FINDER_TASK_IDS.map(task => <AccountSettingRow key={task} label={<label htmlFor={"finder-task-" + task}>{lookup(copy, "task" + task[0].toUpperCase() + task.slice(1)) as string}</label>}>
        <input id={"finder-task-" + task} type="checkbox" checked={tasks.includes(task)}
          onChange={event => setTasks(event.currentTarget.checked ? [...tasks, task] : tasks.filter(item => item !== task))} />
      </AccountSettingRow>)}
      <div className="account-settings-actions">
        <button type="button" className="soft" onClick={() => setStage("idle")}>{copy.back}</button>
        <button type="button" className="primary" disabled={tasks.length === 0} onClick={() => setStage("priority")}>{copy.next}</button>
      </div>
    </fieldset>}
    {stage === "priority" && <fieldset className="account-settings-form">
      <legend>{copy.priorityTitle}</legend>
      {MODEL_FINDER_PRIORITY_IDS.map(option => <AccountSettingRow key={option} label={<label htmlFor={"finder-priority-" + option}>{lookup(copy, "priority" + option[0].toUpperCase() + option.slice(1)) as string}</label>}>
        <input id={"finder-priority-" + option} type="radio" name="finder-priority" checked={priority === option} onChange={() => setPriority(option)} />
      </AccountSettingRow>)}
      <div className="account-settings-actions">
        <button type="button" className="soft" onClick={() => setStage("tasks")}>{copy.back}</button>
        <button type="button" className="primary" disabled={!priority} onClick={() => { setExcluded(new Set()); setStage("result"); }}>{copy.next}</button>
      </div>
    </fieldset>}
    {stage === "result" && <div data-testid="native-model-finder-result">
      <h4>{copy.resultTitle}</h4>
      <p>{copy.resultDescription}</p>
      {combo.map(pick => <AccountSettingRow key={pick.modelId} label={nameOf(pick.modelId)}
        description={<>{roles[pick.role]} · {lookup(dictionary, pick.reasonKey) as string}</>}>
        <input type="checkbox" aria-label={nameOf(pick.modelId)} checked={!excluded.has(pick.modelId)}
          onChange={event => setExcluded(previous => {
            const next = new Set(previous);
            if (event.currentTarget.checked) next.delete(pick.modelId); else next.add(pick.modelId);
            return next;
          })} />
      </AccountSettingRow>)}
      <p>{copy.saveAsDefaultHint}</p>
      <div className="account-settings-actions">
        <button type="button" className="soft" disabled={busy} onClick={() => setStage("priority")}>{copy.back}</button>
        <button type="button" className="primary" data-testid="native-model-finder-save" disabled={busy || chosen.length === 0 || !priority}
          onClick={() => priority && save({ mode: "complete", tasks, priority, modelIds: chosen.map(pick => pick.modelId) })}>{copy.saveAsDefault}</button>
      </div>
    </div>}
    {savedDefault && <p role="status">{nameOf(savedDefault)} · {desktopAccountDataCopy[language].saved}</p>}
    {failed && <p className="notice" role="alert">{copy.saveFailed}</p>}
    {!failed && busy && <p role="status">{copy.saving}</p>}
  </section>;
}

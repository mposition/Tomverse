import { useState } from "react";
import { anthropicBaseUrl, codingApiBaseUrl } from "../../../../lib/externalApiCodingTools";
import { developerToolsCopy } from "../../../../locales/developerTools";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import type { AccountSettingsResult } from "../account-settings-contract";
import { AccountSettingRow, dictionaries, useSettingsRead, type Common } from "./settings-shared";
import { openDocs } from "./WebViewer";

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);

type KeysData = AccountSettingsResult<"keys">;

function CopyLine({ label, value, testId, language }: Common & { label: string; value: string; testId: string }) {
  const copy = dictionaries[language].externalApi;
  const [copied, setCopied] = useState(false);
  return <AccountSettingRow label={label} description={<code data-testid={testId}>{value}</code>}>
    <button type="button" className="soft" onClick={() => void window.desktop.copyChatText(value).then(() => setCopied(true), () => setCopied(false))}>
      {copied ? copy.copied : copy.copy}
    </button>
  </AccountSettingRow>;
}

/** Key summary, the connection addresses of the two APIs and the in-app guides. */
export function DeveloperOverview({ language, data }: Common & { data: KeysData }) {
  const copy = dictionaries[language].externalApi;
  const tools = developerToolsCopy[language];
  if (!data.enabled || !data.baseUrl) return null;
  const general = { openAi: data.baseUrl, anthropic: anthropicBaseUrl(data.baseUrl) };
  const codingBase = data.codingBaseUrl ?? codingApiBaseUrl(data.baseUrl);
  const coding = { openAi: codingBase, anthropic: anthropicBaseUrl(codingBase) };
  const active = data.keys.filter(key => key.state === "active").length;
  const lastUsed = data.keys.reduce<string | null>((best, key) => key.lastUsedAt && (!best || key.lastUsedAt > best) ? key.lastUsedAt : best, null);
  return <section className="desktop-setting-section" data-testid="native-developer-overview">
    <p data-testid="native-developer-keys-summary">
      {active > 0 ? fill(copy.devKeysActive, { count: active }) : copy.devKeysNone}{" · "}
      {lastUsed ? fill(copy.lastUsed, { date: new Date(lastUsed).toLocaleString(language, { dateStyle: "medium", timeStyle: "short" }) }) : copy.neverUsed}
    </p>
    <h3>{copy.devEndpointsTitle}</h3>
    {([["general", general, copy.apiGeneral], ["coding", coding, copy.apiCoding]] as const).map(([surface, addresses, label]) => <div key={surface}>
      <h4>{label}</h4>
      <CopyLine language={language} label={copy.addrOpenAi} value={addresses.openAi} testId={`native-developer-endpoint-${surface}-openai`} />
      <CopyLine language={language} label={copy.addrAnthropic} value={addresses.anthropic} testId={`native-developer-endpoint-${surface}-anthropic`} />
    </div>)}
    <div className="account-settings-actions">
      <button type="button" className="soft" data-testid="native-developer-docs" onClick={() => void openDocs("developers")}>{tools.reference}</button>
      <button type="button" className="soft" data-testid="native-developer-cli-guide" onClick={() => void openDocs("cli")}>{tools.install}</button>
    </div>
    <p>{tools.limits}</p>
  </section>;
}

/** Recent requests of one key, loaded when the list is opened. */
function KeyRequests({ language, id }: Common & { id: string }) {
  const copy = dictionaries[language].externalApi;
  const state = useSettingsRead(() => window.desktop.accountSettings<"keyUsage">({ action: "keyUsage", id }));
  if (!state.data) return state.failed ? <p className="notice" role="alert">{desktopShellCopy[language].actionFailed}</p> : <p role="status">{copy.loading}</p>;
  if (state.data.requests.length === 0) return <p>{copy.usageEmpty}</p>;
  return <ul data-testid="native-developer-key-usage">{state.data.requests.map(row => <li key={row.requestId}>
    <strong>{row.modelId}</strong> <small>{new Date(row.createdAt).toLocaleString(language)}</small><br />
    <small>
      {row.status === "held" ? copy.usageHeld : <>
        {fill(copy.usageCredits, { credits: row.chargedCredits ?? 0 })}
        {row.usage ? " · " + fill(copy.usageTokens, { input: row.usage.inputTokens, output: row.usage.outputTokens }) : ""}
        {row.outcome && row.outcome !== "completed" ? " · " + row.outcome : ""}
      </>}
      {" · "}{copy.requestId}: {row.requestId}
    </small>
  </li>)}</ul>;
}

/** Credits used, last use and the recent requests of one key. */
export function KeyUsage({ language, keyData }: Common & { keyData: KeysData["keys"][number] }) {
  const copy = dictionaries[language].externalApi;
  const [open, setOpen] = useState(false);
  const used = keyData.creditCap !== null
    ? fill(copy.capUsage, { used: keyData.committedCredits.toLocaleString(language), cap: keyData.creditCap.toLocaleString(language) })
    : fill(copy.noCap, { used: keyData.committedCredits.toLocaleString(language) });
  const last = keyData.lastUsedAt
    ? fill(copy.lastUsed, { date: new Date(keyData.lastUsedAt).toLocaleString(language, { dateStyle: "medium", timeStyle: "short" }) })
    : copy.neverUsed;
  return <div data-testid={"native-developer-key-" + keyData.id}>
    <small>{used} · {last}</small>{" "}
    <button type="button" className="soft" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? copy.usageHide : copy.usageShow}</button>
    {open && <KeyRequests language={language} id={keyData.id} />}
  </div>;
}

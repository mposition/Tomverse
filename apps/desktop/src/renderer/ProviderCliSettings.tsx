import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Language } from "../../../../lib/language";
import { desktopProviderCliCopy } from "../../../../locales/desktopProviderCli";
import { desktopCliAccountCopy } from "../../../../locales/desktopCliAccount";
import { desktopCliProtocolCopy } from "../../../../locales/desktopCliProtocol";
import { cliProviders, cliUsesInstallationFolder, cliUsesReleaseArchive, isCliProtocolProvider, providerClis, supportsIsolatedCliAccount, type CliAccount, type CliPathCheck, type CliPaths, type CliProtocolCheck,
  type CliProvider, type SavedCliPath } from "../code-execution";

type Copy = (typeof desktopProviderCliCopy)[Language];

export function ProviderCliSettings({ language, paths, supportedPaths, provider, goTo, authFixture, protocolCheckAvailable }: {
  language: Language;
  paths: CliPaths;
  supportedPaths: readonly CliProvider[];
  provider?: CliProvider;
  goTo: (next: "list" | CliProvider) => void;
  authFixture: boolean;
  protocolCheckAvailable: boolean;
}) {
  const copy = desktopProviderCliCopy[language];
  const list = useRef<HTMLUListElement>(null);
  const returnTo = useRef<CliProvider | null>(null);
  useLayoutEffect(() => {
    if (provider || !returnTo.current) return;
    list.current?.querySelector<HTMLButtonElement>(`[data-cli-provider="${returnTo.current}"]`)?.focus();
    returnTo.current = null;
  }, [provider]);
  if (provider) return <CliConnection key={provider} provider={provider} saved={paths[provider]} supported={supportedPaths.includes(provider)} copy={copy}
    accountCopy={desktopCliAccountCopy[language]} protocolCopy={desktopCliProtocolCopy[language]}
    authFixture={authFixture} protocolCheckAvailable={protocolCheckAvailable} onBack={() => {
      returnTo.current = provider;
      goTo("list");
    }} />;
  return <section className="settings provider-cli-settings">
    <h2>{copy.heading}</h2>
    <p>{copy.intro}</p>
    <ul className="provider-cli-list" ref={list}>
      {cliProviders.map((id) => {
        const saved = paths[id];
        const name = providerClis[id];
        const action = saved ? copy.change : copy.configure;
        const supported = supportedPaths.includes(id);
        return <li key={id}>
          <span>{name}{id === "deepseek" && ` · ${copy.preview}`}</span>
          <small>{!supported ? copy.unsupportedPlatform : saved ? copy[saved.status] : copy.unconfigured}</small>
          <button className="soft" type="button" data-cli-provider={id} aria-label={`${name} · ${action}`}
            disabled={!supported && !saved} onClick={() => goTo(id)}>{action}</button>
        </li>;
      })}
    </ul>
  </section>;
}

function CliConnection({ provider, saved, supported, copy, accountCopy, protocolCopy, authFixture, protocolCheckAvailable, onBack }: {
  provider: CliProvider;
  saved?: SavedCliPath;
  supported: boolean;
  copy: Copy;
  accountCopy: (typeof desktopCliAccountCopy)[Language];
  protocolCopy: (typeof desktopCliProtocolCopy)[Language];
  authFixture: boolean;
  protocolCheckAvailable: boolean;
  onBack: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const browseButton = useRef<HTMLButtonElement>(null);
  const restoreBrowseFocus = useRef(false);
  useLayoutEffect(() => heading.current?.focus(), []);
  const [path, setPath] = useState(saved?.path ?? "");
  const [pending, setPending] = useState<"browse" | "save" | "remove" | "account" | "guide" | "protocol" | null>(null);
  const [feedback, setFeedback] = useState<CliPathCheck | null>(null);
  const [accountCheck, setAccount] = useState<CliAccount | null>(null);
  const [protocolCheck, setProtocol] = useState<CliProtocolCheck | null>(null);
  const busy = pending !== null;
  useLayoutEffect(() => {
    if (busy || !restoreBrowseFocus.current) return;
    restoreBrowseFocus.current = false;
    browseButton.current?.focus();
  }, [busy]);
  const result = feedback ?? (saved?.path === path ? saved : undefined);
  const fixtureAvailable = supported && authFixture && supportsIsolatedCliAccount(provider);
  const protocolAvailable = supported && protocolCheckAvailable && isCliProtocolProvider(provider);
  const verifiedPath = supported && saved?.status === "pathVerified" && saved.path === path;
  const account = verifiedPath ? accountCheck : null;
  const protocol = verifiedPath ? protocolCheck : null;
  const archive = cliUsesReleaseArchive(provider);
  const installation = cliUsesInstallationFolder(provider);
  const pathLabel = installation ? copy.installationFolder : archive ? copy.releaseArchive : copy.path;
  const pathDetails = provider === "zhipu" ? copy.zCodeInstallationDetails
    : installation ? copy.miniMaxInstallationDetails : archive ? copy.releaseArchiveDetails : copy.details;
  const invalidPath = result?.status === "invalidPath" || result?.status === "fileMissing" ||
    result?.status === "wrongFile" || result?.status === "windowsShim";
  let resultText = result ? copy[result.status] : "";
  if (installation && result?.status === "pathVerified") resultText = copy.installationVerified;
  if ((archive || installation) && (result?.status === "wrongFile" || result?.status === "windowsShim")) resultText = pathDetails;

  function resetChecks() {
    setAccount(null);
    setProtocol(null);
  }

  async function act(operation: NonNullable<typeof pending>, action: () => Promise<void>) {
    setPending(operation);
    try { await action(); }
    catch { setFeedback({ status: "checkFailed" }); }
    finally { setPending(null); }
  }

  function check(event: FormEvent) {
    event.preventDefault();
    if (!supported || busy || !path.trim()) return;
    resetChecks();
    void act("save", async () => {
      const selected = path.trim();
      const result = await window.desktop.saveCliPath({ provider, path: selected });
      setPath(selected);
      setFeedback(result.status === "pathVerified" || result.status === "versionUnverified" ? null : result);
    });
  }

  return <section className="settings provider-cli-settings">
    <h2 ref={heading} tabIndex={-1}>{providerClis[provider]}{provider === "deepseek" && ` · ${copy.preview}`}</h2>
    <p id="provider-cli-path-help">{pathDetails}</p>
    <form className="provider-cli-connection" onSubmit={check}>
      <label htmlFor="provider-cli-path">{pathLabel}</label>
      <input id="provider-cli-path" aria-invalid={invalidPath} aria-describedby="provider-cli-path-help provider-cli-result"
        value={path} maxLength={4096} disabled={busy || !supported} spellCheck={false} onChange={(event) => {
        setPath(event.currentTarget.value);
        setFeedback(null);
        resetChecks();
      }} />
      <div className="provider-cli-actions">
        <button ref={browseButton} className="soft" type="button" disabled={busy || !supported} onClick={() => void act("browse", async () => {
          const chosen = await window.desktop.chooseCliPath(provider).finally(() => { restoreBrowseFocus.current = true; });
          if (chosen === null) return;
          setPath(chosen);
          setFeedback(null);
          resetChecks();
        })}>{copy.browse}</button>
        <button className="primary" type="submit" disabled={busy || !supported || !path.trim()}>{pending === "save" ? copy.checking : copy.check}</button>
        {saved && <button className="soft" type="button" disabled={busy} onClick={() => void act("remove", async () => {
          await window.desktop.removeCliPath(provider);
          setPath("");
          setFeedback(null);
          resetChecks();
        })}>{copy.remove}</button>}
      </div>
      <div className="provider-cli-result" id="provider-cli-result" role="status">
        {!supported ? copy.unsupportedPlatform : result && <>{resultText}
          {result.status === "pathVerified" && ` · ${result.version}`}</>}
      </div>
    </form>
    <dl className="provider-cli-account" aria-live="polite">
      <dt>{accountCopy.account}</dt>
      <dd>{provider === "openai" ? accountCopy.codexApproval : accountCopy[account?.status ?? "accountUnknown"]}
        {provider === "openai" && account && <div>{accountCopy[account.status]}</div>}
      </dd>
      <dt>{accountCopy.billing}</dt>
      <dd>{accountCopy[account?.billingSource ?? "unknown"]}</dd>
    </dl>
    <p>{copy.credentials}</p>
    {fixtureAvailable && <p>{accountCopy.fixture}</p>}
    <div className="provider-cli-actions">
      <button className="soft" type="button" disabled={busy}
        onClick={() => void act("guide", () => window.desktop.openCliAuthGuide(provider))}>{accountCopy.guide}</button>
      {fixtureAvailable && <button className="soft" type="button" disabled={busy || !verifiedPath}
        onClick={() => void act("account", async () => {
          setAccount(null);
          setFeedback(null);
          setAccount(await window.desktop.checkCliAccount(provider));
        })}>{pending === "account" ? copy.checking : accountCopy.check}</button>}
      {protocolAvailable && <button className="soft" type="button" disabled={busy || !verifiedPath}
        onClick={() => void act("protocol", async () => {
          setProtocol(null);
          setFeedback(null);
          setProtocol(await window.desktop.checkCliProtocol(provider));
        })}>{pending === "protocol" ? copy.checking : protocolCopy.check}</button>}
      {(pending === "account" || pending === "protocol") && <button className="soft" type="button" onClick={() => {
        void window.desktop.cancelCliCheck(pending).catch(() => setFeedback({ status: "checkFailed" }));
      }}>{pending === "account" ? accountCopy.cancel : protocolCopy.cancel}</button>}
      <button className="soft" type="button" disabled={busy} onClick={onBack}>{copy.heading}</button>
    </div>
    {protocol && <div className="provider-cli-result">
      <span role="status">{protocolCopy[protocol.status]}</span>
      {protocol.status === "verified" && <>
        <p>{protocolCopy.access}</p>
        {protocol.models !== null && <>
          {!protocol.catalogComplete && <p>{protocolCopy.partial}</p>}
          {protocol.models.length === 0 ? <p>{protocolCopy.empty}</p> : <details className="provider-cli-models">
            <summary>{protocolCopy.catalog} ({protocol.models.length}{protocol.catalogComplete ? "" : "+"})</summary>
            <ul>{protocol.models.map((model) => <li key={model.id}>
              {model.name}{model.efforts.length > 0 && <small>{model.efforts.join(", ")}</small>}
            </li>)}</ul>
          </details>}
        </>}
      </>}
    </div>}
  </section>;
}

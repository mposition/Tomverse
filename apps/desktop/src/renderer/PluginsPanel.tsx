import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Language } from "../../../../lib/language";
import { desktopPluginsCopy } from "../../../../locales/desktopPlugins";
import type { InstalledPluginView, PluginHookLine, PluginPreview, PluginServerLine, PluginsCommand, PluginsNotice, PluginsView } from "../plugins-contract";
import "./plugins.css";

type Copy = (typeof desktopPluginsCopy)[Language];

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));

const noticeText = (copy: Copy, notice: PluginsNotice) => {
  const name = notice.name ?? "";
  switch (notice.code) {
    case "installed": return fill(copy.noticeInstalled, { name });
    case "updated": return fill(copy.noticeUpdated, { name });
    case "up-to-date": return fill(copy.noticeUpToDate, { name });
    case "removed": return fill(copy.noticeRemoved, { name });
    case "marketplace-added": return fill(copy.noticeMarketplaceAdded, { name });
    case "marketplace-updated": return fill(copy.noticeMarketplaceUpdated, { name });
    case "marketplace-removed": return fill(copy.noticeMarketplaceRemoved, { name });
    case "cancelled": return copy.noticeCancelled;
  }
};

function HookList({ hooks, testId }: { hooks: PluginHookLine[]; testId: string }) {
  return <ul>{hooks.map((hook) => <li key={`${hook.event}${hook.matcher}${hook.command}`} data-testid={testId}>
    <div className="plugin-summary"><strong>{hook.event}{hook.matcher ? ` [${hook.matcher}]` : ""}</strong><p><code>{hook.command}</code></p></div>
  </li>)}</ul>;
}

function ServerList({ servers, testId }: { servers: PluginServerLine[]; testId: string }) {
  return <ul>{servers.map((server) => <li key={server.name} data-testid={testId}>
    <div className="plugin-summary"><strong>{server.name}</strong> · <span>{server.transport}</span><p><code>{server.summary}</code></p></div>
  </li>)}</ul>;
}

const names = (list: string[]) => list.join(", ");

const fromText = (copy: Copy, from: InstalledPluginView["from"]) => {
  switch (from.kind) {
    case "folder": return copy.fromFolder;
    case "zip": return copy.fromZip;
    case "zip-url": return copy.fromZipUrl;
    case "npm": return fill(copy.fromNpm, { package: from.package });
    case "marketplace": return fill(copy.fromMarketplace, { marketplace: from.marketplace });
  }
};

/** `name` or `name@1.2.3`; a scope's own @ is kept. */
const splitPackage = (text: string): { package: string; version?: string } => {
  const value = text.trim();
  const at = value.lastIndexOf("@");
  return at > 0 ? { package: value.slice(0, at), version: value.slice(at + 1) } : { package: value };
};

/** What the person confirms: counts, the names, and every command a hook or server would run, in full. */
function PreviewCard({ copy, preview, busy, onAnswer }: { copy: Copy; preview: PluginPreview; busy: boolean; onAnswer: (confirmed: boolean) => void }) {
  const diff = preview.diff;
  const runs = preview.hooks.length + preview.servers.length > 0;
  return <section className="plugin-preview" data-testid="plugin-preview" aria-label={fill(preview.mode === "update" ? copy.previewUpdate : copy.previewInstall, { name: preview.name })}>
    <h4>{fill(preview.mode === "update" ? copy.previewUpdate : copy.previewInstall, { name: preview.name })}</h4>
    <p className="desktop-connector-help">{fill(copy.previewFrom, { from: preview.from })}{preview.version ? ` · ${preview.version}` : ""}{preview.author ? ` · ${preview.author}` : ""}</p>
    {preview.description && <p>{preview.description}</p>}
    <p className="desktop-connector-help">{fill(copy.previewFiles, { files: preview.files, kb: preview.kilobytes })}</p>
    {preview.origin && <p className="desktop-connector-help" data-testid="plugin-preview-origin">
      {fill(preview.origin.kind === "npm" ? copy.previewIntegrity : preview.origin.kind === "git" ? copy.previewCommit : copy.previewSha256, { value: preview.origin.value })}
      {preview.origin.detail ? ` · ${preview.origin.detail}` : ""}
    </p>}
    <p className="desktop-connector-help" data-testid="plugin-preview-approval">{fill(copy.previewApproval, { value: preview.approval })}</p>
    <p data-testid="plugin-preview-counts">{fill(copy.contents, { skills: preview.skills.length, commands: preview.commands.length, agents: preview.agents.length, hooks: preview.hooks.length, servers: preview.servers.length })}</p>
    {preview.skills.length > 0 && <p><strong>{copy.previewSkills}:</strong> {names(preview.skills)}</p>}
    {preview.commands.length > 0 && <p><strong>{copy.previewCommands}:</strong> {names(preview.commands)}</p>}
    {preview.agents.length > 0 && <p><strong>{copy.previewAgents}:</strong> {names(preview.agents)}</p>}
    {runs ? <>
      <p className="notice">{copy.previewRunNote}</p>
      {preview.hooks.length > 0 && <><h5>{copy.previewHooks}</h5><HookList hooks={preview.hooks} testId="plugin-preview-hook" /></>}
      {preview.servers.length > 0 && <><h5>{copy.previewServers}</h5><ServerList servers={preview.servers} testId="plugin-preview-server" /></>}
    </> : <p className="desktop-connector-help">{copy.previewNoRun}</p>}
    {preview.notUsed.length > 0 && <p className="desktop-connector-help">{copy.previewNotUsed}: {names(preview.notUsed)}</p>}
    {preview.issues.map((issue) => <p key={issue} className="desktop-connector-help">{issue}</p>)}
    {diff && <div data-testid="plugin-preview-diff">
      <h5>{copy.previewChanges}</h5>
      {preview.previousVersion !== preview.version && <p>{fill(copy.previewVersion, { from: preview.previousVersion ?? "-", to: preview.version ?? "-" })}</p>}
      {([["skills", diff.skillsAdded, diff.skillsRemoved], ["commands", diff.commandsAdded, diff.commandsRemoved], ["agents", diff.agentsAdded, diff.agentsRemoved]] as const).map(([label, added, removed]) => <div key={label}>
        {added.length > 0 && <p>{copy.changeAdded} ({label}): {names(added)}</p>}
        {removed.length > 0 && <p>{copy.changeRemoved} ({label}): {names(removed)}</p>}
      </div>)}
      {diff.hooksAdded.length > 0 && <><p>{copy.changeAdded}: {copy.previewHooks}</p><HookList hooks={diff.hooksAdded} testId="plugin-diff-hook-added" /></>}
      {diff.hooksRemoved.length > 0 && <><p>{copy.changeRemoved}: {copy.previewHooks}</p><HookList hooks={diff.hooksRemoved} testId="plugin-diff-hook-removed" /></>}
      {diff.serversAdded.length > 0 && <><p>{copy.changeAdded}: {copy.previewServers}</p><ServerList servers={diff.serversAdded} testId="plugin-diff-server-added" /></>}
      {diff.serversRemoved.length > 0 && <><p>{copy.changeRemoved}: {copy.previewServers}</p><ServerList servers={diff.serversRemoved} testId="plugin-diff-server-removed" /></>}
      {diff.serversChanged.map((change) => <p key={change.name} data-testid="plugin-diff-server-changed">{copy.changeChanged}: <strong>{change.name}</strong> <code>{change.from}</code> → <code>{change.to}</code></p>)}
      {diff.needsApproval && <p className="notice">{copy.needsApproval}</p>}
    </div>}
    <div className="plugin-actions">
      <button type="button" className="primary" disabled={busy} data-testid="plugin-confirm" onClick={() => onAnswer(true)}>{preview.mode === "update" ? copy.confirmUpdate : copy.confirmInstall}</button>
      <button type="button" className="soft" disabled={busy} data-testid="plugin-cancel" onClick={() => onAnswer(false)}>{copy.cancel}</button>
    </div>
  </section>;
}

/**
 * Installed plugins (what each holds, on/off for everyone and for this project, update, remove) and the marketplaces they come from
 * (add from a folder or a git address, browse, install). An install or update always shows the preview first; a plugin's hooks and
 * servers are approved separately, in the list of MCP servers and hooks on this computer.
 */
export function PluginsPanel({ language }: { language: Language }) {
  const copy = desktopPluginsCopy[language];
  const [view, setView] = useState<PluginsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [address, setAddress] = useState("");
  const [zipAddress, setZipAddress] = useState("");
  const [npmName, setNpmName] = useState("");
  const alive = useRef(true);

  const run = useCallback(async (command: PluginsCommand) => {
    setBusy(true);
    try {
      const next = await window.desktop.plugins(command);
      if (!alive.current) return;
      setView(next);
      setFailed(false);
      if (command.type === "marketplace-add-git" && !next.error) setAddress("");
      if ((command.type === "preview-zip-url" || command.type === "preview-npm") && !next.error) { setZipAddress(""); setNpmName(""); }
      if (["confirm", "remove", "set-enabled", "set-enabled-here"].includes(command.type)) window.dispatchEvent(new Event("tomverse-plugins-changed"));
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    window.desktop.plugins({ type: "list" }).then((next) => { if (alive.current) setView(next); }, () => { if (alive.current) setFailed(true); });
    return () => { alive.current = false; };
  }, []);

  const submitZipAddress = (event: FormEvent) => {
    event.preventDefault();
    if (zipAddress.trim()) void run({ type: "preview-zip-url", url: zipAddress.trim() });
  };
  const submitNpm = (event: FormEvent) => {
    event.preventDefault();
    const { package: name, version } = splitPackage(npmName);
    if (name) void run({ type: "preview-npm", package: name, ...(version ? { version } : {}) });
  };

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    if (address.trim()) void run({ type: "marketplace-add-git", url: address.trim() });
  };

  return <section className="plugins-panel" aria-label={copy.title} data-testid="plugins">
    <h3>{copy.title}</h3>
    <p className="desktop-connector-help">{copy.intro}</p>
    {failed && <p role="alert" className="notice">{copy.failed}</p>}
    {view?.error && <p role="alert" className="notice" data-testid="plugins-error">{fill(copy.errorPrefix, { detail: view.error })}</p>}
    {view?.notice && <p role="status" className="desktop-connector-help" data-testid="plugins-notice">{noticeText(copy, view.notice)}</p>}
    {busy && <p role="status" className="desktop-connector-help">{copy.working}</p>}
    {view?.preview && <PreviewCard copy={copy} preview={view.preview} busy={busy}
      onAnswer={(confirmed) => void run(confirmed ? { type: "confirm", id: view.preview!.id } : { type: "cancel", id: view.preview!.id })} />}

    <h4>{copy.installedHeading}</h4>
    <div className="plugin-actions">
      <button type="button" className="primary" disabled={busy} data-testid="plugin-install-folder" onClick={() => void run({ type: "preview-folder" })}>{copy.installFolder}</button>
      {view?.sources && <button type="button" className="primary" disabled={busy} data-testid="plugin-install-zip" onClick={() => void run({ type: "preview-zip" })}>{copy.installZip}</button>}
    </div>
    {view?.sources && <>
      <form className="plugin-form" onSubmit={submitZipAddress}>
        <input type="text" value={zipAddress} maxLength={1000} aria-label={copy.zipUrlLabel} placeholder={copy.zipUrlPlaceholder} data-testid="plugin-zip-url" onChange={(event) => setZipAddress(event.currentTarget.value)} />
        <button type="submit" className="soft" disabled={busy || !zipAddress.trim()}>{copy.previewButton}</button>
      </form>
      <form className="plugin-form" onSubmit={submitNpm}>
        <input type="text" value={npmName} maxLength={300} aria-label={copy.npmLabel} placeholder={copy.npmPlaceholder} data-testid="plugin-npm" onChange={(event) => setNpmName(event.currentTarget.value)} />
        <button type="submit" className="soft" disabled={busy || !npmName.trim()}>{copy.previewButton}</button>
      </form>
    </>}
    {view && !view.plugins.length && <p className="desktop-connector-help">{copy.noPlugins}</p>}
    <ul aria-label={copy.installedHeading}>
      {view?.plugins.map((plugin) => <li key={plugin.name} data-testid="plugin-row">
        <div className="plugin-summary">
          <strong>{plugin.name}</strong>{plugin.version ? ` ${plugin.version}` : ""} · <span role="status">{!plugin.enabled ? copy.stateOff : plugin.disabledHere ? copy.stateOffHere : copy.stateOn}</span>
          · <span>{fromText(copy, plugin.from)}</span>
          {plugin.description && <p>{plugin.description}</p>}
          {plugin.readable
            ? <p className="desktop-connector-help" data-testid="plugin-contents">{fill(copy.contents, { skills: plugin.skills.length, commands: plugin.commands.length, agents: plugin.agents.length, hooks: plugin.hooks, servers: plugin.servers })}</p>
            : <p className="desktop-connector-help">{copy.unreadable}</p>}
          {plugin.skills.length + plugin.commands.length + plugin.agents.length > 0 && <p className="desktop-connector-help">{names([...plugin.skills, ...plugin.commands, ...plugin.agents])}</p>}
          {plugin.pending > 0 && <p className="notice" data-testid="plugin-pending">{fill(copy.pending, { count: plugin.pending })}</p>}
          {plugin.modified && <p className="notice">{copy.modified}</p>}
        </div>
        <div className="plugin-actions">
          <button type="button" className="soft" disabled={busy} aria-label={`${plugin.enabled ? copy.turnOff : copy.turnOn}: ${plugin.name}`}
            onClick={() => void run({ type: "set-enabled", name: plugin.name, enabled: !plugin.enabled })}>{plugin.enabled ? copy.turnOff : copy.turnOn}</button>
          {plugin.enabled && view.project && <button type="button" className="soft" disabled={busy} aria-label={`${plugin.disabledHere ? copy.turnOnHere : copy.turnOffHere}: ${plugin.name}`}
            onClick={() => void run({ type: "set-enabled-here", name: plugin.name, enabled: plugin.disabledHere })}>{plugin.disabledHere ? copy.turnOnHere : copy.turnOffHere}</button>}
          <button type="button" className="soft" disabled={busy} aria-label={`${copy.checkUpdate}: ${plugin.name}`}
            onClick={() => void run({ type: "preview-update", name: plugin.name })}>{copy.checkUpdate}</button>
          {removing === plugin.name
            ? <>
              <span role="alert">{fill(copy.removeAsk, { name: plugin.name })}</span>
              <button type="button" className="primary" disabled={busy} aria-label={`${copy.removeYes}: ${plugin.name}`}
                onClick={() => { setRemoving(null); void run({ type: "remove", name: plugin.name }); }}>{copy.removeYes}</button>
              <button type="button" className="soft" onClick={() => setRemoving(null)}>{copy.cancel}</button>
            </>
            : <button type="button" className="soft" disabled={busy} aria-label={`${copy.remove}: ${plugin.name}`} onClick={() => setRemoving(plugin.name)}>{copy.remove}</button>}
        </div>
      </li>)}
    </ul>

    <h4>{copy.marketplacesHeading}</h4>
    {view?.official && <label className="plugin-official" data-testid="plugin-official">
      <input type="checkbox" checked={view.official.enabled} disabled={busy} onChange={(event) => void run({ type: "set-official-marketplace", enabled: event.currentTarget.checked })} />
      {copy.officialLabel}
    </label>}
    {view && !view.marketplaces.length && <p className="desktop-connector-help">{copy.noMarketplaces}</p>}
    <ul aria-label={copy.marketplacesHeading}>
      {view?.marketplaces.map((market) => <li key={market.name} data-testid="plugin-marketplace">
        <div className="plugin-summary">
          <strong>{market.name}</strong>{market.official ? ` · ${copy.officialBadge}` : ""}{market.commit ? ` @${market.commit}` : ""}
          <p className="desktop-connector-help">{market.location}</p>
          {market.problem && <p className="notice">{market.problem}</p>}
          {open[market.name] && <>
            {!market.entries.length && <p className="desktop-connector-help">{copy.marketplaceEmpty}</p>}
            <ul>{market.entries.map((entry) => <li key={entry.name} data-testid="plugin-entry">
              <div className="plugin-summary"><strong>{entry.name}</strong>{entry.version ? ` ${entry.version}` : ""}{entry.description && <p>{entry.description}</p>}</div>
              <div className="plugin-actions">
                {entry.installed ? <span>{copy.entryInstalled}</span> : !entry.supported ? <span>{copy.entryUnsupported}</span>
                  : <button type="button" className="primary" disabled={busy} aria-label={`${copy.install}: ${entry.name}`}
                    onClick={() => void run({ type: "preview-marketplace", marketplace: market.name, plugin: entry.name })}>{copy.install}</button>}
              </div>
            </li>)}</ul>
          </>}
        </div>
        <div className="plugin-actions">
          <button type="button" className="soft" aria-expanded={Boolean(open[market.name])} aria-label={`${open[market.name] ? copy.hideEntries : copy.browse}: ${market.name}`}
            onClick={() => setOpen((current) => ({ ...current, [market.name]: !current[market.name] }))}>{open[market.name] ? copy.hideEntries : copy.browse}</button>
          <button type="button" className="soft" disabled={busy} aria-label={`${copy.refresh}: ${market.name}`} onClick={() => void run({ type: "marketplace-refresh", name: market.name })}>{copy.refresh}</button>
          <button type="button" className="soft" disabled={busy} aria-label={`${copy.removeMarketplace}: ${market.name}`} onClick={() => void run({ type: "marketplace-remove", name: market.name })}>{copy.removeMarketplace}</button>
        </div>
      </li>)}
    </ul>
    <div className="plugin-actions">
      <button type="button" className="soft" disabled={busy} data-testid="plugin-marketplace-folder" onClick={() => void run({ type: "marketplace-add-folder" })}>{copy.addMarketplaceFolder}</button>
    </div>
    <form className="plugin-form" onSubmit={submitAddress}>
      <input type="text" value={address} maxLength={500} aria-label={copy.gitLabel} placeholder={copy.gitPlaceholder} onChange={(event) => setAddress(event.currentTarget.value)} />
      <button type="submit" className="soft" disabled={busy || !address.trim()}>{copy.addGit}</button>
    </form>
  </section>;
}

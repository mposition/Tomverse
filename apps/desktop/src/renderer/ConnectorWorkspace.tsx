import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Plus, Puzzle, RefreshCw, ShieldCheck } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { mcpConnectorCopy } from "../../../../lib/mcpConnectorCopy";
import { mcpProviderSummary } from "../../../../lib/mcpProviderSummary";
import { mcpProvider } from "../../../../lib/mcpProviderCatalog";
import { pluginLogo } from "../../../../lib/mcpConnectorClientContract";
import { PluginScopePicker, initialPluginScopes } from "../../../../components/plugins/PluginScopePicker";
import { desktopConnectorCopy } from "../../../../locales/desktopConnectors";
import type { ConnectorConnection, ConnectorInput, ConnectorInventory, ConnectorServer } from "../connector-contract";
import { serverSignInRefused } from "../connector-oauth-policy";
import { describeConnectorResult, type ConnectorMessage } from "./connector-message";

const logos = import.meta.glob<string>("../../../../public/plugins/providers/*.{png,svg}", {
  eager: true, query: "?url", import: "default",
});

function ServiceLogo({ id, custom }: { id: string; custom: boolean }) {
  const path = custom ? undefined : pluginLogo(id);
  const src = path && logos["../../../../public" + path];
  const [failed, setFailed] = useState(false);
  return <span className="desktop-plugin-logo" aria-hidden="true">
    {src && !failed ? <img src={src} alt="" width={24} height={24} onError={() => setFailed(true)} />
      : <Puzzle size={24} />}
  </span>;
}

type Tab = "all" | "connected" | "approvals";
type Form = { kind: "server"; serverId: string } | { kind: "custom" };
const NEW_CUSTOM = { url: "", name: "", auth: "none" as ConnectorServer["auth"] };

export function ConnectorWorkspace({ language }: { language: Language }) {
  const c = mcpConnectorCopy[language];
  const d = desktopConnectorCopy[language];
  const [inventory, setInventory] = useState<ConnectorInventory>();
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ConnectorMessage>();
  const [form, setForm] = useState<Form>();
  const [credential, setCredential] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [custom, setCustom] = useState(NEW_CUSTOM);
  const [selectedId, setSelectedId] = useState<string>();
  const [checked, setChecked] = useState<string[]>([]);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await window.desktop.connectorInventory();
      if (alive.current) setInventory(next);
      return next;
    } catch {
      if (alive.current) setMessage({ tone: "error", text: c.error });
      return undefined;
    }
  }, [c.error]);
  useEffect(() => {
    alive.current = true;
    void window.desktop.connectorInventory().then((next) => { if (alive.current) setInventory(next); },
      () => { if (alive.current) setMessage({ tone: "error", text: c.error }); });
    return () => { alive.current = false; };
  }, [c.error]);

  async function run(input: ConnectorInput) {
    if (busy) return undefined;
    setBusy(true);
    setMessage(input.action === "oauth" || input.action === "oauthCustom" ? { tone: "status", text: d.oauthWaiting } : undefined);
    const result = await window.desktop.connectorAction(input).catch(() => undefined);
    if (!alive.current) return undefined;
    setMessage(describeConnectorResult(result, language));
    setCredential("");
    const next = await refresh();
    if (alive.current) setBusy(false);
    return result?.kind === "ok" || result?.kind === "connected" ? next ?? inventory : undefined;
  }

  const connections = inventory?.connections.filter(({ status }) => status !== "disconnected") ?? [];
  const connectionOf = (serverId: string) => connections.find((connection) => connection.serverId === serverId);
  const selected = connections.find(({ id }) => id === selectedId);
  const pending = inventory?.invocations.filter(({ state }) => state === "pending") ?? [];
  const needle = query.trim().toLocaleLowerCase(language);
  const servers = inventory?.servers.filter(({ id, name }) =>
    name.toLocaleLowerCase(language).includes(needle) && (tab !== "connected" || connectionOf(id))) ?? [];
  const customVisible = Boolean(inventory?.customEnabled) && tab === "all" && c.custom.toLocaleLowerCase(language).includes(needle);

  const choose = (connection: ConnectorConnection) => {
    setForm(undefined);
    setSelectedId(connection.id);
    setChecked(connection.grants.map(({ name }) => name));
  };
  const openServer = (server: ConnectorServer) => {
    setForm({ kind: "server", serverId: server.id });
    setCredential("");
    setScopes(initialPluginScopes(server));
    setMessage(undefined);
  };
  const openCustom = () => {
    setForm({ kind: "custom" });
    setCustom(NEW_CUSTOM);
    setCredential("");
    setMessage(undefined);
  };

  const formServer = form?.kind === "server" ? inventory?.servers.find(({ id }) => id === form.serverId) : undefined;
  const formAuth = form?.kind === "custom" ? custom.auth : formServer?.auth;
  const scopeServer = formServer?.auth === "oauth" && formServer.scopes ? formServer : undefined;
  const refused = formServer?.auth === "oauth" ? serverSignInRefused(formServer.origin) : null;
  const canSubmit = !busy && !refused && (form?.kind === "custom" ? custom.url.trim() !== "" : Boolean(formServer)) &&
    !(scopeServer && !scopes.length) && !(formAuth === "bearer" && !credential);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form || !canSubmit) return;
    const before = new Set(inventory?.connections.map(({ id }) => id));
    let input: ConnectorInput;
    if (form.kind === "custom") {
      const entry = { url: custom.url.trim(), auth: custom.auth, ...(custom.name.trim() ? { name: custom.name.trim() } : {}) };
      input = custom.auth === "oauth" ? { action: "oauthCustom", custom: { ...entry, auth: "oauth" } }
        : { action: "connectCustom", custom: entry, ...(custom.auth === "bearer" ? { credential } : {}) };
    } else if (formServer?.auth === "oauth") {
      input = { action: "oauth", serverId: form.serverId, ...(scopeServer ? { scopes } : {}) };
    } else {
      input = { action: "connect", serverId: form.serverId, ...(formServer?.auth === "bearer" ? { credential } : {}) };
    }
    const next = await run(input);
    if (!next) return;
    setForm(undefined);
    const made = (form.kind === "server" ? next.connections.find(({ serverId }) => serverId === form.serverId) : undefined)
      ?? next.connections.find(({ id }) => !before.has(id));
    if (made) choose(made);
  }

  const stateOf = (server: ConnectorServer) => {
    const connection = connectionOf(server.id);
    return connection?.status === "connected" ? c.connected : connection ? c.unavailable : c.notConnected;
  };

  return <section className="desktop-plugins" aria-label={c.title} data-testid="desktop-connectors">
    <div className="desktop-plugins-heading">
      <div><h2>{c.title}</h2><p>{c.subtitle}</p></div>
      <div className="desktop-connector-actions">
        <button type="button" className="soft" aria-label={c.refresh} title={c.refresh} disabled={busy}
          onClick={() => { setMessage(undefined); void refresh(); }}><RefreshCw size={15} /></button>
        <button type="button" className="primary" data-testid="desktop-connector-add" disabled={busy || !inventory?.enabled || !inventory.customEnabled}
          onClick={openCustom}><Plus size={15} />{c.add}</button>
      </div>
    </div>
    <p className="desktop-connector-disclosure"><ShieldCheck size={16} aria-hidden="true" />{c.disclosure}</p>
    <div className="desktop-plugins-controls">
      {(["all", "connected", "approvals"] as const).map((key) => <button key={key} type="button" className="soft" aria-pressed={tab === key}
        onClick={() => setTab(key)}>{c[key]}{key === "approvals" && pending.length > 0 ? ` (${pending.length})` : ""}</button>)}
      <input type="search" className="history-search" aria-label={c.search} placeholder={c.search} value={query}
        onChange={(event) => setQuery(event.currentTarget.value)} />
    </div>
    {message && <p role={message.tone === "error" ? "alert" : "status"} className="notice">{message.text}</p>}
    {busy && form && <p role="status" className="notice">{d.confirming}</p>}
    {inventory?.enabled === false && <p className="notice">{c.disabled}</p>}

    {form && <form className="desktop-connector-form" aria-label={c.add} onSubmit={(event) => void submit(event)}>
      <h3>{form.kind === "custom" ? c.custom : formServer?.name}</h3>
      {form.kind === "custom" ? <>
        <label>{c.customUrl}<input data-testid="desktop-connector-url" type="url" inputMode="url" placeholder="https://mcp.example.com/mcp"
          value={custom.url} maxLength={2048} autoComplete="off" required onChange={(event) => setCustom({ ...custom, url: event.currentTarget.value })} /></label>
        <label>{c.customName}<input data-testid="desktop-connector-name" value={custom.name} maxLength={80} autoComplete="off"
          onChange={(event) => setCustom({ ...custom, name: event.currentTarget.value })} /></label>
        <label>{c.customAuth}<select data-testid="desktop-connector-auth" value={custom.auth} onChange={(event) => {
          setCustom({ ...custom, auth: event.currentTarget.value as ConnectorServer["auth"] });
          setCredential("");
        }}>
          <option value="none">{c.authNone}</option><option value="bearer">{c.authBearer}</option><option value="oauth">{c.authOAuth}</option>
        </select></label>
        <p className="desktop-connector-help">{c.customHelp}</p>
      </> : <>
        {formServer && <p className="desktop-connector-help">{formServer.origin}</p>}
        {scopeServer && <PluginScopePicker server={scopeServer} value={scopes} onChange={setScopes} disabled={busy} copy={c}
          className="desktop-connector-scopes" />}
      </>}
      {formAuth === "bearer" && <label>{c.token}<input data-testid="desktop-connector-credential" type="password" value={credential}
        maxLength={4096} autoComplete="off" required onChange={(event) => setCredential(event.currentTarget.value)} /></label>}
      <p>{formAuth === "oauth" ? c.oauthHelp : c.authHelp}</p>
      <p className="desktop-connector-help">{c.sharing}</p>
      {refused && <p role="alert" className="notice">{d.oauthUnsupportedHost.replace("{host}", () => refused)}</p>}
      <div className="desktop-connector-actions">
        <button type="submit" className="primary" data-testid="desktop-connector-submit" disabled={!canSubmit}>{busy ? c.sending : c.connect}</button>
        <button type="button" className="soft" disabled={busy} onClick={() => setForm(undefined)}>{c.cancel}</button>
      </div>
    </form>}

    {tab === "approvals" ? <div className="desktop-connector-approvals">
      {inventory && !inventory.invocations.length && <p className="notice">{c.missing}</p>}
      {inventory?.invocations.map((action) => {
        const connection = inventory.connections.find(({ id }) => id === action.connectionId);
        const origin = inventory.servers.find(({ id }) => id === connection?.serverId)?.origin;
        return <article key={action.id} className="desktop-connector-approval" data-testid="desktop-connector-approval">
          <small>{connection?.name}{origin ? ` · ${origin}` : ""}</small>
          <h3>{action.toolName}</h3>
          <p>{action.state === "unknown" || action.state === "running" ? c.unknown : action.state === "pending" ? c.pending
            : action.state === "completed" ? c.executed : action.state}</p>
          {action.state === "pending" && <>
            <p>{c.outbound}</p>
            <pre>{JSON.stringify(action.arguments, null, 2)}</pre>
            <div className="desktop-connector-actions">
              <button type="button" className="primary" disabled={busy}
                onClick={() => void run({ action: "decide", invocationId: action.id, approve: true })}><Check size={15} />{c.approve}</button>
              <button type="button" className="soft" disabled={busy}
                onClick={() => void run({ action: "decide", invocationId: action.id, approve: false })}>{c.reject}</button>
            </div>
          </>}
          {action.state === "unknown" && <>
            <label><input type="checkbox" checked={Boolean(verified[action.id])}
              onChange={(event) => setVerified({ ...verified, [action.id]: event.currentTarget.checked })} /> {c.verified}</label>
            <div className="desktop-connector-actions">
              <button type="button" className="soft" disabled={busy || !verified[action.id]}
                onClick={() => void run({ action: "confirmOutcome", invocationId: action.id, verifiedOutcome: "completed" })}>{c.verifiedCompleted}</button>
              <button type="button" className="soft" disabled={busy || !verified[action.id]}
                onClick={() => void run({ action: "confirmOutcome", invocationId: action.id, verifiedOutcome: "not_executed" })}>{c.verifiedNotExecuted}</button>
            </div>
          </>}
        </article>;
      })}
    </div> : <>
      {inventory?.enabled && !servers.length && !customVisible && <p className="notice">{needle ? c.missing : tab === "connected" ? c.empty : c.setupNotice}</p>}
      <ul className="desktop-plugin-list">
        {servers.map((server) => {
          const connection = connectionOf(server.id);
          const provider = server.custom ? undefined : mcpProvider(server.id) || mcpProvider(server.name);
          const summary = provider ? mcpProviderSummary(provider, language) : c.customDescription;
          return <li key={server.id} data-testid="desktop-connector-row">
            <ServiceLogo id={server.id} custom={Boolean(server.custom)} />
            <div className="desktop-connector-summary">
              <strong>{server.name}</strong>
              <p>{stateOf(server)}{connection && ` · ${d.toolsAllowed.replace("{granted}", String(connection.grants.length)).replace("{total}", String(connection.catalog.length))}`}</p>
              <p className="desktop-connector-help">{summary}</p>
              <p className="desktop-connector-help">{server.origin}</p>
            </div>
            <button type="button" className="soft" disabled={busy} onClick={() => connection ? choose(connection) : openServer(server)}>
              {connection ? c.manage : c.connect}</button>
          </li>;
        })}
        {customVisible && <li data-testid="desktop-connector-custom">
          <ServiceLogo id="custom" custom />
          <div className="desktop-connector-summary"><strong>{c.custom}</strong><p className="desktop-connector-help">{c.customDescription}</p></div>
          <button type="button" className="soft" disabled={busy} onClick={openCustom}>{c.connect}</button>
        </li>}
      </ul>
    </>}

    {selected && tab !== "approvals" && <section className="desktop-connector-detail" aria-label={c.manage} data-testid="desktop-connector-detail">
      <h3>{selected.name}</h3>
      <p className="desktop-connector-help">{c.sharing}</p>
      {selected.status !== "connected" && <p role="status">{c.expired}</p>}
      {!!selected.scopes?.length && <p className="desktop-connector-help" data-testid="desktop-connector-scopes">{c.grantedScopes}: {selected.scopes.join(", ")}</p>}
      <h4>{c.tools}</h4>
      <p className="desktop-connector-help">{c.permissionNotice}</p>
      <div className="desktop-connector-tools">
        {(selected.status === "connected" ? selected.catalog : []).map((tool) => <label key={tool.name}>
          <input type="checkbox" disabled={busy} checked={checked.includes(tool.name)} onChange={(event) =>
            setChecked(event.currentTarget.checked ? [...checked, tool.name] : checked.filter((name) => name !== tool.name))} />
          <span><strong>{tool.name}</strong><small>{tool.mode === "read" ? c.read : c.confirm}</small></span>
        </label>)}
      </div>
      <div className="desktop-connector-actions">
        <button type="button" className="primary" disabled={busy || selected.status !== "connected"}
          onClick={() => void run({ action: "saveTools", connectionId: selected.id, tools: checked, version: selected.version })}>{c.save}</button>
        <button type="button" className="soft" disabled={busy || !inventory?.enabled} onClick={() => {
          const server = inventory?.servers.find(({ id }) => id === selected.serverId);
          if (server) openServer(server);
        }}>{c.reconnect}</button>
        <button type="button" className="soft" disabled={busy} onClick={() => void run({ action: "disconnect", connectionId: selected.id })
          .then((next) => { if (next) setSelectedId(undefined); })}>{c.disconnect}</button>
      </div>
      <p className="desktop-connector-help">{c.disconnectNotice}</p>
    </section>}
  </section>;
}

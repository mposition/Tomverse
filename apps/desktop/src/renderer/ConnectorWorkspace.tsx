import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Plus, Puzzle, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { mcpConnectorCopy } from "../../../../lib/mcpConnectorCopy";
import { mcpProviderCopy } from "../../../../lib/mcpProviderCopy";
import { mcpProviderSummary } from "../../../../lib/mcpProviderSummary";
import type { McpProvider, McpProviderCategory } from "../../../../lib/mcpProviderCatalog";
import { filterPluginCards, findMcpProvider, pluginCards } from "../../../../lib/mcpProviderBrowse";
import { PluginScopePicker, initialPluginScopes } from "../../../../components/plugins/PluginScopePicker";
import { desktopConnectorCopy } from "../../../../locales/desktopConnectors";
import type { ConnectorConnection, ConnectorInput, ConnectorInventory, ConnectorServer } from "../connector-contract";
import { serverSignInRefused } from "../connector-oauth-policy";
import { pluginLogoUrl, type PluginCatalogView } from "../plugin-catalog-contract";
import { linkViewUrl } from "../web-view-contract";
import { describeConnectorResult, type ConnectorMessage } from "./connector-message";
import { LocalExtensionsPanel } from "./LocalExtensionsPanel";
import { openLink } from "./WebViewer";
import "./connector-workspace.css";

// The catalogue this app was built with, loaded only for a server that does not serve its own (see bundledCatalog.ts).
type Bundled = typeof import("./bundledCatalog");
type BundledLogos = typeof import("./bundledLogos");

function ServiceLogo({ src }: { src: string | undefined }) {
  const [failed, setFailed] = useState<string>();
  return <span className="desktop-plugin-logo" aria-hidden="true">
    {src && failed !== src ? <img src={src} alt="" width={24} height={24} onError={() => setFailed(src)} />
      : <Puzzle size={24} />}
  </span>;
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

// The detail drawer is a modal dialog for the keyboard and for assistive technology: focus moves into it when it opens or its
// content changes, Tab cycles inside it, Esc and the close button dismiss it. It is deliberately not a click-blocking overlay:
// the list stays where it was, and pressing another card's button swaps the drawer's content instead of needing a second click.
function DetailDrawer({ contentKey, labelledBy, closeLabel, closable, onClose, children }: {
  contentKey: string; labelledBy: string; closeLabel: string; closable: boolean; onClose: () => void; children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef({ closable, onClose });
  useEffect(() => { latest.current = { closable, onClose }; });
  useEffect(() => {
    const element = root.current;
    const first = element?.querySelector<HTMLElement>("[data-autofocus]:not([disabled])") ?? element?.querySelector<HTMLElement>(FOCUSABLE) ?? element;
    first?.focus();
  }, [contentKey]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const element = root.current;
      if (!element || event.defaultPrevented) return;
      const active = document.activeElement;
      const inside = Boolean(active && element.contains(active));
      if (event.key === "Escape") {
        if ((inside || active === document.body) && latest.current.closable) { event.preventDefault(); latest.current.onClose(); }
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) { event.preventDefault(); element.focus(); return; }
      // Focus that a pointer click left in the list comes back into the drawer on the next Tab.
      if (!inside) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && (active === first || active === element)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return <div ref={root} className="desktop-drawer" role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1} data-testid="desktop-plugin-drawer">
    <button type="button" className="icon desktop-drawer-close" data-testid="desktop-plugin-drawer-close" aria-label={closeLabel} title={closeLabel}
      disabled={!closable} onClick={onClose}><X size={16} aria-hidden="true" /></button>
    <div className="desktop-drawer-body">{children}</div>
  </div>;
}

type Tab = "all" | "connected" | "approvals";
const TABS = ["all", "connected", "approvals"] as const;
type Form = { kind: "server"; serverId: string } | { kind: "custom" };
const NEW_CUSTOM = { url: "", name: "", auth: "none" as ConnectorServer["auth"] };
const PAGE = 24;

// `lane` is the second-lane slot owned by the shell; it is null while the lane is collapsed, and the menu then moves into the body.
export function ConnectorWorkspace({ language, lane = null }: { language: Language; lane?: HTMLElement | null }) {
  const c = mcpConnectorCopy[language];
  const p = mcpProviderCopy[language];
  const d = desktopConnectorCopy[language];
  const [inventory, setInventory] = useState<ConnectorInventory>();
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<McpProviderCategory | "all">("all");
  const [source, setSource] = useState("all");
  const [limit, setLimit] = useState(PAGE);
  // undefined: not asked yet; null: this server serves no catalogue, so only its own servers are listed.
  const [catalog, setCatalog] = useState<PluginCatalogView | null>();
  const [bundled, setBundled] = useState<Bundled>();
  const [logos, setLogos] = useState<BundledLogos>();
  const [providerId, setProviderId] = useState<string>();
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
  const titleId = useId();
  // The control that opened the drawer last; closing the drawer puts focus back on it (the search box if it is gone).
  const returnTo = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const drawerWasOpen = useRef(false);

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
  // The platform list is read when the screen opens (the main process reuses a copy that is still fresh) and again when the person refreshes.
  // A list already shown stays when a read fails; a first read that fails leaves the server's own list.
  const refreshCatalog = useCallback(() => {
    void window.desktop.pluginCatalog(true).then((next) => { if (alive.current) setCatalog(next); },
      () => { if (alive.current) { setCatalog((held) => held ?? null); setMessage({ tone: "error", text: c.error }); } });
  }, [c.error]);
  useEffect(() => {
    alive.current = true;
    void window.desktop.connectorInventory().then((next) => { if (alive.current) setInventory(next); },
      () => { if (alive.current) setMessage({ tone: "error", text: c.error }); });
    void window.desktop.pluginCatalog(false).then((next) => { if (alive.current) setCatalog(next); },
      () => { if (alive.current) { setCatalog(null); setMessage({ tone: "error", text: c.error }); } });
    return () => { alive.current = false; };
  }, [c.error]);
  // The logos the app carries, loaded with the screen (bundledLogos.ts).
  useEffect(() => { void import("./bundledLogos").then((module) => { if (alive.current) setLogos(module); }); }, []);
  useEffect(() => {
    if (catalog !== null || bundled) return;
    void import("./bundledCatalog").then((module) => { if (alive.current) setBundled(module); });
  }, [catalog, bundled]);

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
  // The web's catalogue from the server; for a server that serves none, the one this app was built with labels that server's own list.
  const providers: readonly McpProvider[] = catalog?.providers ?? bundled?.bundledProviders ?? [];
  const ready = catalog !== undefined && (catalog !== null || bundled !== undefined);
  // The app's own copy of a logo first; the server's file only for a platform the app does not carry (bundledLogos.ts).
  const logoOf = (provider: McpProvider | undefined) => !provider?.logo || !logos ? undefined
    : logos.bundledLogoFile(provider.logo) ?? (catalog ? pluginLogoUrl(provider.id, catalog.revision) : undefined);
  // Cards, their order and the filters are the web page's own (lib/mcpProviderBrowse.ts).
  const cards = ready ? pluginCards({ servers: inventory?.servers ?? [], providers, customEnabled: Boolean(inventory?.customEnabled), customName: c.custom, catalog: Boolean(catalog) }) : [];
  const visibleCards = filterPluginCards(cards, { search: query.trim(), category, source,
    connected: tab === "connected" ? new Set(connections.map(({ serverId }) => serverId)) : undefined });
  const selectedProvider = providerId ? providers.find(({ id }) => id === providerId) : undefined;
  const resetPage = () => setLimit(PAGE);

  // `trigger` is the control the person pressed. Without it the drawer is already open and keeps the control it was opened from.
  const choose = (connection: ConnectorConnection, trigger?: HTMLElement) => {
    if (trigger) returnTo.current = trigger;
    setForm(undefined);
    setProviderId(undefined);
    setSelectedId(connection.id);
    setChecked(connection.grants.map(({ name }) => name));
  };
  const chooseFromLane = (connection: ConnectorConnection, trigger: HTMLElement) => {
    if (tab === "approvals") setTab("all");
    choose(connection, trigger);
  };
  const chooseProvider = (provider: McpProvider, trigger: HTMLElement) => {
    returnTo.current = trigger;
    setForm(undefined);
    setSelectedId(undefined);
    setProviderId(provider.id);
  };
  const openServer = (server: ConnectorServer, trigger?: HTMLElement) => {
    if (trigger) {
      // Started from a card, not from a connection's own detail: cancelling closes the drawer instead of showing an earlier detail.
      returnTo.current = trigger;
      setSelectedId(undefined);
      setProviderId(undefined);
    }
    setForm({ kind: "server", serverId: server.id });
    setCredential("");
    setScopes(initialPluginScopes(server));
    setMessage(undefined);
  };
  const openCustom = (trigger: HTMLElement) => {
    returnTo.current = trigger;
    setSelectedId(undefined);
    setProviderId(undefined);
    setForm({ kind: "custom" });
    setCustom(NEW_CUSTOM);
    setCredential("");
    setMessage(undefined);
  };
  const closeDrawer = () => {
    setForm(undefined);
    setSelectedId(undefined);
    setProviderId(undefined);
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

  const tabButtons = (current: "page" | "pressed") => TABS.map((key) => <button key={key} type="button" data-testid={`desktop-connector-tab-${key}`}
    {...(current === "page" ? { "aria-current": tab === key ? "page" as const : undefined } : { "aria-pressed": tab === key })}
    onClick={() => { setTab(key); resetPage(); }}>{c[key]}{key === "approvals" && pending.length > 0 ? <span className="desktop-plugins-count">{pending.length}</span> : null}</button>);

  const laneMenu = lane && createPortal(<div className="desktop-plugins-lane" data-testid="desktop-connectors-lane">
    <nav aria-label={c.title}><span aria-hidden="true">Tomverse</span>{tabButtons("page")}</nav>
    <div className="desktop-plugins-mine" role="group" aria-label={c.myConnections}>
      <span aria-hidden="true">{c.myConnections}</span>
      {connections.map((connection) => {
        const server = inventory?.servers.find(({ id }) => id === connection.serverId);
        return <button key={connection.id} type="button" data-testid="desktop-connector-mine" disabled={busy}
          aria-current={connection.id === selectedId ? "true" : undefined} title={connection.name} onClick={(event) => chooseFromLane(connection, event.currentTarget)}>
          <ServiceLogo src={logoOf(server?.custom || (!server && (connection.serverId === "custom" || connection.serverId.startsWith("custom-"))) ? undefined : findMcpProvider(providers, connection.serverId))} />
          <span>{connection.name}</span></button>;
      })}
      {inventory && !connections.length && <p>{c.setupNotice}</p>}
    </div>
  </div>, lane);

  // One drawer shows one thing: the connect form, a connection's management, or a platform's details (in that order of precedence).
  const showDetail = tab !== "approvals";
  const drawerKey = form ? (form.kind === "custom" ? "form:custom" : `form:${form.serverId}`)
    : showDetail && selected ? `detail:${selected.id}` : showDetail && selectedProvider ? `provider:${selectedProvider.id}` : undefined;
  useEffect(() => {
    if (drawerWasOpen.current && !drawerKey) {
      const target = returnTo.current;
      (target?.isConnected && !target.matches(":disabled") ? target : searchRef.current)?.focus();
    }
    drawerWasOpen.current = Boolean(drawerKey);
  }, [drawerKey]);
  // Results and errors appear where the person is looking: in the drawer while it is open, above the list otherwise.
  const notices = <>
    {message && <p role={message.tone === "error" ? "alert" : "status"} className="notice">{message.text}</p>}
    {busy && form && <p role="status" className="notice">{d.confirming}</p>}
  </>;

  const formView = form && <form className="desktop-connector-form" aria-labelledby={titleId} onSubmit={(event) => void submit(event)}>
    <h3 id={titleId}>{form.kind === "custom" ? c.custom : formServer?.name}</h3>
    {form.kind === "custom" ? <>
      <label>{c.customUrl}<input data-testid="desktop-connector-url" data-autofocus type="url" inputMode="url" placeholder="https://mcp.example.com/mcp"
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
  </form>;

  const detailView = selected && <div className="desktop-connector-detail" data-testid="desktop-connector-detail">
    <h3 id={titleId}>{selected.name}</h3>
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
  </div>;

  const providerView = selectedProvider && <div className="desktop-connector-detail" data-testid="desktop-provider-detail">
    <h3 id={titleId}>{selectedProvider.name}</h3>
    <p className="desktop-connector-help">{p[selectedProvider.kind]}</p>
    <p>{p[`${selectedProvider.kind}Help`]}</p>
    {selectedProvider.origins.map((origin) => <p className="desktop-connector-help" key={origin}>{origin}</p>)}
    {!!selectedProvider.profiles.length && <p className="desktop-connector-help">{p.profiles}: {selectedProvider.profiles.join(", ")}</p>}
    {linkViewUrl(selectedProvider.docs) && <p><a href={selectedProvider.docs} data-testid="desktop-provider-docs"
      onClick={(event) => { event.preventDefault(); void openLink(selectedProvider.docs).catch(() => {}); }}>{p.docs} ↗</a></p>}
    <p className="desktop-connector-help">{c.sharing}</p>
    <p className="desktop-connector-help">{c.permissionNotice}</p>
  </div>;

  return <section className="desktop-plugins" aria-label={c.title} data-testid="desktop-connectors" data-drawer={drawerKey ? "open" : undefined}>
    {laneMenu}
    <div className="desktop-plugins-heading">
      <div><h2>{c.title}</h2><p>{c.subtitle}</p></div>
      <div className="desktop-connector-actions">
        <button type="button" className="soft" aria-label={c.refresh} title={c.refresh} disabled={busy}
          onClick={() => { setMessage(undefined); void refresh(); refreshCatalog(); }}><RefreshCw size={15} /></button>
        <button type="button" className="primary" data-testid="desktop-connector-add" disabled={busy || !inventory?.enabled || !inventory.customEnabled}
          onClick={(event) => openCustom(event.currentTarget)}><Plus size={15} />{c.add}</button>
      </div>
    </div>
    <div className="desktop-plugins-controls">
      <label className="desktop-plugins-search"><Search size={16} aria-hidden="true" />
        <input ref={searchRef} type="search" aria-label={c.search} placeholder={c.search} value={query} onChange={(event) => { setQuery(event.currentTarget.value); resetPage(); }} /></label>
      {tab !== "approvals" && <select className="desktop-plugins-filter" data-testid="desktop-connector-category" aria-label={p.category} value={category}
        onChange={(event) => { setCategory(event.currentTarget.value as McpProviderCategory | "all"); resetPage(); }}>
        <option value="all">{p.any}</option>
        {Object.entries(p.categories).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select>}
      {tab !== "approvals" && catalog && <select className="desktop-plugins-filter" data-testid="desktop-connector-source" aria-label={p.source} value={source}
        onChange={(event) => { setSource(event.currentTarget.value); resetPage(); }}>
        <option value="all">{p.anySource}</option><option value="openai">Codex</option><option value="claude">Claude Code</option>
      </select>}
      {!lane && <nav className="desktop-plugins-tabs" aria-label={c.title}>{tabButtons("pressed")}</nav>}
    </div>
    <p className="desktop-connector-disclosure"><ShieldCheck size={16} aria-hidden="true" />{c.disclosure}</p>
    {!drawerKey && notices}
    {inventory?.enabled === false && <p className="notice">{c.disabled}</p>}

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
      <div className="desktop-plugins-catalog-heading"><h3>{c[tab]}</h3><span aria-live="polite">{visibleCards.length}</span></div>
      {tab === "all" && catalog && <p className="desktop-connector-help">{p.catalogNotice}</p>}
      {inventory?.enabled && ready && !visibleCards.length && <p className="notice">{query.trim() || category !== "all" || source !== "all" ? c.missing : tab === "connected" ? c.empty : c.setupNotice}</p>}
      <ul className="desktop-plugin-list">
        {visibleCards.slice(0, limit).map((card) => {
          const { server, provider } = card;
          if (server) {
            const connection = connectionOf(server.id);
            // A sign-in the app cannot run says so before the person tries it; the server's own record of the connection is shown as it is.
            const refusedHost = !connection && server.auth === "oauth" ? serverSignInRefused(server.origin) : null;
            return <li key={card.id} data-testid="desktop-connector-row" data-provider={provider?.id ?? card.id}>
              <ServiceLogo src={logoOf(provider)} />
              <div className="desktop-connector-summary">
                <strong>{server.name}</strong>
                <p>{stateOf(server)}{connection && ` · ${d.toolsAllowed.replace("{granted}", String(connection.grants.length)).replace("{total}", String(connection.catalog.length))}`}</p>
                <p className="desktop-connector-help">{provider ? mcpProviderSummary(provider, language) : c.customDescription}</p>
                <p className="desktop-connector-help">{server.origin}</p>
                {refusedHost && <p className="desktop-connector-help" data-testid="desktop-connector-unavailable">{d.oauthUnsupportedHost.replace("{host}", () => refusedHost)}</p>}
              </div>
              <button type="button" className="soft" disabled={busy} onClick={(event) => connection ? choose(connection, event.currentTarget) : openServer(server, event.currentTarget)}>
                {connection ? c.manage : c.connect}</button>
            </li>;
          }
          if (card.id === "custom") {
            const enabled = Boolean(inventory?.customEnabled);
            return <li key="custom" data-testid="desktop-connector-custom">
              <ServiceLogo src={undefined} />
              <div className="desktop-connector-summary"><strong>{c.custom}</strong><p>{enabled ? c.customReady : c.serverSetup}</p><p className="desktop-connector-help">{c.customDescription}</p></div>
              <button type="button" className="soft" disabled={busy || !enabled} onClick={(event) => openCustom(event.currentTarget)}>{c.connect}</button>
            </li>;
          }
          // A platform the web lists that this deployment has no server for: what it is and where its documentation is, as on the web.
          return <li key={card.id} data-testid="desktop-connector-provider" data-provider={card.id}>
            <ServiceLogo src={logoOf(provider)} />
            <div className="desktop-connector-summary">
              <strong>{card.name}</strong>
              <p>{c.serverSetup}</p>
              <p className="desktop-connector-help">{provider ? mcpProviderSummary(provider, language) : ""}</p>
              {provider && <p className="desktop-connector-help">{[p[provider.kind], ...provider.sources.map((name) => name === "openai" ? "Codex" : "Claude Code")].join(" · ")}</p>}
            </div>
            <button type="button" className="soft" disabled={busy || !provider} onClick={(event) => provider && chooseProvider(provider, event.currentTarget)}>{p.details}</button>
          </li>;
        })}
      </ul>
      {visibleCards.length > limit && <button type="button" className="soft" data-testid="desktop-connector-more" onClick={() => setLimit((value) => value + PAGE)}>
        {p.more} ({Math.min(limit, visibleCards.length)}/{visibleCards.length})</button>}
    </>}

    {drawerKey && <DetailDrawer contentKey={drawerKey} labelledBy={titleId} closeLabel={d.closeDetails} closable={!(busy && form)} onClose={closeDrawer}>
      {notices}
      {form ? formView : showDetail && selected ? detailView : providerView}
    </DetailDrawer>}
    <LocalExtensionsPanel language={language} />
  </section>;
}

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Check, Plus, Puzzle, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { ReviewNavigation } from "@/components/chat/ReviewStudioChrome";
import { useModalDialog } from "@/components/useModalDialog";
import { PluginLogo } from "./PluginLogo";
import { mcpConnectorCopy } from "@/lib/mcpConnectorCopy";
import { PLUGIN_PROVIDERS, EMPTY_PLUGIN_INVENTORY, readPluginInventory, type PluginInventory, type PluginServer, type PluginConnection } from "@/lib/mcpConnectorClientContract";
import "@/components/chat/review-studio.css";
import styles from "./pluginWorkspace.module.css";

export function PluginWorkspace() {
  const { lang } = useLanguage(); const c = mcpConnectorCopy[lang]; const router = useRouter();
  const [inventory, setInventory] = useState<PluginInventory>(EMPTY_PLUGIN_INVENTORY);
  const [loading, setLoading] = useState(true), [signInRequired, setSignInRequired] = useState(false);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"all" | "connected" | "approvals">("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [serverId, setServerId] = useState(""); const [credential, setCredential] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const dialog = useRef<HTMLDivElement>(null);
  useModalDialog({ open: adding, dialogRef: dialog, panelRef: dialog, onClose: () => { if (!busy) { setAdding(false); setCredential(""); } } });
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const data = await readPluginInventory(signal);
    setSignInRequired(!data); setInventory(data || EMPTY_PLUGIN_INVENTORY);
  }, []);
  useEffect(() => {
    const oauthParams = new URLSearchParams(window.location.search);
    const oauth = oauthParams.get("oauth"), oauthReason = oauthParams.get("reason");
    const controller = new AbortController();
    void readPluginInventory(controller.signal).then(data => {
      if (!controller.signal.aborted) {
        setSignInRequired(!data); setInventory(data || EMPTY_PLUGIN_INVENTORY);
        if (oauth === "connected") setNotice(c.connected);
        if (oauth === "failed") setError(oauthReason === "sign_in_required" ? c.signIn : oauthReason === "oauth_flow_expired" ? c.expired :
          oauthReason === "oauth_issuer_mismatch" || oauthReason === "connector_disabled" ? c.serverSetup : c.error);
      }
    }).catch(() => { if (!controller.signal.aborted) setError(c.error); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [c.error, c.connected, c.signIn, c.expired, c.serverSetup]);
  const mutate = async (url: string, method: string, body?: unknown) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.code || "request_failed");
      if (result.status === "authorization_required" && typeof result.authorizationUrl === "string") {
        window.location.assign(result.authorizationUrl);
        return;
      }
      if (result.status === "ok") setNotice(c.executed);
      await refresh();
      return result;
    } catch (e) { setError(e instanceof Error && ["outcome_unknown", "previous_outcome_unknown"].includes(e.message) ? c.unknown : c.error); await refresh().catch(() => {}); }
    finally { setBusy(false); setCredential(""); }
  };
  const selected = inventory.connections.find(conn => conn.id === selectedId);
  const choose = (conn: PluginConnection) => { setSelectedId(conn.id); setChecked(conn.grants.map(t => t.name)); };
  const openAdd = (id = "") => { setServerId(id || inventory.servers[0]?.id || ""); setCredential(""); setAdding(true); };
  const chosenServer = inventory.servers.find(s => s.id === serverId);
  const pending = inventory.invocations.filter(i => i.state === "pending");
  const cards: Array<{ id: string; name: string; server?: PluginServer }> = [
    ...inventory.servers.map(server => ({ id: server.id, name: server.name, server })),
    ...PLUGIN_PROVIDERS.filter(p => !inventory.servers.some(s => s.id === p.id || s.name.toLowerCase() === p.name.toLowerCase())).map(p => ({ id: p.id, name: p.name })),
    { id: "custom", name: c.custom },
  ];
  const visibleCards = cards.filter(card => card.name.toLowerCase().includes(search.toLowerCase()) &&
    (tab !== "connected" || inventory.connections.some(conn => conn.serverId === card.id && conn.status !== "disconnected")));
  return <div className={styles.shell} data-testid="plugin-workspace">
    <ReviewNavigation product="plugins" onNewChat={() => router.push(`/chat?lang=${lang}`)}
      sidebar={<div className="p-6"><Link href={`/chat?lang=${lang}`}>Chat</Link></div>} />
    <aside className={styles.sidebar} aria-label={c.title}>
      <span className={styles.eyebrow}>Tomverse</span><h2>{c.title}</h2>
      <nav>{(["all", "connected", "approvals"] as const).map(key => <button key={key} type="button" aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key)}>
        {c[key]}{key === "approvals" && pending.length > 0 ? <span className={styles.count}>{pending.length}</span> : null}</button>)}</nav>
      <p className={styles.eyebrow}>{c.myConnections}</p>
      {inventory.connections.filter(conn => conn.status !== "disconnected").map(conn => <button className={styles.sideConnection} key={conn.id} type="button" onClick={() => choose(conn)}><PluginLogo name={conn.name} /><span>{conn.name}</span></button>)}
      <p className={styles.help}>{c.setupNotice}</p>
    </aside>
    <main className={styles.main}>
      <header className={styles.header}><div><h1>{c.title}</h1><p>{c.subtitle}</p></div>
        <div className={styles.actions}><button type="button" className={styles.iconButton} disabled={busy || loading} onClick={() => { setError(null); void refresh().catch(() => setError(c.error)); }} aria-label={c.refresh}><RefreshCw size={18} /></button>
          <button type="button" className={styles.primary} onClick={() => openAdd()} disabled={!inventory.enabled || signInRequired || busy}><Plus size={18} />{c.add}</button></div></header>
      <div className={styles.toolbar}><label className={styles.search}><Search size={18} aria-hidden="true" /><input aria-label={c.search} placeholder={c.search} value={search} onChange={e => setSearch(e.target.value)} /></label>
        <nav className={styles.mobileTabs} aria-label={c.title}>{(["all", "connected", "approvals"] as const).map(key => <button type="button" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{c[key]}</button>)}</nav></div>
      <p className={styles.disclosure}><ShieldCheck size={20} aria-hidden="true" />{c.disclosure}</p>
      {loading && <p role="status">{c.sending}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {signInRequired && <button className={styles.primary} type="button" onClick={() => void signIn(undefined, { callbackUrl: `/plugins?lang=${lang}` })}>{c.signIn}</button>}
      {!loading && !inventory.enabled && !signInRequired && <p role="status" className={styles.help}>{c.disabled}</p>}
      <div className={styles.columns}>
        <section className={styles.catalog} aria-label={tab === "approvals" ? c.approvals : c.all}>
          <h2>{c[tab]}</h2>
          {tab === "approvals" ? <>
            {inventory.invocations.length === 0 && <p>{c.missing}</p>}
            {inventory.invocations.map(action => <article className={styles.approval} key={action.id} data-testid="plugin-approval">
              <span className={styles.eyebrow}>{inventory.connections.find(conn => conn.id === action.connectionId)?.name}</span>
              <p className={styles.help}>{inventory.servers.find(server => server.id === inventory.connections.find(conn => conn.id === action.connectionId)?.serverId)?.origin}</p>
              <h3>{action.toolName}</h3><p>{action.state === "unknown" || action.state === "running" ? c.unknown : action.state === "pending" ? c.pending : action.state === "completed" ? c.executed : action.state}</p>
              {action.state === "pending" && <><p>{c.outbound}</p><pre>{JSON.stringify(action.arguments, null, 2)}</pre>
                <div className={styles.actions}><button className={styles.primary} type="button" disabled={busy} onClick={() => void mutate(`/api/mcp/invocations/${action.id}`, "POST", { approve: true })}><Check size={16} />{c.approve}</button>
                  <button type="button" disabled={busy} onClick={() => void mutate(`/api/mcp/invocations/${action.id}`, "POST", { approve: false })}>{c.reject}</button></div></>}
              {action.state === "unknown" && <><label><input type="checkbox" checked={Boolean(verified[action.id])} onChange={e => setVerified(old => ({ ...old, [action.id]: e.target.checked }))} /> {c.verified}</label>
                <div className={styles.actions}><button type="button" disabled={busy || !verified[action.id]} onClick={() => void mutate(`/api/mcp/invocations/${action.id}`, "POST", { verifiedOutcome: "completed" })}>{c.verifiedCompleted}</button>
                  <button type="button" disabled={busy || !verified[action.id]} onClick={() => void mutate(`/api/mcp/invocations/${action.id}`, "POST", { verifiedOutcome: "not_executed" })}>{c.verifiedNotExecuted}</button></div></>}
            </article>)}
          </> : <div className={styles.grid}>{visibleCards.map(card => {
            const conn = inventory.connections.find(conn => conn.serverId === card.id && conn.status !== "disconnected");
            return <article key={card.id} className={styles.card} data-testid="plugin-card">
              <div className={styles.identity}><PluginLogo name={card.name} /><h3>{card.name}</h3></div>
              <p className={styles.help}>{card.server?.origin || (card.id === "custom" ? c.customDescription : c.serverSetup)}</p>
              <div className={styles.cardFooter}><span>{conn ? conn.status === "connected" ? c.connected : c.expired : card.server ? c.disconnected : c.serverSetup}</span>
                <button type="button" disabled={busy || !card.server} onClick={() => conn ? choose(conn) : openAdd(card.id)}>{conn ? c.manage : c.connect}</button></div>
            </article>;
          })}</div>}
          {!visibleCards.length && tab !== "approvals" && <p>{tab === "connected" ? c.empty : c.missing}</p>}
        </section>
        <aside className={styles.detail} aria-label={c.manage}>
          {selected ? <><PluginLogo name={selected.name} /><h2>{selected.name}</h2><p className={styles.help}>{c.sharing}</p><h3>{c.tools}</h3><p className={styles.help}>{c.permissionNotice}</p>
            {selected.status !== "connected" && <p role="status">{selected.status === "disconnected" ? c.disconnected : c.expired}</p>}
            <div className={styles.toolList}>{(selected.status === "connected" ? selected.catalog : []).map(tool => <label key={tool.name}><input type="checkbox" disabled={busy} checked={checked.includes(tool.name)} onChange={e => setChecked(old => e.target.checked ? [...old, tool.name] : old.filter(n => n !== tool.name))} /><span><strong>{tool.name}</strong><small>{tool.mode === "read" ? c.read : c.confirm}</small></span></label>)}</div>
            <button className={styles.primary} type="button" disabled={busy || selected.status !== "connected"} onClick={() => void mutate(`/api/mcp/connections/${selected.id}`, "PATCH", { tools: checked, version: selected.version })}>{c.save}</button>
            <button type="button" disabled={busy || !inventory.enabled} onClick={() => openAdd(selected.serverId)}>{c.reconnect}</button>
            <button type="button" disabled={busy} onClick={() => void mutate(`/api/mcp/connections/${selected.id}`, "DELETE")}>{c.disconnect}</button><p className={styles.help}>{c.disconnectNotice}</p>
          </> : <><Puzzle size={28} /><h2>{c.manage}</h2><p>{c.sharing}</p><p className={styles.help}>{c.permissionNotice}</p><p className={styles.help}>{c.disconnectNotice}</p></>}
        </aside>
      </div>
    </main>
    {adding && <div className={styles.backdrop}><div ref={dialog} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="plugin-add-title">
      <div className={styles.header}><h2 id="plugin-add-title">{c.add}</h2><button type="button" disabled={busy} aria-label={c.close} onClick={() => { setAdding(false); setCredential(""); }}><X size={20} /></button></div>
      <form onSubmit={e => { e.preventDefault(); void mutate(chosenServer?.auth === "oauth" ? "/api/mcp/oauth/start" : "/api/mcp/connections", "POST", { serverId, ...(chosenServer?.auth === "bearer" ? { credential } : {}) }).then(result => { if (result) { setAdding(false); setSelectedId(result.connection?.id || result.id); setChecked([]); } }); }}>
        <label>{c.title}<select value={serverId} onChange={e => { setServerId(e.target.value); setCredential(""); }} required>{inventory.servers.map(server => <option value={server.id} key={server.id}>{server.name}</option>)}</select></label>
        {chosenServer && <p className={styles.help}>{chosenServer.origin}</p>}
        {chosenServer?.auth === "bearer" && <label>{c.token}<input data-testid="plugin-credential" type="password" value={credential} onChange={e => setCredential(e.target.value)} maxLength={4096} autoComplete="off" required /></label>}
        <p>{chosenServer?.auth === "oauth" ? c.oauthHelp : c.authHelp}</p><p className={styles.help}>{c.sharing}</p>
        {!inventory.servers.length && <p>{c.setupNotice}</p>}
        <button className={styles.primary} disabled={busy || !chosenServer} type="submit">{busy ? c.sending : c.connect}</button>
      </form>
    </div></div>}
  </div>;
}

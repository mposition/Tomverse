import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Check, Puzzle } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { mcpConnectorCopy } from "../../../../lib/mcpConnectorCopy";
import type { McpProgressState } from "../../../../lib/mcpConnectorProgress";
import { selectedMcpConnection, selectMcpConnection, subscribeMcpSelection } from "../../../../lib/mcpConnectorSelection";
import { desktopConnectorCopy } from "../../../../locales/desktopConnectors";
import type { ConnectorInput, ConnectorInventory } from "../connector-contract";
import { describeConnectorResult, type ConnectorMessage } from "./connector-message";

/** The plugin connection chosen for one conversation (the same tab-local choice the web keeps). */
export function useChatConnector(conversationId: string | undefined) {
  return useSyncExternalStore(subscribeMcpSelection, () => selectedMcpConnection(conversationId) ?? "", () => "") || undefined;
}

/** Composer control: pick one connected plugin to use in this conversation. Hidden when the server offers none. */
export function ChatConnectorPicker({ language, conversationId, disabled, onManage }: {
  language: Language; conversationId: string | undefined; disabled: boolean; onManage: () => void;
}) {
  const c = mcpConnectorCopy[language];
  const [inventory, setInventory] = useState<ConnectorInventory>();
  const selected = useChatConnector(conversationId);
  const apply = useCallback((next: ConnectorInventory) => {
    setInventory(next);
    // A connection that is gone, expired or has no allowed tool is never kept selected.
    const current = selectedMcpConnection(conversationId);
    if (current && !next.connections.some(({ id, status, grants }) => id === current && status === "connected" && grants.length > 0)) {
      selectMcpConnection(conversationId);
    }
  }, [conversationId]);
  useEffect(() => {
    let active = true;
    void window.desktop.connectorInventory().then((next) => { if (active) apply(next); }, () => {});
    return () => { active = false; selectMcpConnection(conversationId); };
  }, [apply, conversationId]);
  if (!inventory?.enabled) return null;
  const usable = inventory.connections.filter(({ status, grants }) => status === "connected" && grants.length > 0);
  const name = usable.find(({ id }) => id === selected)?.name;
  return <details className="model-menu desktop-chat-connector">
    <summary className={selected ? "icon is-active" : "icon"} aria-label={c.select} title={name ? `${c.select}: ${name}` : c.select}
      data-testid="desktop-chat-connector" onClick={() => { void window.desktop.connectorInventory().then(apply, () => {}); }}><Puzzle size={18} /></summary>
    <div className="model-popover">
      <label>{c.title}
        <select aria-label={c.select} data-testid="desktop-chat-connector-select" value={selected ?? ""} disabled={disabled}
          onChange={(event) => selectMcpConnection(conversationId, event.currentTarget.value || undefined)}>
          <option value="">{c.none}</option>
          {usable.map(({ id, name: label }) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <small>{c.sharing}</small>
      <button className="soft" type="button" onClick={onManage}>{c.open}</button>
    </div>
  </details>;
}

/**
 * Under a Chat answer: where the chosen plugin stands in this turn, and the pending actions it
 * asked to run. Nothing is sent to the external service until the user approves it here.
 */
export function ChatConnectorStatus({ language, progress, waiting, sending, onManage, onResolved }: {
  language: Language; progress: McpProgressState | undefined; waiting: boolean; sending: boolean; onManage: () => void; onResolved: () => void;
}) {
  const c = mcpConnectorCopy[language];
  const d = desktopConnectorCopy[language];
  const [inventory, setInventory] = useState<ConnectorInventory>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ConnectorMessage>();
  useEffect(() => {
    if (!waiting || sending) return;
    let active = true;
    void window.desktop.connectorInventory().then((next) => { if (active) setInventory(next); }, () => {});
    return () => { active = false; };
  }, [waiting, sending]);

  const pending = waiting ? inventory?.invocations.filter(({ state }) => state === "pending") ?? [] : [];
  async function decide(input: Extract<ConnectorInput, { action: "decide" }>) {
    if (busy) return;
    setBusy(true);
    const result = await window.desktop.connectorAction(input).catch(() => undefined);
    setMessage(describeConnectorResult(result, language));
    const next = await window.desktop.connectorInventory().catch(() => undefined);
    if (next) {
      setInventory(next);
      if (!next.invocations.some(({ state }) => state === "pending")) onResolved();
    }
    setBusy(false);
  }
  const labels: Record<McpProgressState, string> = {
    searching: c.searchState, reading: c.readState, approval_required: c.approvalState, no_results: c.noResults,
    reauth_required: c.expired, server_error: c.serverError, done: c.done,
  };
  const notice = progress && progress !== "done" ? labels[progress] : undefined;
  if (!notice && !pending.length && !message) return null;
  return <div className="desktop-chat-connector-status">
    {notice && <p role="status" className="notice" data-testid="desktop-connector-progress">
      {notice}{(progress === "approval_required" || progress === "reauth_required") &&
        <> · <button className="soft" type="button" onClick={onManage}>{c.open}</button></>}</p>}
    {pending.length > 0 && <p role="status" className="notice">{d.approvalWaiting}</p>}
    {pending.map((action) => {
      const connection = inventory?.connections.find(({ id }) => id === action.connectionId);
      const origin = inventory?.servers.find(({ id }) => id === connection?.serverId)?.origin;
      return <article key={action.id} className="desktop-connector-approval" data-testid="desktop-chat-approval">
        <small>{connection?.name}{origin ? ` · ${origin}` : ""}</small>
        <h3>{action.toolName}</h3>
        <p>{c.outbound}</p>
        <pre>{JSON.stringify(action.arguments, null, 2)}</pre>
        <div className="desktop-connector-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void decide({ action: "decide", invocationId: action.id, approve: true })}>
            <Check size={15} />{c.approve}</button>
          <button type="button" className="soft" disabled={busy} onClick={() => void decide({ action: "decide", invocationId: action.id, approve: false })}>{c.reject}</button>
        </div>
      </article>;
    })}
    {message && <p role={message.tone === "error" ? "alert" : "status"} className="notice">{message.text}</p>}
  </div>;
}

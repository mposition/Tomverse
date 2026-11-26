import { useCallback, useEffect, useRef, useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopLocalExtensionsCopy } from "../../../../locales/desktopLocalExtensions";
import type { LocalExtensionsCommand, LocalExtensionsView, LocalHook, LocalMcpServer } from "../local-extensions-contract";
import "./local-extensions.css";

/**
 * The MCP servers and hooks on this computer, apart from the account's connectors: yours, and the open project's own, which
 * run only after you approve them here. Approving names the definition's hash, so a definition that changed meanwhile is not approved.
 */
export function LocalExtensionsPanel({ language }: { language: Language }) {
  const copy = desktopLocalExtensionsCopy[language];
  const [view, setView] = useState<LocalExtensionsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, NonNullable<LocalExtensionsView["check"]>>>({});
  const alive = useRef(true);

  const run = useCallback(async (command: LocalExtensionsCommand) => {
    if (command.type === "mcp-check") setChecking(command.id);
    try {
      const next = await window.desktop.localExtensions(command);
      if (!alive.current) return;
      setView(next);
      setFailed(false);
      if (next.check) setChecks((current) => ({ ...current, [next.check!.id]: next.check! }));
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setChecking(null);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    window.desktop.localExtensions({ type: "list" }).then((next) => { if (alive.current) setView(next); }, () => { if (alive.current) setFailed(true); });
    return () => { alive.current = false; };
  }, []);

  const stateLabel = (state: LocalMcpServer["state"] | LocalHook["state"]) => state === "ready" ? copy.stateReady
    : state === "pending_approval" ? copy.statePending : state === "disabled" ? copy.stateDisabled
      : state === "active" ? copy.stateActive : copy.stateUnsupported;
  const checkText = (id: string) => {
    const check = checks[id];
    if (!check) return null;
    return check.state === "connected" ? copy.checkConnected.replace("{count}", String(check.toolCount))
      : check.state === "needs_auth" ? copy.checkNeedsAuth : copy.checkFailed.replace("{detail}", () => check.detail ?? "");
  };

  return <section className="local-extensions" aria-label={copy.title} data-testid="local-extensions">
    <h3>{copy.title}</h3>
    <p className="desktop-connector-help">{copy.intro}</p>
    {failed && <p role="alert" className="notice">{copy.failed}</p>}
    {view && !view.project && <p className="notice">{copy.noProject}</p>}
    {view?.project && <>
      <h4>{copy.mcpHeading}</h4>
      {!view.mcp.length && <p className="desktop-connector-help">{copy.emptyMcp}</p>}
      <ul aria-label={copy.mcpHeading}>
        {view.mcp.map((server) => <li key={`${server.id}-${server.hash}`} data-testid="local-mcp-server">
          <div className="local-extension-summary">
            <strong>{server.name}</strong> · <span>{server.scope === "project" ? copy.scopeProject : copy.scopeUser}</span> · <span role="status">{stateLabel(server.state)}</span>
            <p><code>{server.summary}</code></p>
            {server.state === "pending_approval" && <p className="desktop-connector-help">{copy.approveNote}</p>}
            {checkText(server.id) && <p role="status" className="desktop-connector-help">{checkText(server.id)}</p>}
          </div>
          <div className="local-extension-actions">
            {server.state === "pending_approval" && <button type="button" className="primary" aria-label={`${copy.approve}: ${server.name}`}
              onClick={() => void run({ type: "mcp-approve", id: server.id, hash: server.hash })}>{copy.approve}</button>}
            {(server.state === "ready" || server.state === "disabled") && <button type="button" className="soft"
              aria-label={`${server.state === "ready" ? copy.turnOff : copy.turnOn}: ${server.name}`}
              onClick={() => void run({ type: "mcp-enable", id: server.id, enabled: server.state === "disabled" })}>{server.state === "ready" ? copy.turnOff : copy.turnOn}</button>}
            {server.state === "ready" && <button type="button" className="soft" disabled={checking !== null} aria-label={`${copy.check}: ${server.name}`}
              onClick={() => void run({ type: "mcp-check", id: server.id })}>{checking === server.id ? copy.checking : copy.check}</button>}
          </div>
        </li>)}
      </ul>
      <h4>{copy.hooksHeading}</h4>
      {!view.hooks.length && <p className="desktop-connector-help">{copy.emptyHooks}</p>}
      <ul aria-label={copy.hooksHeading}>
        {view.hooks.map((hook) => <li key={hook.hash} data-testid="local-hook">
          <div className="local-extension-summary">
            <strong>{hook.event}{hook.matcher ? ` [${hook.matcher}]` : ""}</strong> · <span>{hook.scope === "project" ? copy.scopeProject : copy.scopeUser}</span> · <span role="status">{stateLabel(hook.state)}</span>
            <p><code>{hook.command}</code></p>
            <p className="desktop-connector-help">{hook.source}</p>
            {hook.state === "pending_approval" && <p className="desktop-connector-help">{copy.approveNote}</p>}
          </div>
          <div className="local-extension-actions">
            {hook.state === "pending_approval" && <button type="button" className="primary" aria-label={`${copy.approve}: ${hook.event} ${hook.command}`}
              onClick={() => void run({ type: "hook-approve", hash: hook.hash })}>{copy.approve}</button>}
            {hook.state !== "pending_approval" && <button type="button" className="soft" aria-label={`${hook.state === "active" ? copy.turnOff : copy.turnOn}: ${hook.event} ${hook.command}`}
              onClick={() => void run({ type: "hook-enable", hash: hook.hash, enabled: hook.state === "disabled" })}>{hook.state === "active" ? copy.turnOff : copy.turnOn}</button>}
          </div>
        </li>)}
      </ul>
      {view.problems.map((problem) => <p key={problem} className="desktop-connector-help">{problem}</p>)}
    </>}
  </section>;
}

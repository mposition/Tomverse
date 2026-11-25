import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Plus, TextQuote, X } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./code-terminal.css";
import type { Language } from "../../../../lib/language";
import { desktopTerminalCopy } from "../../../../locales/desktopTerminal";
import { MAX_TERMINAL_ATTACHMENT_CHARACTERS, MAX_TERMINALS_PER_TASK, type TerminalInfo, type TerminalListing } from "../terminal-contract";
import { installStyleSheetCompat } from "./terminal-style";

const isListing = (value: unknown): value is TerminalListing =>
  typeof value === "object" && value !== null && "terminals" in value && Array.isArray((value as TerminalListing).terminals);

function cssVariable(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** One shell on screen. The scrollback lives in the app host, so the view is rebuilt from a replay whenever it is shown. */
function TerminalView({ info, onSelection, onProblem }: {
  info: TerminalInfo;
  onSelection: (text: string) => void;
  onProblem: () => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSelection, onProblem });
  useEffect(() => { callbacks.current = { onSelection, onProblem }; });
  const { id, kind } = info;
  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    installStyleSheetCompat();
    const terminal = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
      fontSize: 13, cursorBlink: true, scrollback: 5000, convertEol: false, allowProposedApi: false,
      theme: { background: cssVariable("--canvas", "#101624"), foreground: cssVariable("--text", "#eef2ff"),
        cursor: cssVariable("--focus", "#8aa2ff"), selectionBackground: "rgba(138, 162, 255, 0.35)" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    let replayed = 0;
    let ready = false;
    const queued: Array<{ seq: number; data: string }> = [];
    const unsubscribe = window.desktop.subscribeCodeTerminal((event) => {
      if (event.type !== "output" || event.terminal !== id) return;
      if (!ready) queued.push(event);
      else if (event.seq > replayed) { replayed = event.seq; terminal.write(event.data); }
    });
    void window.desktop.codeTerminal({ type: "attach", terminal: id }).then((replay) => {
      if (replay && typeof replay === "object" && "data" in replay) {
        replayed = replay.seq;
        if (replay.data) terminal.write(replay.data);
      }
      for (const event of queued.splice(0)) if (event.seq > replayed) { replayed = event.seq; terminal.write(event.data); }
      ready = true;
    }, () => callbacks.current.onProblem());
    const input = terminal.onData((data) => {
      void window.desktop.codeTerminal({ type: "input", terminal: id, data }).catch(() => {});
    });
    const selection = terminal.onSelectionChange(() => callbacks.current.onSelection(terminal.getSelection()));
    let lastSize = "";
    const resize = () => {
      try { fit.fit(); } catch { return; }
      const { cols, rows } = terminal;
      const size = cols + "x" + rows;
      if (size === lastSize || cols < 20 || rows < 4) return;
      lastSize = size;
      void window.desktop.codeTerminal({ type: "resize", terminal: id, cols, rows }).catch(() => {});
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    terminal.focus();
    return () => {
      observer.disconnect();
      unsubscribe();
      input.dispose();
      selection.dispose();
      callbacks.current.onSelection("");
      terminal.dispose();
    };
  }, [id, kind]);
  return <div className="code-terminal-screen" ref={slot} data-testid="terminal-screen" />;
}

export function CodeTerminal({ language, task, enabled, onClose, onAddToPrompt }: {
  language: Language;
  /** The open task, or null before one starts. The host picks the folder; the window only names the task. */
  task: string | null;
  enabled: boolean;
  onClose: () => void;
  onAddToPrompt: (text: string) => void;
}) {
  const copy = desktopTerminalCopy[language];
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [selected, setSelected] = useState<string>();
  const [selection, setSelection] = useState("");
  const [message, setMessage] = useState("");
  const opening = useRef(false);
  const shown = enabled && task ? terminals : [];
  const current = shown.find((item) => item.id === selected) ?? shown[0];

  const open = useCallback(async () => {
    if (opening.current || !task) return;
    opening.current = true;
    setMessage("");
    try {
      const created = await window.desktop.codeTerminal({ type: "open", task, cols: 100, rows: 24 });
      if (created && typeof created === "object" && "id" in created) setSelected(created.id);
    } catch (error) {
      setMessage(error instanceof Error && /Close a terminal/.test(error.message) ? copy.limitReached : copy.failed);
    } finally { opening.current = false; }
  }, [task, copy.failed, copy.limitReached]);

  useEffect(() => {
    if (!enabled || !task) return;
    let live = true;
    const unsubscribe = window.desktop.subscribeCodeTerminal((event) => {
      if (event.type === "changed" && event.task === task && live) setTerminals(event.terminals);
    });
    void window.desktop.codeTerminal({ type: "list", task }).then((listing) => {
      if (!live || !isListing(listing)) return;
      setTerminals(listing.terminals);
      // A task with no terminal gets one when the panel is shown; one that already has some keeps them.
      if (listing.enabled && listing.terminals.length === 0) void open();
    }, () => { if (live) setMessage(copy.failed); });
    return () => { live = false; unsubscribe(); };
  }, [enabled, task, open, copy.failed]);

  function sendTerminal(command: Parameters<typeof window.desktop.codeTerminal>[0]) {
    void window.desktop.codeTerminal(command).catch(() => setMessage(copy.failed));
  }
  function addSelection() {
    const text = selection.trim().slice(0, MAX_TERMINAL_ATTACHMENT_CHARACTERS);
    if (!text) return;
    onAddToPrompt(copy.promptHeading + ":\n```\n" + text.replaceAll("```", "'''") + "\n```");
  }

  return <section className="code-terminal" id="code-terminal-panel" aria-label={copy.panel} data-testid="terminal-panel">
    <div className="code-terminal-heading">
      <strong>{copy.title}</strong>
      {enabled && <div role="tablist" className="code-terminal-tabs" aria-label={copy.tabs}>
        {shown.map((item) => <button key={item.id} type="button" role="tab" className="soft" aria-selected={item.id === current?.id}
          tabIndex={item.id === current?.id ? 0 : -1} onClick={() => setSelected(item.id)}>
          {copy.terminalN.replace("{n}", String(item.index))}{item.running ? "" : " ·"}</button>)}
      </div>}
      {enabled && <button type="button" className="icon" aria-label={copy.newTerminal} title={copy.newTerminal}
        disabled={shown.length >= MAX_TERMINALS_PER_TASK} onClick={() => void open()}><Plus size={15} /></button>}
      {enabled && current && <button type="button" className="icon" aria-label={copy.closeTerminal} title={copy.closeTerminal}
        onClick={() => sendTerminal({ type: "close", terminal: current.id })}><X size={15} /></button>}
      <span className="code-terminal-spacer" />
      {enabled && current && <button type="button" className="soft" aria-pressed={current.shared} title={copy.shareDetail}
        onClick={() => sendTerminal({ type: "share", terminal: current.id, shared: !current.shared })}>
        {current.shared ? <Eye size={14} /> : <EyeOff size={14} />} {copy.share}</button>}
      {enabled && current && <button type="button" className="soft" disabled={!selection.trim()}
        title={selection.trim() ? undefined : copy.addSelectionNone} onClick={addSelection}>
        <TextQuote size={14} /> {copy.addSelection}</button>}
      {enabled && <button type="button" className="soft" onClick={() => sendTerminal({ type: "set-enabled", enabled: false })}>{copy.turnOff}</button>}
      <button type="button" className="icon" aria-label={copy.close} title={copy.close} onClick={onClose}><X size={15} /></button>
    </div>
    {!enabled ? <div className="code-terminal-off">
      <strong>{copy.offTitle}</strong>
      <p>{copy.offDetail}</p>
      <button type="button" className="primary" onClick={() => sendTerminal({ type: "set-enabled", enabled: true })}>{copy.turnOn}</button>
    </div> : !task ? <p className="code-terminal-note" role="status">{copy.needTask}</p> : <>
      {current?.kind === "pipe" && <p className="code-terminal-note" role="note">{copy.limited}</p>}
      {current && <TerminalView key={current.id} info={current} onSelection={setSelection} onProblem={() => setMessage(copy.failed)} />}
      {current && !current.running && <p className="code-terminal-note" role="status">
        {copy.exited.replace("{code}", String(current.exitCode ?? "?"))}</p>}
    </>}
    <p className="code-terminal-note" role="alert" hidden={!message}>{message}</p>
  </section>;
}

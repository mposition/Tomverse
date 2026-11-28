import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Copy, CornerUpLeft, Lock, RotateCw, Square, X } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { desktopWebCopy } from "../../../../locales/desktopWeb";
import type { DocSection, WebViewCommand, WebViewState } from "../web-view-contract";
import "./web-view.css";

const groups = [
  ["groupHelp", ["help", "guides"]],
  ["groupPolicies", ["terms", "privacy", "refund"]],
  ["groupPlans", ["pricing", "models"]],
  ["groupDevelopers", ["developers", "cli", "cursor"]],
  ["groupStatus", ["status"]],
] as const satisfies ReadonlyArray<readonly [string, readonly DocSection[]]>;

export function useWebViewState() {
  const [state, setState] = useState<WebViewState | null>(null);
  useEffect(() => {
    const unsubscribe = window.desktop.subscribeWebView(setState);
    void window.desktop.webView({ type: "sync" }).catch(() => {});
    return unsubscribe;
  }, []);
  return state;
}

export function openDocs(section: DocSection) {
  return window.desktop.webView({ type: "open-docs", section });
}

export function openLink(url: string) {
  return window.desktop.webView({ type: "open-link", url });
}

function Address({ state, label }: { state: WebViewState; label: string }) {
  let rest = "";
  try {
    const parsed = new URL(state.url);
    rest = parsed.pathname === "/" && !parsed.search ? "" : parsed.pathname + parsed.search;
  } catch { /* The address is still loading. */ }
  return <output className="web-view-address" aria-label={label} title={state.url}>
    <Lock size={13} aria-hidden="true" /><strong>{state.host}</strong><span>{rest}</span>
  </output>;
}

export function WebViewer({ state, language }: { state: WebViewState; language: Language }) {
  const copy = desktopWebCopy[language];
  const slot = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  const failed = state.failed;
  const docs = state.kind === "docs";
  const send = (command: WebViewCommand) => { void window.desktop.webView(command).catch(() => {}); };
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    heading.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    const update = () => {
      const { x, y, width, height } = element.getBoundingClientRect();
      void window.desktop.webView({ type: "layout", bounds: failed ? null : { x: Math.max(0, x), y: Math.max(0, y), width, height } }).catch(() => {});
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      void window.desktop.webView({ type: "layout", bounds: null }).catch(() => {});
    };
  }, [failed]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const label = docs ? copy.docsTitle : copy.linkTitle;
  return <section className="web-view" aria-label={label} data-testid="desktop-web-view" data-kind={state.kind} onKeyDown={(event) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    send({ type: "close" });
  }}>
    {docs && <nav className="web-view-toc" aria-label={copy.contents}>
      {groups.map(([group, sections]) => <div key={group}>
        <span aria-hidden="true">{copy[group]}</span>
        {sections.map((section) => <button key={section} type="button" data-testid={`desktop-docs-${section}`}
          aria-current={state.section === section ? "page" : undefined} onClick={() => send({ type: "open-docs", section })}>{copy[section]}</button>)}
      </div>)}
    </nav>}
    <div className="web-view-main">
      <div className="web-view-heading">
        <h2 ref={heading} tabIndex={-1}>{label}</h2>
        {state.guide && <span className="web-view-badge">{copy.providerGuide}</span>}
        <button type="button" className="icon" aria-label={copy.close} title={copy.close} data-testid="desktop-web-view-close"
          onClick={() => send({ type: "close" })}><X size={18} /></button>
      </div>
      <div className="web-view-toolbar">
        <button type="button" className="icon" aria-label={copy.back} title={copy.back} disabled={!state.back}
          onClick={() => send({ type: "back" })}><ArrowLeft size={16} /></button>
        <button type="button" className="icon" aria-label={copy.forward} title={copy.forward} disabled={!state.forward}
          onClick={() => send({ type: "forward" })}><ArrowRight size={16} /></button>
        <button type="button" className="icon" aria-label={state.loading ? copy.stop : copy.reload} title={state.loading ? copy.stop : copy.reload}
          onClick={() => send({ type: state.loading ? "stop" : "reload" })}>{state.loading ? <Square size={14} /> : <RotateCw size={16} />}</button>
        {state.canReturn && <button type="button" className="soft" onClick={() => send({ type: "return-to-docs" })}>
          <CornerUpLeft size={15} aria-hidden="true" />{copy.backToDocs}</button>}
        <Address state={state} label={copy.address} />
        <button type="button" className="soft" data-testid="desktop-web-view-copy" disabled={!state.url} onClick={() => {
          void window.desktop.copyChatText(state.url).then(() => setCopied(true), () => {});
        }}>{copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}{copied ? copy.linkCopied : copy.copyLink}</button>
      </div>
      {!docs && <p className="web-view-notice">{copy.externalNotice}</p>}
      <div className="web-view-target" ref={slot}>
        {failed && <div className="web-view-failed" role="alert">
          <p>{copy.failed}</p>
          <button type="button" className="soft" onClick={() => send({ type: "reload" })}>{copy.retry}</button>
        </div>}
      </div>
      <p className="web-view-status" role="status">{state.loading && !failed ? copy.loading : ""}</p>
    </div>
  </section>;
}

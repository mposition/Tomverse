import type { BrowserWindow } from "electron";
import {
  classifyDocsNavigation, classifyLinkNavigation, docPathAllowed, docSectionFor, docsUrl, linkViewUrl, webViewCommand,
  type WebViewKind, type WebViewState,
} from "../web-view-contract";
import { createWebView, type WebViewRaw, type WebViewVerdict } from "./web-view";

type Active = { kind: WebViewKind; view: ReturnType<typeof createWebView>; raw: WebViewRaw };
type Bounds = { x: number; y: number; width: number; height: number } | null;

/**
 * Owns the single in-app web view. The renderer only names a documentation section or a link; the
 * host builds the URL, applies the navigation policy and publishes the state back.
 */
export function createWebViewHost(deps: {
  owner: () => BrowserWindow | null;
  origin: string;
  guideUrls: readonly string[];
  language: () => string;
  publish: (state: WebViewState | null) => void;
}) {
  const context = { origin: deps.origin, guideUrls: deps.guideUrls };
  let active: Active | undefined;
  let layout: Bounds = null;
  let returnTo: string | null = null;
  let watched: BrowserWindow | undefined;

  const decide = (kind: WebViewKind) => (url: string): WebViewVerdict => {
    if (kind === "link") return classifyLinkNavigation(url) === "link" ? "allow" : "block";
    const verdict = classifyDocsNavigation(url, context);
    return verdict === "docs" ? "allow" : verdict === "link" ? "link" : "block";
  };

  function snapshot(): WebViewState | null {
    if (!active) return null;
    const { kind, raw } = active;
    let host = "";
    let section: WebViewState["section"] = null;
    let guide = false;
    try {
      const parsed = new URL(raw.url);
      host = parsed.host;
      if (kind === "docs" && parsed.origin === deps.origin) section = docSectionFor(parsed.pathname);
      else guide = kind === "docs";
    } catch { /* The address is still loading. */ }
    return { kind, url: raw.url, host, section, guide, loading: raw.loading, failed: raw.failed, back: raw.back, forward: raw.forward,
      canReturn: kind === "link" && returnTo !== null };
  }

  function close() {
    const previous = active;
    active = undefined;
    previous?.view.close();
    if (previous) deps.publish(null);
  }

  function open(kind: WebViewKind, target: string) {
    const owner = deps.owner();
    if (!owner || owner.isDestroyed() || decide(kind)(target) !== "allow") throw new Error("This page cannot be opened in the app.");
    if (active?.kind === kind) {
      active.raw = { ...active.raw, url: target, loading: true, failed: false };
      deps.publish(snapshot());
      return void active.view.load(target);
    }
    if (kind === "link" && active?.kind === "docs") returnTo = active.raw.url;
    else if (kind === "docs") returnTo = null;
    const previous = active;
    active = undefined;
    previous?.view.close();
    const created: Active = {
      kind, raw: { url: target, loading: true, failed: false, back: false, forward: false },
      view: createWebView(owner, {
        language: deps.language(),
        decide: decide(kind),
        changed: (raw) => {
          if (active !== created) return;
          created.raw = raw;
          deps.publish(snapshot());
        },
        linkRequested: (url) => { if (active === created && kind === "docs") try { open("link", url); } catch { /* Blocked links stay blocked. */ } },
      }),
    };
    active = created;
    if (watched !== owner) {
      watched = owner;
      owner.once("closed", () => { const current = active; active = undefined; current?.view.close(); });
    }
    created.view.apply({ type: "layout", bounds: layout });
    deps.publish(snapshot());
    void created.view.load(target);
  }

  return {
    run(value: unknown) {
      const command = webViewCommand.parse(value);
      if (command.type === "open-docs") return open("docs", docsUrl(deps.origin, command.section, deps.language()));
      if (command.type === "open-link") {
        const target = linkViewUrl(command.url);
        if (!target) throw new Error("This link cannot be opened in the app.");
        return open(target.origin === deps.origin && docPathAllowed(target.pathname) ? "docs" : "link", target.href);
      }
      if (command.type === "close") { layout = null; return close(); }
      if (command.type === "return-to-docs") {
        const target = returnTo;
        if (target) open("docs", target);
        return;
      }
      if (command.type === "layout") layout = command.bounds;
      active?.view.apply(command);
    },
    /** A provider's CLI sign-in guide, shown in the documentation view. */
    openGuide(url: string) {
      if (!deps.guideUrls.includes(url)) throw new Error("This guide cannot be opened in the app.");
      open("docs", url);
    },
    close,
  };
}

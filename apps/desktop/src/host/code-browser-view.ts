import { randomUUID } from "node:crypto";
import { session, WebContentsView, type BrowserWindow } from "electron";
import { loopbackBrowserUrl, onApprovedSite, type BrowserCommand, type BrowserKind, type BrowserState } from "../browser-contract";
import { allowsSubresource, linkViewUrl } from "../web-view-contract";
import { createBrowserDriver } from "./code-browser-driver";
import { createResolvedHostGate, gatedRequestFilter } from "./resolved-host-gate";

/**
 * One tab of the browser panel, in a session of its own (memory only, dropped with the tab). A local tab is pinned to the origin of
 * the loopback page it was opened with. A web tab (a public https site) takes any such address, but every request waits for the
 * address check of resolved-host-gate.ts, and while the agent holds the tab (`limitHosts`) the page itself may only move within the
 * sites the person approved for it. No preload, no permissions, no downloads, no client certificates, no other windows.
 */
export function createCodeBrowserView(owner: BrowserWindow, target: { kind: BrowserKind; origin: string }, tab: string,
  changed: (state: BrowserState) => void, limitHosts: () => ReadonlySet<string> | null = () => null) {
  const { kind, origin } = target;
  const web = kind === "web";
  const isolated = session.fromPartition("tomverse-code-browser-" + randomUUID(), { cache: false });
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setDevicePermissionHandler(() => false);
  const view = new WebContentsView({
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
  });
  const { webContents } = view;
  let closed = false;
  let url = "";
  let failed = false;
  /** The site a page tried to reach that the agent was not given; the agent's next request says so. */
  let blockedHost: string | null = null;
  const current = (): BrowserState => ({
    tab, kind, url, failed, loading: webContents.isLoadingMainFrame(),
    back: webContents.navigationHistory.canGoBack(), forward: webContents.navigationHistory.canGoForward(),
  });
  const update = () => {
    if (closed || webContents.isDestroyed()) return;
    changed(current());
  };
  // What the agent and the element picker use: the page, its console and its own DevTools session; the panel decides the size.
  const driver = createBrowserDriver(webContents, tab, {
    size: () => view.getVisible() ? view.getBounds() : { width: 0, height: 0 }, failed: () => failed,
  });
  const contentId = webContents.id;
  // A web tab's main frame: a public https address, and while the agent holds the tab one of the sites the person approved for it.
  const mainFrameAllowed = (address: string) => {
    if (!linkViewUrl(address)) return false;
    const limit = limitHosts();
    if (!limit) return true;
    // The same rule as the agent's own navigation: an approved name on the standard port, never another port of it.
    const allowed = onApprovedSite(limit, address);
    if (!allowed) blockedHost = new URL(address).host;
    return allowed;
  };
  const addresses = web ? createResolvedHostGate((host) => isolated.resolveHost(host)) : null;
  const admitWeb = addresses && gatedRequestFilter(addresses, (request) =>
    !closed && (request.resourceType === "mainFrame" ? mainFrameAllowed(request.url) : allowsSubresource(request.url)));
  isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (request, callback) => {
    if (closed || request.webContentsId !== contentId) return callback({ cancel: true });
    if (admitWeb) return admitWeb(request, callback);
    callback({ cancel: !loopbackBrowserUrl(request.url, origin) });
  });
  isolated.on("will-download", (event) => event.preventDefault());
  if (web) webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  webContents.setWindowOpenHandler(({ url: opened }) => {
    // A web page's new window loads in this tab (the agent keeps the tab it works in); a local page gets no other window.
    if (web && !closed && mainFrameAllowed(opened)) queueMicrotask(() => void load(opened));
    return { action: "deny" };
  });
  const guard = (event: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
    if (web) {
      if (event.isMainFrame ? !mainFrameAllowed(event.url) : !allowsSubresource(event.url)) event.preventDefault();
    } else if (!event.isMainFrame || !loopbackBrowserUrl(event.url, origin)) event.preventDefault();
  };
  webContents.on("will-frame-navigate", guard);
  webContents.on("will-redirect", guard);
  webContents.on("did-navigate", (_event, next) => { url = next; update(); });
  webContents.on("did-navigate-in-page", (_event, next, mainFrame) => { if (mainFrame) { url = next; update(); } });
  webContents.on("did-start-loading", () => { failed = false; update(); });
  webContents.on("did-stop-loading", update);
  webContents.on("did-fail-load", (_event, code, _message, _validatedUrl, mainFrame) => {
    if (mainFrame && code !== -3) { failed = true; update(); }
  });
  webContents.on("render-process-gone", () => {
    view.setVisible(false);
    changed({ tab, url, failed: true, loading: false, back: false, forward: false });
  });
  webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F6" && !owner.isDestroyed()) {
      event.preventDefault();
      owner.webContents.focus();
    }
  });
  view.setVisible(false);
  owner.contentView.addChildView(view);

  async function load(address: string) {
    if (closed || webContents.isDestroyed() || (web ? !linkViewUrl(address) : !loopbackBrowserUrl(address, origin))) return;
    url = address;
    blockedHost = null;
    try { await webContents.loadURL(address); } catch { /* Load failure is published through the WebContents events. */ }
  }

  return {
    kind,
    origin,
    driver,
    load,
    /** The site a page tried to move to without the agent having been given it, once; the agent's request that follows reports it. */
    takeBlocked() { const host = blockedHost; blockedHost = null; return host; },
    current: () => closed || webContents.isDestroyed() ? null : current(),
    hide() { if (!closed) view.setVisible(false); },
    shareableUrl() {
      // Sharing a page with Code is for a local development page; a web page reaches the agent only through its own, approved tools.
      if (web || closed || webContents.isDestroyed() || !view.getVisible() || webContents.isLoadingMainFrame() || failed) return null;
      const target = webContents.getURL();
      return loopbackBrowserUrl(target, origin) ? target : null;
    },
    async snapshot(approvedUrl: string) {
      if (this.shareableUrl() !== approvedUrl) return null;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const text: unknown = await Promise.race([
          webContents.executeJavaScript("document.body?.innerText.trim().slice(0, 5500) ?? ''"),
          new Promise<null>((resolve) => { deadline = setTimeout(() => resolve(null), 3_000); }),
        ]);
        return this.shareableUrl() === approvedUrl && typeof text === "string" ? text : null;
      } catch { return null; }
      finally { clearTimeout(deadline); }
    },
    apply(command: Exclude<BrowserCommand, { type: "open" | "close" }>) {
      if (closed || owner.isDestroyed() || webContents.isDestroyed()) return;
      if (command.type === "layout") {
        const bounds = command.bounds;
        const zoom = owner.webContents.getZoomFactor();
        const [width, height] = owner.getContentSize();
        const x = bounds ? Math.min(Math.round(bounds.x * zoom), width) : 0;
        const y = bounds ? Math.min(Math.round(bounds.y * zoom), height) : 0;
        const w = bounds ? Math.min(Math.round(bounds.width * zoom), width - x) : 0;
        const h = bounds ? Math.min(Math.round(bounds.height * zoom), height - y) : 0;
        view.setBounds({ x, y, width: w, height: h });
        view.setVisible(w > 0 && h > 0);
      } else if (command.type === "back" && webContents.navigationHistory.canGoBack()) {
        webContents.navigationHistory.goBack();
      } else if (command.type === "forward" && webContents.navigationHistory.canGoForward()) {
        webContents.navigationHistory.goForward();
      } else if (command.type === "reload") {
        webContents.reload();
      } else if (command.type === "focus" && view.getVisible()) {
        webContents.focus();
      } else if (command.type === "stop") {
        webContents.stop();
      }
    },
    close() {
      closed = true;
      driver.dispose();
      if (!owner.isDestroyed()) owner.contentView.removeChildView(view);
      if (!webContents.isDestroyed()) webContents.close({ waitForBeforeUnload: false });
      addresses?.clear();
      void isolated.clearStorageData().catch(() => {});
    },
  };
}

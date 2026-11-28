import { basename } from "node:path";
import { WebContentsView, type BrowserWindow, type DownloadItem, type HandlerDetails, type WebContents, type WindowOpenHandlerResponse } from "electron";
import {
  loopbackBrowserUrl, onApprovedSite, pinnedNavigationUrl, pinnedSubresourceUrl,
  type BrowserCommand, type BrowserDownload, type BrowserKind, type BrowserState,
} from "../browser-contract";
import { allowsSubresource, linkViewUrl } from "../web-view-contract";
import { createBrowserDriver } from "./code-browser-driver";
import type { BrowserProfileSession, TabPort } from "./code-browser-profile";
import { downloadPlan, popupAddressAllowed, popupMode } from "./code-browser-policy";
import { gatedRequestFilter } from "./resolved-host-gate";

/** What the host gives a tab besides its address: the project's saved data, and the answers only the host knows. */
export type CodeBrowserViewDeps = {
  profile: BrowserProfileSession;
  /** The sites the agent was given for a web tab it holds, or null (the person's tab, a pinned tab). */
  limitHosts(): ReadonlySet<string> | null;
  /** The agent holds this tab: no question, no remembered answer, no second window. */
  agentHolds(): boolean;
  /** Whether a page address is one of Tomverse's own origins (the panel then says the Tomverse account is not signed in here). */
  isTomverse(url: string): boolean;
  /** A page asked for a new tab: the host opens it in the panel, with the same profile and the same address rules. False when it did not. */
  openTab(address: string): boolean;
  downloads: {
    directory(): string;
    /** A test fixture's folder, used where the save dialog would ask; null everywhere else. */
    testDirectory(): string | null;
    title(from: "person" | "agent"): string;
  };
  /** The id of the tab whose page opened this one. */
  opener?: string;
};

/**
 * One tab of the browser panel, in the saved data of its project (see code-browser-profile.ts). A local or private tab is pinned to
 * the origin it was opened with (its page and its redirects; a person types another origin to leave it). What its page loads
 * (requests, WebSocket, frames, images, scripts) may also come from other ports of this computer (local tab) or of its own host
 * (private tab), never from another machine (pinnedSubresourceUrl). A web tab (a public https site) takes any such address, but every request waits for the address check of
 * resolved-host-gate.ts, and while the agent holds the tab (`limitHosts`) the page itself may only move within the sites the person
 * approved for it. No preload, no Tomverse session, no client certificates; a page's new tab or window gets the same rules.
 */
export function createCodeBrowserView(owner: BrowserWindow, target: { kind: BrowserKind; origin: string }, tab: string,
  changed: (state: BrowserState) => void, deps: CodeBrowserViewDeps) {
  const { kind, origin } = target;
  const { profile } = deps;
  const web = kind === "web";
  const view = new WebContentsView({
    webPreferences: { session: profile.session, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: true },
  });
  const { webContents } = view;
  const children = new Set<BrowserWindow>();
  let closed = false;
  let url = "";
  let failed = false;
  let download: BrowserDownload | undefined;
  /** The site a page tried to reach that the agent was not given; the agent's next request says so. */
  let blockedHost: string | null = null;
  const current = (): BrowserState => ({
    tab, kind, url, failed, loading: webContents.isLoadingMainFrame(),
    back: webContents.navigationHistory.canGoBack(), forward: webContents.navigationHistory.canGoForward(),
    ...(deps.opener ? { opener: deps.opener } : {}), ...(deps.isTomverse(url) ? { tomverse: true } : {}), ...(download ? { download } : {}),
  });
  const update = () => {
    if (closed || webContents.isDestroyed()) return;
    changed(current());
  };
  // What the agent and the element picker use: the page, its console and its own DevTools session; the panel decides the size.
  const driver = createBrowserDriver(webContents, tab, {
    size: () => view.getVisible() ? view.getBounds() : { width: 0, height: 0 }, failed: () => failed,
  });
  // A web tab's main frame: a public https address, and while the agent holds the tab one of the sites the person approved for it.
  const mainFrameAllowed = (address: string) => {
    if (!web) return pinnedNavigationUrl(address, origin) !== null;
    if (!linkViewUrl(address)) return false;
    const limit = deps.limitHosts();
    if (!limit) return true;
    // The same rule as the agent's own navigation: an approved name on the standard port, never another port of it.
    const allowed = onApprovedSite(limit, address);
    if (!allowed) blockedHost = new URL(address).host;
    return allowed;
  };
  const admitWeb = web ? gatedRequestFilter(profile.gate, (request) =>
    !closed && (request.resourceType === "mainFrame" ? mainFrameAllowed(request.url) : allowsSubresource(request.url))) : null;

  const port: TabPort = {
    request(request, callback) {
      if (closed) return callback({ cancel: true });
      if (admitWeb) return admitWeb(request, callback);
      // The page stays on its origin; what it loads may also come from other ports of the same computer (local) or host (private).
      callback({ cancel: !(request.resourceType === "mainFrame" ? pinnedNavigationUrl(request.url, origin) : pinnedSubresourceUrl(request.url, origin, kind)) });
    },
    agentHolds: () => !closed && deps.agentHolds(),
    owner: () => closed || owner.isDestroyed() ? null : owner,
    download: (item) => followDownload(item),
  };

  function followDownload(item: DownloadItem) {
    const plan = downloadPlan({ filename: item.getFilename(), downloads: deps.downloads.directory(), agentHolds: deps.agentHolds(),
      testDirectory: deps.downloads.testDirectory() });
    // Without a path set here the system's save dialog asks the person where it goes (cancelling it cancels the download).
    if (plan.savePath) item.setSavePath(plan.savePath);
    else item.setSaveDialogOptions({ title: deps.downloads.title(plan.from), defaultPath: plan.defaultPath });
    let last = 0;
    const publish = (state: BrowserDownload["state"], force = false) => {
      const saved = item.getSavePath();
      download = { name: saved ? basename(saved) : plan.name, state, received: item.getReceivedBytes(), total: item.getTotalBytes() };
      if (force || Date.now() - last > 250) { last = Date.now(); update(); }
    };
    publish("progressing", true);
    item.on("updated", (_event, state) => publish(state === "interrupted" ? "interrupted" : "progressing"));
    item.once("done", (_event, state) => publish(state, true));
  }

  // A page's new tab or window. The agent's tab never gets another window; a window the page asked for with its own features that
  // keeps its opener (a sign-in popup answering through postMessage) is a child window with the same session, sandbox and rules.
  function handleOpen(details: HandlerDetails): WindowOpenHandlerResponse {
    const opened = details.url;
    if (closed) return { action: "deny" };
    const mode = popupMode(details, deps.agentHolds());
    const sameTab = () => { if (mainFrameAllowed(opened)) queueMicrotask(() => void load(opened)); };
    if (mode === "same-tab") { sameTab(); return { action: "deny" }; }
    if (!popupAddressAllowed({ kind, origin }, opened) || !mainFrameAllowed(opened)) return { action: "deny" };
    if (mode === "window") {
      return { action: "allow", overrideBrowserWindowOptions: {
        parent: owner, autoHideMenuBar: true, backgroundColor: "#ffffff",
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, devTools: false },
      } };
    }
    // The panel's new tab, or this tab when the panel has no free one.
    if (!deps.openTab(opened)) sameTab();
    return { action: "deny" };
  }

  const guard = (event: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
    if (web) {
      if (event.isMainFrame ? !mainFrameAllowed(event.url) : !allowsSubresource(event.url)) event.preventDefault();
    } else if (!(event.isMainFrame ? pinnedNavigationUrl(event.url, origin) : pinnedSubresourceUrl(event.url, origin, kind))) event.preventDefault();
  };

  /** The rules of the tab for one of its pages: the tab's own, and every window it opened. */
  function protect(contents: WebContents) {
    const detach = profile.attach(contents, port);
    if (web) contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    contents.setWindowOpenHandler(handleOpen);
    contents.on("will-frame-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("did-create-window", (child) => {
      children.add(child);
      const detachChild = protect(child.webContents);
      child.once("closed", () => { children.delete(child); detachChild(); });
    });
    return detach;
  }
  protect(webContents);
  webContents.on("did-navigate", (_event, next) => { url = next; if (download?.state !== "progressing") download = undefined; update(); });
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
    if (closed || webContents.isDestroyed() || (web ? !linkViewUrl(address) : !pinnedNavigationUrl(address, origin))) return;
    url = address;
    blockedHost = null;
    try { await webContents.loadURL(address); } catch { /* Load failure is published through the WebContents events. */ }
  }

  return {
    kind,
    origin,
    profile,
    driver,
    load,
    /** The site a page tried to move to without the agent having been given it, once; the agent's request that follows reports it. */
    takeBlocked() { const host = blockedHost; blockedHost = null; return host; },
    current: () => closed || webContents.isDestroyed() ? null : current(),
    hide() { if (!closed) view.setVisible(false); },
    /** Reload after the profile's data was cleared, so the page does not keep a sign-in it no longer has. */
    reloadAfterClear() { if (!closed && !webContents.isDestroyed() && url) webContents.reloadIgnoringCache(); },
    shareableUrl() {
      // Sharing a page with Code is for a local development page; a web page reaches the agent only through its own, approved tools.
      if (kind !== "local" || closed || webContents.isDestroyed() || !view.getVisible() || webContents.isLoadingMainFrame() || failed) return null;
      const address = webContents.getURL();
      return loopbackBrowserUrl(address, origin) ? address : null;
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
    apply(command: Exclude<BrowserCommand, { type: "open" | "close" | "clear-data" }>) {
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
      } else if (command.type === "devtools") {
        // The person's button. The agent's tools talk to the page through the debugger session, not through this window.
        const open = webContents.devToolsWebContents;
        if (open && !open.isDestroyed()) open.focus();
        else webContents.openDevTools({ mode: "detach", activate: true });
      }
    },
    close() {
      closed = true;
      driver.dispose();
      for (const child of children) if (!child.isDestroyed()) child.close();
      children.clear();
      if (!owner.isDestroyed()) owner.contentView.removeChildView(view);
      if (!webContents.isDestroyed()) {
        webContents.closeDevTools();
        webContents.close({ waitForBeforeUnload: false });
      }
      // The project's saved data stays; what it holds so far reaches the disk.
      void profile.flush();
    },
  };
}

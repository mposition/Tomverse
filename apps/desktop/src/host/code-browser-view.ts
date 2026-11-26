import { randomUUID } from "node:crypto";
import { session, WebContentsView, type BrowserWindow } from "electron";
import { loopbackBrowserUrl, type BrowserCommand, type BrowserState } from "../browser-contract";
import { createBrowserDriver } from "./code-browser-driver";

export function createCodeBrowserView(owner: BrowserWindow, origin: string, tab: string, changed: (state: BrowserState) => void) {
  const isolated = session.fromPartition("tomverse-code-browser-" + randomUUID(), { cache: false });
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const view = new WebContentsView({
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
  });
  const { webContents } = view;
  let closed = false;
  let url = "";
  let failed = false;
  const current = (): BrowserState => ({
    tab, url, failed, loading: webContents.isLoadingMainFrame(),
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
  isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (request, callback) => {
    callback({ cancel: closed || request.webContentsId !== contentId || !loopbackBrowserUrl(request.url, origin) });
  });
  isolated.on("will-download", (event) => event.preventDefault());
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const guard = (event: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
    if (!event.isMainFrame || !loopbackBrowserUrl(event.url, origin)) event.preventDefault();
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

  return {
    origin,
    driver,
    current: () => closed || webContents.isDestroyed() ? null : current(),
    async load(target: string) {
      if (closed || webContents.isDestroyed() || !loopbackBrowserUrl(target, origin)) return;
      url = target;
      try { await webContents.loadURL(target); } catch { /* Load failure is published through the WebContents events. */ }
    },
    hide() { if (!closed) view.setVisible(false); },
    shareableUrl() {
      if (closed || webContents.isDestroyed() || !view.getVisible() || webContents.isLoadingMainFrame() || failed) return null;
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
      void isolated.clearStorageData().catch(() => {});
    },
  };
}

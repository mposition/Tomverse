import { randomUUID } from "node:crypto";
import { session, WebContentsView, type BrowserWindow } from "electron";
import { allowsSubresource, type WebViewCommand } from "../web-view-contract";

export type WebViewVerdict = "allow" | "link" | "block";
export type WebViewRaw = { url: string; loading: boolean; failed: boolean; back: boolean; forward: boolean };

const acceptLanguages: Record<string, string> = {
  en: "en-US,en", ko: "ko-KR,ko,en", zh: "zh-CN,zh,en", "zh-Hant": "zh-TW,zh,en", fr: "fr-FR,fr,en", de: "de-DE,de,en", es: "es-ES,es,en", pt: "pt-PT,pt,en",
};

/**
 * One isolated page for documentation or an external link. No preload, no shared session, no
 * permissions, no downloads, no new windows; every main-frame navigation goes through `decide`
 * and every other request must be a public https/wss or inline resource.
 */
export function createWebView(owner: BrowserWindow, input: {
  language: string;
  decide: (url: string) => WebViewVerdict;
  changed: (state: WebViewRaw) => void;
  linkRequested: (url: string) => void;
  /** "deny" refuses every window.open instead of loading an allowed target in this view. */
  newWindows?: "deny";
}) {
  const isolated = session.fromPartition("tomverse-web-view-" + randomUUID(), { cache: false });
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setDevicePermissionHandler(() => false);
  isolated.setUserAgent(isolated.getUserAgent(), acceptLanguages[input.language] ?? acceptLanguages.en);
  isolated.on("will-download", (event) => event.preventDefault());
  const view = new WebContentsView({
    webPreferences: {
      session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, devTools: false, spellcheck: false,
    },
  });
  const { webContents } = view;
  let closed = false;
  let url = "";
  let failed = false;
  const update = () => {
    if (closed || webContents.isDestroyed()) return;
    input.changed({
      url, failed, loading: webContents.isLoadingMainFrame(),
      back: webContents.navigationHistory.canGoBack(), forward: webContents.navigationHistory.canGoForward(),
    });
  };
  isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (request, callback) => {
    const cancel = closed || (request.resourceType === "mainFrame" ? input.decide(request.url) !== "allow" : !allowsSubresource(request.url));
    callback({ cancel });
  });
  const load = async (target: string) => {
    if (closed || webContents.isDestroyed() || input.decide(target) !== "allow") return;
    url = target;
    failed = false;
    update();
    try { await webContents.loadURL(target); } catch { /* Load failure is published through the WebContents events. */ }
  };
  const guard = (event: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
    if (!event.isMainFrame) {
      if (!allowsSubresource(event.url)) event.preventDefault();
      return;
    }
    const verdict = input.decide(event.url);
    if (verdict === "allow") return;
    event.preventDefault();
    if (verdict === "link") input.linkRequested(event.url);
  };
  webContents.setWindowOpenHandler(({ url: target }) => {
    if (input.newWindows === "deny") return { action: "deny" };
    const verdict = input.decide(target);
    if (verdict === "allow") queueMicrotask(() => void load(target));
    else if (verdict === "link") input.linkRequested(target);
    return { action: "deny" };
  });
  webContents.on("will-frame-navigate", guard);
  webContents.on("will-redirect", guard);
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  webContents.on("did-navigate", (_event, next) => { url = next; failed = false; update(); });
  webContents.on("did-navigate-in-page", (_event, next, mainFrame) => { if (mainFrame) { url = next; update(); } });
  webContents.on("did-start-loading", () => { failed = false; update(); });
  webContents.on("did-stop-loading", update);
  webContents.on("did-fail-load", (_event, code, _message, _validatedUrl, mainFrame) => {
    if (mainFrame && code !== -3) { failed = true; update(); }
  });
  webContents.on("render-process-gone", () => {
    view.setVisible(false);
    failed = true;
    update();
  });
  view.setVisible(false);
  owner.contentView.addChildView(view);

  return {
    load,
    apply(command: Exclude<WebViewCommand, { type: "open-docs" | "open-link" | "return-to-docs" | "close" }>) {
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
        failed = false;
        if (webContents.getURL()) webContents.reload(); else void load(url);
      } else if (command.type === "stop") {
        webContents.stop();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (!owner.isDestroyed()) owner.contentView.removeChildView(view);
      if (!webContents.isDestroyed()) webContents.close({ waitForBeforeUnload: false });
      void isolated.clearStorageData().catch(() => {});
    },
  };
}

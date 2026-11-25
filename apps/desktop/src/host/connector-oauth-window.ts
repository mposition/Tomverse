import { randomUUID } from "node:crypto";
import { BrowserWindow, session } from "electron";
import { allowsOAuthSubresource, classifyOAuthNavigation } from "../connector-oauth-policy";
import type { ConnectorOAuthEnd } from "./connector-api";
import { createResolvedHostGate, gatedRequestFilter } from "./resolved-host-gate";

const acceptLanguages: Record<string, string> = {
  en: "en-US,en", ko: "ko-KR,ko,en", zh: "zh-CN,zh,en", "zh-Hant": "zh-TW,zh,en", fr: "fr-FR,fr,en", de: "de-DE,de,en", es: "es-ES,es,en", pt: "pt-PT,pt,en",
};
// Matches the server's pending authorization lifetime; a window left open longer could only fail.
const WINDOW_LIFETIME_MS = 600_000;

/**
 * The app-owned window where a provider asks the user to sign in and consent. It uses its own
 * throwaway session (no account cookie, nothing kept), no preload, a sandboxed renderer and no
 * permissions or downloads. Its title always names the host it shows. Tomverse's own callback is
 * recognised and cancelled here: the main process completes it over the account session, so the
 * window never loads a Tomverse page and never holds a Tomverse credential. Every other request
 * must be https/wss to a public-looking name whose resolved addresses are all public at the time
 * of the check (`resolved-host-gate.ts`, which also says what DNS rebinding can still do).
 */
export function openConnectorOAuthWindow(input: {
  owner: BrowserWindow | null;
  url: URL;
  accountOrigin: string;
  language: string;
  title: (host: string) => string;
  signal: AbortSignal;
}): Promise<ConnectorOAuthEnd> {
  return new Promise((resolve) => {
    const isolated = session.fromPartition("tomverse-connector-oauth-" + randomUUID(), { cache: false });
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setDevicePermissionHandler(() => false);
    isolated.setUserAgent(isolated.getUserAgent(), acceptLanguages[input.language] ?? acceptLanguages.en);
    isolated.on("will-download", (event) => event.preventDefault());
    const owner = input.owner && !input.owner.isDestroyed() ? input.owner : undefined;
    const window = new BrowserWindow({
      width: 520, height: 720, minWidth: 380, minHeight: 480, parent: owner, modal: owner !== undefined,
      show: true, autoHideMenuBar: true, minimizable: false, maximizable: false, title: input.title(input.url.host),
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false,
        devTools: false, spellcheck: false },
    });
    window.removeMenu();
    const { webContents } = window;
    let finished = false;
    const addresses = createResolvedHostGate((host) => isolated.resolveHost(host));
    const finish = (end: ConnectorOAuthEnd) => {
      if (finished) return;
      finished = true;
      addresses.clear();
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      resolve(end);
      if (!window.isDestroyed()) window.destroy();
      void isolated.clearStorageData().catch(() => {});
      void isolated.clearCache().catch(() => {});
    };
    const onAbort = () => finish({ kind: "closed" });
    const timer = setTimeout(onAbort, WINDOW_LIFETIME_MS);
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) return onAbort();

    const verdict = (url: string) => {
      const navigation = classifyOAuthNavigation(url, input.accountOrigin);
      if (navigation.kind === "callback" || navigation.kind === "denied") finish(navigation);
      return navigation.kind === "allow";
    };
    isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, gatedRequestFilter(addresses, (request) => !finished &&
      (request.resourceType === "mainFrame" ? verdict(request.url)
        : allowsOAuthSubresource(request.url) && new URL(request.url).origin !== input.accountOrigin)));
    const guard = (event: { url: string; preventDefault(): void }) => { if (!verdict(event.url)) event.preventDefault(); };
    webContents.on("will-frame-navigate", (event) => { if (event.isMainFrame) guard(event); else if (!allowsOAuthSubresource(event.url)) event.preventDefault(); });
    webContents.on("will-redirect", guard);
    webContents.on("will-attach-webview", (event) => event.preventDefault());
    webContents.setWindowOpenHandler(({ url }) => {
      if (verdict(url)) queueMicrotask(() => { if (!finished && !webContents.isDestroyed()) void webContents.loadURL(url).catch(() => {}); });
      return { action: "deny" };
    });
    // The page cannot rename the window: the host in the title bar is the one currently shown.
    window.on("page-title-updated", (event) => event.preventDefault());
    const showHost = (_event: unknown, url: string) => {
      if (finished || window.isDestroyed()) return;
      try { window.setTitle(input.title(new URL(url).host)); } catch { /* The title keeps the previous host. */ }
    };
    webContents.on("did-navigate", showHost);
    webContents.on("did-navigate-in-page", showHost);
    webContents.on("render-process-gone", () => finish({ kind: "closed" }));
    window.on("closed", () => finish({ kind: "closed" }));
    void webContents.loadURL(input.url.href).catch(() => {});
  });
}

import { randomUUID } from "node:crypto";
import { session, WebContentsView, type BrowserWindow } from "electron";

export async function solveEmailLoginChallenge(owner: BrowserWindow, origin: string, signal: AbortSignal) {
  const challenge = new URL("/auth/desktop/email-proof", origin);
  const state = randomUUID();
  challenge.hash = new URLSearchParams({ state }).toString();
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  lifetime.throwIfAborted();
  const isolated = session.fromPartition("tomverse-email-proof-" + state);
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, ({ url }, callback) => {
    const target = new URL(url);
    callback({ cancel: target.origin !== challenge.origin && target.origin !== "https://challenges.cloudflare.com" });
  });
  const view = new WebContentsView({
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
  });
  const contents = view.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => { if (event.isMainFrame) event.preventDefault(); });
  const [width, height] = owner.getContentSize();
  view.setBounds({ x: 10, y: 64, width: Math.max(1, width - 20), height: Math.max(1, height - 78) });
  owner.contentView.addChildView(view);
  try {
    return await new Promise<string | undefined>((resolve) => {
      const finish = (token?: string) => {
        lifetime.removeEventListener("abort", stop);
        resolve(token);
      };
      const stop = () => finish();
      lifetime.addEventListener("abort", stop, { once: true });
      contents.once("render-process-gone", stop);
      contents.on("did-navigate-in-page", (_event, href, mainFrame) => {
        if (!mainFrame || lifetime.aborted) return;
        const target = new URL(href);
        if (target.origin !== challenge.origin || target.pathname !== challenge.pathname || target.search) return;
        const data = new URLSearchParams(target.hash.slice(1));
        if (data.get("state") !== state) return;
        const token = data.get("token");
        if (data.get("cancel") === "1") finish();
        else if (token && /^[A-Za-z0-9_.-]{1,2048}$/.test(token)) finish(token);
      });
      void contents.loadURL(challenge.href).then(() => {
        if (!contents.isDestroyed()) contents.focus();
      }, stop);
    });
  } finally {
    if (!owner.isDestroyed()) owner.contentView.removeChildView(view);
    if (!contents.isDestroyed()) contents.close();
    void isolated.clearStorageData().catch(() => {});
  }
}

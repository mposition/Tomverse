import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import {
  checkoutReturnOutcome, classifyCheckoutNavigation,
  type BillingWindowState, type CheckoutOutcome, type CheckoutPurpose,
} from "../billing-contract";
import { createWebView } from "./web-view";

type Active = { window: BrowserWindow; view: ReturnType<typeof createWebView>; purpose: CheckoutPurpose };

/**
 * The app-owned Stripe Checkout window.
 *
 * The page runs in the same isolated web view as documentation links: a fresh
 * in-memory session, sandboxed, no preload, no permissions, no downloads and no
 * popups. It never receives the Desktop session cookie or access token; the
 * main process reads the account from Tomverse after the window closes. The
 * window title always names the host on screen and pages cannot change it.
 */
export function createBillingWindowHost(deps: {
  parent: () => BrowserWindow | null;
  returnOrigins: () => readonly string[];
  language: () => string;
  title: () => string;
  publish: (state: BillingWindowState) => void;
}) {
  let active: Active | undefined;

  function finish(outcome: CheckoutOutcome) {
    const current = active;
    if (!current) return false;
    active = undefined;
    current.view.close();
    if (!current.window.isDestroyed()) current.window.destroy();
    deps.publish({ stage: "closed", purpose: current.purpose, outcome });
    return true;
  }

  function open(url: URL, purpose: CheckoutPurpose, accountSignal: AbortSignal) {
    if (active) throw new Error("A checkout window is already open.");
    accountSignal.throwIfAborted();
    const parent = deps.parent();
    const window = new BrowserWindow({
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      width: 520, height: 780, minWidth: 380, minHeight: 520, show: false, autoHideMenuBar: true,
      title: url.host + " - " + deps.title(), backgroundColor: "#ffffff",
      // The frame's own page stays empty; the checkout page lives in the isolated view below.
      webPreferences: {
        partition: "tomverse-checkout-frame-" + randomUUID(), sandbox: true, contextIsolation: true,
        nodeIntegration: false, webviewTag: false, devTools: false, spellcheck: false,
      },
    });
    window.removeMenu();
    window.on("page-title-updated", (event) => event.preventDefault());
    const created: Active = {
      window, purpose,
      view: createWebView(window, {
        language: deps.language(),
        newWindows: "deny",
        decide: (target) => {
          const verdict = classifyCheckoutNavigation(target, deps.returnOrigins());
          return verdict === "allow" ? "allow" : verdict === "return" ? "link" : "block";
        },
        changed: (raw) => {
          if (active !== created || window.isDestroyed()) return;
          let host = "";
          try { host = new URL(raw.url).host; } catch { /* Still loading. */ }
          if (host) window.setTitle(host + " - " + deps.title());
          deps.publish({ stage: "open", purpose, host, loading: raw.loading, failed: raw.failed });
        },
        // Only a Tomverse URL reaches here: the server's success or cancel page. The navigation is already
        // cancelled; the window closes once the navigation event has returned.
        linkRequested: (target) => {
          const outcome = checkoutReturnOutcome(target);
          setImmediate(() => { if (active === created) finish(outcome); });
        },
      }),
    };
    active = created;
    const layout = () => {
      if (window.isDestroyed()) return;
      const [width, height] = window.getContentSize();
      created.view.apply({ type: "layout", bounds: { x: 0, y: 0, width, height } });
    };
    window.on("resize", layout);
    window.on("closed", () => { if (active === created) finish("closed"); });
    accountSignal.addEventListener("abort", () => { if (active === created) finish("closed"); }, { once: true });
    layout();
    window.show();
    deps.publish({ stage: "open", purpose, host: url.host, loading: true, failed: false });
    void created.view.load(url.href);
  }

  return {
    open,
    close: () => finish("closed"),
    isOpen: () => active !== undefined,
    focus: () => { if (active && !active.window.isDestroyed()) active.window.focus(); },
  };
}

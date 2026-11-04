// The improvement scout's browser, with the rules of
// docs/policy/product-research-agent.md §12 applied: Chromium with its sandbox,
// a browser-level CDP Fetch session that judges every request and every
// redirect hop before it is sent, document responses held and stopped on a
// challenge or an error status, host resolver rules as a second layer, and
// WebSocket, service worker, download and permission requests refused.
//
// Used by the walker (scripts/agents/product-research-scout.mjs).

import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import {
  decideScoutRequest,
  documentStop,
  headersFromCdp,
} from "./productResearchScoutBrowserPolicy.mjs";

/** Host resolver rules that keep real DNS for the allowed hosts and fail the rest. */
export const resolverRules = (allowedHosts) =>
  `--host-resolver-rules=MAP * ~NOTFOUND, ${allowedHosts.map((host) => `EXCLUDE ${host}`).join(", ")}`;

/**
 * Chromium with its sandbox. `{ sandbox: false }` is only for the walker's
 * retry after a sandboxed launch failed (retriesWithoutSandbox, §12).
 */
export async function launch(args, { sandbox = true } = {}) {
  return chromium.launch({ chromiumSandbox: sandbox === false ? false : true, args });
}

/**
 * What the host gives Chromium's sandbox, read from /proc after a launch
 * fails: the user namespace limits, no_new_privs, the seccomp mode and the
 * capability bounding set. Short values only; anything unreadable is null.
 */
export function sandboxHost() {
  const read = (path) => {
    try {
      return readFileSync(path, "utf8").trim().slice(0, 32);
    } catch {
      return null;
    }
  };
  let status = "";
  try {
    status = readFileSync("/proc/self/status", "utf8");
  } catch {}
  const field = (name) => new RegExp(`^${name}:\\s*(\\S{1,32})`, "m").exec(status)?.[1] ?? null;
  return {
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    maxUserNamespaces: read("/proc/sys/user/max_user_namespaces"),
    unprivilegedUsernsClone: read("/proc/sys/kernel/unprivileged_userns_clone"),
    apparmorRestrictsUserns: read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
    noNewPrivs: field("NoNewPrivs"),
    seccomp: field("Seccomp"),
    capBnd: field("CapBnd"),
  };
}

/**
 * The scout's request rule as a browser-level CDP Fetch session.
 *
 * Every request in every target pauses at the request stage and is continued
 * only when decideScoutRequest allows it. Every document response also pauses,
 * at the response stage, before its body reaches the renderer: documentStop
 * reads its status and headers there, and a challenge or an error status is
 * failed in place, so nothing it carries runs (§11-5). That holds for every
 * document for as long as the page lives -- the top document, an iframe, a
 * later navigation -- and `onStop` tells the page's visit the moment one is
 * stopped. The caller swaps `stops` and `onStop` per page, and sets `allowWrite`
 * only for the turn that makes a real file (§14); `refusedWrites` then names the
 * POST paths that turn was refused.
 */
export async function installCdpRules(browser, allowedOrigins) {
  const session = await browser.newBrowserCDPSession();
  const state = { stops: [], onStop: null, allowWrite: null, refusedWrites: [] };
  session.on("Fetch.requestPaused", (event) => {
    let allow;
    if (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined) {
      const stop = documentStop({ status: event.responseStatusCode ?? 0, headers: headersFromCdp(event.responseHeaders) });
      if (stop !== null) {
        const entry = { stop, status: event.responseStatusCode ?? null };
        state.stops.push(entry);
        state.onStop?.(entry);
      }
      allow = stop === null;
    } else {
      const { method, url } = event.request;
      allow = decideScoutRequest({ method, url, allowedOrigins, allowWrite: state.allowWrite }).allow;
      if (!allow && state.allowWrite && method === "POST" && state.refusedWrites.length < 5) {
        state.refusedWrites.push(new URL(url).pathname.slice(0, 120));
      }
    }
    const command = allow
      ? session.send("Fetch.continueRequest", { requestId: event.requestId })
      : session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
    // A target that closed while its request was paused rejects the command;
    // there is nothing left to continue or fail.
    command.catch(() => {});
  });
  await session.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*", requestStage: "Request" },
      { urlPattern: "*", resourceType: "Document", requestStage: "Response" },
    ],
  });
  return state;
}

/**
 * A browser context with the §12 context options. `headers` carries the Access
 * service token on dev and Test; a request to any other origin is stopped by
 * the CDP rule before it is sent, so the token goes nowhere else. `cookies`
 * signs the context in as the test account.
 */
export async function ruledContext(browser, { locale, headers = {}, cookies = [] }) {
  const context = await browser.newContext({
    locale,
    serviceWorkers: "block",
    acceptDownloads: false,
    permissions: [],
    extraHTTPHeaders: headers,
  });
  if (cookies.length > 0) await context.addCookies(cookies);
  // CDP Fetch does not see a WebSocket handshake; Playwright's WebSocket route
  // closes it before it connects.
  await context.routeWebSocket(/.*/, (ws) => ws.close({ code: 1008, reason: "scout" }));
  return context;
}

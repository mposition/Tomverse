// The improvement scout's browser, with the rules of
// docs/policy/product-research-agent.md §12 applied: Chromium with its sandbox,
// a browser-level CDP Fetch session that judges every request and every
// redirect hop before it is sent, document responses held and stopped on a
// challenge or an error status, host resolver rules as a second layer, and
// WebSocket, service worker, download and permission requests refused.
//
// Used by the walker (scripts/agents/product-research-scout.mjs) and by the S0
// probe that measured these rules (scripts/agents/product-research-scout-s0-probe.mjs).

import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import {
  AbortTally,
  decideScoutRequest,
  documentStop,
  headersFromCdp,
} from "./productResearchScoutBrowserPolicy.mjs";

/** Host resolver rules that keep real DNS for the allowed hosts and fail the rest. */
export const resolverRules = (allowedHosts) =>
  `--host-resolver-rules=MAP * ~NOTFOUND, ${allowedHosts.map((host) => `EXCLUDE ${host}`).join(", ")}`;

export async function launch(args) {
  return chromium.launch({ chromiumSandbox: true, args });
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
 * stopped. The caller swaps `tally`, `stops` and `onStop` per page.
 */
export async function installCdpRules(browser, allowedOrigins) {
  const session = await browser.newBrowserCDPSession();
  const state = { tally: new AbortTally(), stops: [], onStop: null };
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
      const decision = decideScoutRequest({ method, url, allowedOrigins });
      if (!decision.allow) state.tally.add({ reason: decision.reason, method, url });
      allow = decision.allow;
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

/** A browser context with the §12 context options, and Playwright's route when asked. */
export async function ruledContext(browser, { allowedOrigins, locale, serviceWorkers = "block", playwrightRoute, tally }) {
  const context = await browser.newContext({
    locale,
    serviceWorkers,
    acceptDownloads: false,
    permissions: [],
  });
  if (playwrightRoute) {
    await context.route("**/*", (route) => {
      const request = route.request();
      const decision = decideScoutRequest({ method: request.method(), url: request.url(), allowedOrigins });
      if (decision.allow) return route.continue();
      tally.add({ reason: decision.reason, method: request.method(), url: request.url() });
      return route.abort("blockedbyclient");
    });
  }
  let webSocketsRefused = 0;
  // CDP Fetch does not see a WebSocket handshake; Playwright's WebSocket route
  // closes it before it connects.
  await context.routeWebSocket(/.*/, (ws) => {
    webSocketsRefused += 1;
    ws.close({ code: 1008, reason: "scout" });
  });
  return { context, webSocketsRefused: () => webSocketsRefused };
}

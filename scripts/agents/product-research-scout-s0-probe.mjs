// The improvement scout's S0 probe (docs/policy/product-research-agent.md §20).
//
//   node scripts/agents/product-research-scout-s0-probe.mjs fixture [--json]
//   node scripts/agents/product-research-scout-s0-probe.mjs pages [--json]
//   npm run agent:product-research-scout-s0-probe -- renderers [--json]
//   npm run agent:product-research-scout-s0-probe -- all
//
// `fixture` measures S0 (4) and (11): it serves a page on a local allowed origin
// that tries every request the browser rules forbid -- other methods, another
// origin, a redirect to another origin (from a subresource, a navigation, an
// iframe and a worker), the same host on another port, a popup, a WebSocket, a
// service worker, a download and a form POST -- and the two local servers count
// what actually reached them. Interception that only looks right in the
// browser's own event stream is not a measurement; a request that arrived is.
//
// It runs the browser three ways and reports each:
//
//   route          Playwright request interception alone. Its handler sees only
//                  the first URL of a redirect chain, so redirects leak.
//   route+resolver adds Chromium host resolver rules: hosts off the list do not
//                  resolve. A redirect to the allowed host on another port or
//                  scheme still leaves, because the rule is by hostname.
//   cdp+resolver   a browser-level CDP Fetch session pauses every request in
//                  every target -- each redirect hop, iframes, workers, popups --
//                  and the same origin rule decides it before it is sent; the
//                  resolver rules stay as a second layer. This is the
//                  configuration the browser service runs.
//
// `pages` measures S0 (3): the twenty production public pages (§12), one at a
// time, as a guest, GET and HEAD only, with the cdp+resolver rules. The
// document response is read at commit and a challenge or an error status stops
// the page there (§11-6). It records the document language and which other
// origins the page tried to reach -- the candidates for the first-party static
// origin list S0 (4) has to settle. It never clicks, types or solves anything.
//
// `renderers` measures S0 (2): every fixed renderer probe goes through the chat
// tool's admission and renderer, then the checks the RND rules need -- zip
// parts, PDF parse, the embedded font, Korean in the extracted text, text
// positions against the page, and a raster of the first page. It needs the
// app's TypeScript modules, hence the npm script (tsx, react-server).
//
// `all` is what the Railway probe service runs (docs/ops/product-research-agent.md):
// the three modes in one process and one JSON document, plus what S0 (1) and
// (10) need -- Node version, process start to first measurement, each mode's
// time, the Node process's sampled peak RSS and, where the container exposes
// it, the cgroup's peak memory (which includes Chromium) -- and the *names* of
// the variables the container was given, never a value. It does nothing unless
// PRODUCT_RESEARCH_SCOUT_ENABLED is set, because a Railway service without a
// schedule runs on every deploy.
//
// Read-only and credential-free: the switch is the only variable read, nothing
// is written outside stdout, the network destinations are 127.0.0.1 (fixture)
// and https://tomverse.app (pages), and errors leave as codes -- never the URL
// a browser message carries.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import {
  AbortTally,
  SCOUT_LOCALES,
  SCOUT_PAGE_ORIGIN,
  SCOUT_PAGES,
  decideScoutRequest,
  documentStop,
  errorCode,
  headersFromCdp,
  isScoutCausedConsoleError,
  originOf,
} from "../../lib/productResearchScoutBrowserPolicy.mjs";

const mode = process.argv[2];
const asJson = process.argv.includes("--json");
const MODES = ["fixture", "pages", "renderers", "all"];
if (!MODES.includes(mode)) {
  console.error("Usage: product-research-scout-s0-probe.mjs fixture|pages|renderers|all [--json]");
  process.exit(64);
}

/** The per-page ceiling the browser service enforces (§13). */
const PAGE_DEADLINE_MS = 60_000;
/** How long a loaded page may keep issuing requests before it is read. */
const SETTLE_MS = 2_500;

/** Host resolver rules that keep real DNS for the allowed hosts and fail the rest. */
const resolverRules = (allowedHosts) =>
  `--host-resolver-rules=MAP * ~NOTFOUND, ${allowedHosts.map((host) => `EXCLUDE ${host}`).join(", ")}`;

async function launch(args) {
  return chromium.launch({ chromiumSandbox: true, args });
}

/**
 * The scout's request rule as a browser-level CDP Fetch session.
 *
 * Every request in every target pauses at the request stage and is continued
 * only when decideScoutRequest allows it. Every document response also pauses,
 * at the response stage, before its body reaches the renderer: documentStop
 * reads its status and headers there, and a challenge or an error status is
 * failed in place, so nothing it carries runs (§11-6). That holds for every
 * document for as long as the page lives -- the top document, an iframe, a
 * later navigation -- and `onStop` tells the page's visit the moment one is
 * stopped. The caller swaps `tally`, `stops` and `onStop` per page.
 */
async function installCdpRules(browser, allowedOrigins) {
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

/** A browser context with the §13 context options, and Playwright's route when asked. */
async function ruledContext(browser, { allowedOrigins, locale, serviceWorkers = "block", playwrightRoute, tally }) {
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

// ---------------------------------------------------------------- fixture

function recordingServer(name, handler) {
  const received = [];
  const server = createServer((request, response) => {
    received.push({ server: name, method: request.method, path: request.url, upgrade: false });
    handler(request, response);
  });
  server.on("upgrade", (request, socket) => {
    received.push({ server: name, method: request.method, path: request.url, upgrade: true });
    socket.destroy();
  });
  return {
    received,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function fixturePage({ otherHost, otherSameHost }) {
  return `<!doctype html><html lang="en"><head><title>fixture</title>
<link rel="stylesheet" href="${otherHost}/style.css">
<script src="${otherHost}/script.js"></script>
</head><body>
<img src="${otherHost}/direct.png"><img src="${otherSameHost}/same-host-direct.png">
<img src="/redirect-other-host"><img src="/redirect-same-host"><img src="/redirect-on">
<iframe src="/redirect-frame"></iframe>
<script>
(async () => {
  const settle = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 2000))]);
  const attempts = [
    fetch("/get"),
    fetch("/head-ok", { method: "HEAD" }),
    fetch("/post", { method: "POST", body: "x" }),
    fetch("/put", { method: "PUT", body: "x" }),
    fetch("/delete", { method: "DELETE" }),
    fetch("${otherHost}/cors"),
    fetch("/redirect-fetch"),
  ].map((attempt) => settle(attempt.catch(() => null)));
  try { navigator.sendBeacon("/beacon", "x"); } catch {}
  try { new WebSocket(location.origin.replace("http", "ws") + "/ws"); } catch {}
  try { new Worker("/worker.js"); } catch {}
  try { window.open("${otherSameHost}/popup"); } catch {}
  let worker = "absent";
  try {
    if (navigator.serviceWorker) { await settle(navigator.serviceWorker.register("/sw.js")); worker = "attempted"; }
  } catch { worker = "refused"; }
  await Promise.allSettled(attempts);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  document.title = "done:" + worker;
})();
</script></body></html>`;
}

const FIXTURE_CONFIGURATIONS = [
  { name: "route", playwrightRoute: true, cdp: false, resolver: false },
  { name: "route+resolver", playwrightRoute: true, cdp: false, resolver: true },
  { name: "cdp+resolver", playwrightRoute: false, cdp: true, resolver: true },
  // A control, not a configuration the service would run: service workers
  // allowed, so the fixture shows it can see one. Without it, a service worker
  // that never registered could mean the rule worked or that the page never
  // had the API.
  { name: "control:service-workers-allowed", playwrightRoute: false, cdp: true, resolver: true, serviceWorkers: "allow", control: true },
];

async function runFixture() {
  const other = recordingServer("other", (request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("other");
  });
  let allowed = null;
  try {
    const otherPort = await other.listen();
    // Another hostname, and the allowed hostname on another port: the second is
    // the case a hostname rule cannot see.
    const otherHost = `http://other.test:${otherPort}`;
    const otherSameHost = `http://localhost:${otherPort}`;
    allowed = recordingServer("allowed", (request, response) => {
      const path = new URL(request.url, "http://x").pathname;
      const html = (body) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(body);
      };
      const redirect = (location) => {
        response.writeHead(302, { location });
        response.end();
      };
      if (path === "/page") return html(fixturePage({ otherHost, otherSameHost }));
      // A challenge and an error page that each try to run something. Under
      // the service's rules neither body reaches the renderer, so neither
      // request may arrive.
      if (path === "/challenge" || path === "/error-page") {
        response.writeHead(path === "/challenge" ? 403 : 503, {
          "content-type": "text/html",
          ...(path === "/challenge" ? { "cf-mitigated": "challenge" } : {}),
        });
        return response.end(`<!doctype html><img src="${path}-img"><script>fetch("${path}-script-ran")</script>`);
      }
      // The same problem arriving after the page has loaded: an iframe added,
      // and the page navigating itself, inside the settle window.
      if (path === "/page-with-late-challenge-frame") {
        return html(`<!doctype html><html lang="en"><title>late</title><script>
addEventListener("load", () => setTimeout(() => {
  const frame = document.createElement("iframe"); frame.src = "/challenge"; document.body.appendChild(frame);
}, 300));</script><body></body></html>`);
      }
      if (path === "/page-with-late-navigation") {
        return html(`<!doctype html><html lang="en"><title>late</title><script>
addEventListener("load", () => setTimeout(() => { location.href = "/challenge"; }, 300));</script></html>`);
      }
      if (path === "/page-with-challenge-frame") return html(`<!doctype html><html lang="en"><title>framed</title><iframe src="/challenge"></iframe></html>`);
      if (path === "/form") return html(`<!doctype html><form method="post" action="/form-post"></form><script>document.forms[0].submit();</script>`);
      // The one same-origin redirect, checked first: it has to arrive, or the
      // fixture cannot tell a blocked redirect from a broken one.
      if (path === "/redirect-on") return redirect("/same-origin-landing");
      if (path === "/redirect-other-host" || path === "/nav-redirect-other-host") return redirect(`${otherHost}/landed${path}`);
      if (path.startsWith("/redirect-") || path === "/nav-redirect-same-host") return redirect(`${otherSameHost}/landed${path}`);
      if (path === "/worker.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        return response.end(`fetch("${otherSameHost}/from-worker").catch(() => {}); fetch("/redirect-worker").catch(() => {});`);
      }
      if (path === "/download") {
        response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=x.bin" });
        return response.end("binary");
      }
      if (path === "/sw.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        return response.end("self.addEventListener('fetch', () => {});");
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    const allowedPort = await allowed.listen();
    // `localhost` is a secure context over plain http, so the page has
    // `navigator.serviceWorker` and the service worker rule is exercised.
    const allowedOrigin = `http://localhost:${allowedPort}`;
    const scrub = (value) => String(value).replaceAll(String(otherPort), "<other>").replaceAll(String(allowedPort), "<allowed>");

    const results = [];
    for (const configuration of FIXTURE_CONFIGURATIONS) {
      allowed.received.length = 0;
      other.received.length = 0;
      results.push(await runFixtureConfiguration(configuration, { allowedOrigin, allowed, other, scrub }));
    }
    return { mode: "fixture", platform: `${process.platform}-${process.arch}`, results };
  } finally {
    await allowed?.close();
    await other.close();
  }
}

async function runFixtureConfiguration(configuration, { allowedOrigin, allowed, other, scrub }) {
  const startedAt = Date.now();
  const args = configuration.resolver
    ? [resolverRules(["localhost"])]
    : ["--host-resolver-rules=MAP other.test 127.0.0.1"];
  let browser;
  try {
    browser = await launch(args);
  } catch (error) {
    return { configuration: configuration.name, sandboxLaunch: "failed", launchError: errorCode(error) };
  }
  try {
    const rules = configuration.cdp ? await installCdpRules(browser, [allowedOrigin]) : null;
    const tally = rules?.tally ?? new AbortTally();
    const { context, webSocketsRefused } = await ruledContext(browser, {
      allowedOrigins: [allowedOrigin],
      locale: SCOUT_LOCALES.en,
      serviceWorkers: configuration.serviceWorkers,
      playwrightRoute: configuration.playwrightRoute,
      tally,
    });
    let workerOutcome = "unknown";
    const navigation = {};
    try {
      const page = await context.newPage();
      await page.goto(`${allowedOrigin}/page`, { waitUntil: "load", timeout: PAGE_DEADLINE_MS });
      await page.waitForFunction(() => document.title.startsWith("done:"), null, { timeout: 15_000 }).catch(() => null);
      workerOutcome = (await page.title()).replace(/^done:/, "");
      for (const path of ["/nav-redirect-other-host", "/nav-redirect-same-host", "/download", "/form", "/challenge", "/error-page"]) {
        const probe = await context.newPage();
        try {
          navigation[path] = await probe
            .goto(`${allowedOrigin}${path}`, { waitUntil: "load", timeout: 15_000 })
            .then((response) => ({ status: response?.status() ?? null, finalOrigin: scrub(originOf(probe.url())) }))
            .catch((error) => ({ error: errorCode(error), finalOrigin: scrub(originOf(probe.url())) }));
          await probe.waitForTimeout(1_000);
        } finally {
          await probe.close();
        }
      }
      // Let a popup or a worker that is still loading finish trying.
      await page.waitForTimeout(1_000);
    } finally {
      await context.close();
    }
    // The page visit the service runs, on a page whose only problem is a
    // challenge in an iframe: it has to come back stopped, not observed.
    let framedChallenge = null;
    if (rules) {
      framedChallenge = {};
      for (const path of ["/page-with-challenge-frame", "/page-with-late-challenge-frame", "/page-with-late-navigation"]) {
        rules.stops = [];
        const visit = await visitPage(browser, { id: `fixture${path}`, path, lang: "en" }, {
          origin: allowedOrigin,
          allowedOrigins: [allowedOrigin],
          rules,
        });
        framedChallenge[path] = visit.stopped ?? (visit.error ? `error ${visit.error}` : "not stopped");
      }
    }
    const reachedOther = other.received.map(({ method, path, upgrade }) => ({ method, path, upgrade }));
    const forbiddenOnAllowed = allowed.received
      .filter(({ method, upgrade, path }) => upgrade || !["GET", "HEAD"].includes(method) || path === "/sw.js")
      .map(({ method, path, upgrade }) => ({ method, path, upgrade }));
    // What must arrive, so that refusing everything cannot read as a pass.
    const arrived = (path) => allowed.received.some((entry) => entry.path === path && !entry.upgrade);
    const allowedArrived = { get: arrived("/get"), head: arrived("/head-ok"), sameOriginRedirect: arrived("/same-origin-landing") };
    // What a stopped document carried, which must not have run.
    const stoppedDocumentRan = ["/challenge-img", "/challenge-script-ran", "/error-page-img", "/error-page-script-ran"].filter(arrived);
    return {
      configuration: configuration.name,
      sandboxLaunch: "ok",
      elapsedMs: Date.now() - startedAt,
      allowedArrived,
      stoppedDocumentRan,
      framedChallenge,
      serviceWorker: workerOutcome,
      webSocketsRefusedByRoute: webSocketsRefused(),
      aborted: tally.entries().map((entry) => ({ ...entry, origin: scrub(entry.origin) })),
      navigation,
      reachedOtherOrigin: reachedOther,
      forbiddenReachedAllowedOrigin: forbiddenOnAllowed,
      ...(configuration.control
        ? { controlDetected: allowed.received.some(({ path }) => path === "/sw.js") }
        : {
            pass:
              reachedOther.length === 0 &&
              forbiddenOnAllowed.length === 0 &&
              stoppedDocumentRan.length === 0 &&
              (rules === null || Object.values(framedChallenge).every((outcome) => outcome === "challenge")) &&
              Object.values(allowedArrived).every(Boolean),
          }),
    };
  } catch (error) {
    return { configuration: configuration.name, sandboxLaunch: "ok", error: errorCode(error), elapsedMs: Date.now() - startedAt };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- pages

async function runPages() {
  const allowedOrigins = [SCOUT_PAGE_ORIGIN];
  const browser = await launch([resolverRules([new URL(SCOUT_PAGE_ORIGIN).hostname])]);
  try {
    const rules = await installCdpRules(browser, allowedOrigins);
    const pages = [];
    const otherOrigins = new Map();
    for (const target of SCOUT_PAGES) {
      rules.tally = new AbortTally();
      rules.stops = [];
      const record = await visitPage(browser, target, { origin: SCOUT_PAGE_ORIGIN, allowedOrigins, rules });
      for (const entry of record.aborted ?? []) {
        if (entry.reason === "origin") otherOrigins.set(entry.origin, (otherOrigins.get(entry.origin) ?? 0) + entry.count);
      }
      for (const { origin, count } of record.failedOtherOrigins ?? []) {
        otherOrigins.set(origin, (otherOrigins.get(origin) ?? 0) + count);
      }
      pages.push(record);
    }
    return {
      mode: "pages",
      platform: `${process.platform}-${process.arch}`,
      pages,
      otherOriginsTried: [...otherOrigins.entries()].map(([origin, count]) => ({ origin, count })).sort((a, b) => b.count - a.count),
    };
  } finally {
    await browser.close();
  }
}

async function visitPage(browser, target, { origin, allowedOrigins, rules }) {
  const { tally } = rules;
  const startedAt = Date.now();
  const { context, webSocketsRefused } = await ruledContext(browser, {
    allowedOrigins,
    locale: SCOUT_LOCALES[target.lang],
    playwrightRoute: false,
    tally,
  });
  try {
    const page = await context.newPage();
    let consoleErrors = 0;
    let scoutCausedConsoleErrors = 0;
    let sameOriginErrors = 0;
    const failedOrigins = new Map();
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      if (isScoutCausedConsoleError(message.text())) scoutCausedConsoleErrors += 1;
      else consoleErrors += 1;
    });
    page.on("pageerror", () => {
      consoleErrors += 1;
    });
    page.on("response", (response) => {
      if (originOf(response.url()) === origin && response.status() >= 400) sameOriginErrors += 1;
    });
    page.on("requestfailed", (request) => {
      const failedOrigin = originOf(request.url()) ?? "opaque";
      if (failedOrigin !== origin) failedOrigins.set(failedOrigin, (failedOrigins.get(failedOrigin) ?? 0) + 1);
    });

    // A challenge or an error status is failed by the CDP rules while the
    // document response is held, so nothing it carried has run (§11-6). Any
    // document stopped while the page lives -- the top one, an iframe, a later
    // navigation -- ends the visit at once, and the stop is the answer.
    const stopped = new Promise((resolve) => {
      rules.onStop = resolve;
    });
    // The whole observation -- load, settle and the reads -- runs against the
    // stop signal, and the stop list is checked again after it, so a document
    // stopped at any point before the record is returned wins. A read that
    // fails because a stopped navigation tore the page down is a stop too.
    const observe = (async () => {
      const response = await page.goto(`${origin}${target.path}`, {
        waitUntil: "load",
        timeout: PAGE_DEADLINE_MS - SETTLE_MS - 5_000,
      });
      await page.waitForTimeout(SETTLE_MS);
      const documentLang = await page.evaluate(() => document.documentElement.lang);
      return {
        id: target.id,
        status: response?.status() ?? 0,
        stopped: null,
        finalOriginAllowed: originOf(page.url()) === origin,
        documentLang,
        langMatches: typeof documentLang === "string" && documentLang.toLowerCase().startsWith(target.lang),
        consoleErrors,
        scoutCausedConsoleErrors,
        sameOriginErrors,
        webSocketsRefused: webSocketsRefused(),
        aborted: tally.entries(),
        failedOtherOrigins: [...failedOrigins.entries()].map(([failed, count]) => ({ origin: failed, count })),
      };
    })();
    // The observation keeps running when a stop wins the race; the context
    // closes under it in finally, and its rejection is expected.
    observe.catch(() => {});
    let record;
    try {
      record = await Promise.race([observe, stopped.then(() => null)]);
    } catch (error) {
      if (rules.stops.length === 0) throw error;
      record = null;
    }
    if (record === null || rules.stops.length > 0) {
      const [first] = rules.stops;
      return { id: target.id, status: first.status, stopped: first.stop, stops: rules.stops.length, elapsedMs: Date.now() - startedAt };
    }
    return { ...record, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { id: target.id, error: errorCode(error), elapsedMs: Date.now() - startedAt };
  } finally {
    rules.onStop = null;
    await context.close();
  }
}

// ---------------------------------------------------------------- renderers

async function runRenderers() {
  const { RENDERER_PROBES, containsHangul, pdfEmbedsFontProgram, rendererProbeFindings, textItemsOutsidePage, zipPartNames } =
    await import("../../lib/productResearchScoutRendererProbes.mjs");
  const core = await import("../../lib/generatedArtifactCore.ts");
  const renderers = await import("../../lib/generatedArtifactRenderers.ts");
  const admit = { document: core.admitDocumentSpec, spreadsheet: core.admitWorkbookSpec, presentation: core.admitPresentationSpec };
  const render = {
    document: renderers.renderDocumentArtifact,
    spreadsheet: renderers.renderSpreadsheetArtifact,
    presentation: renderers.renderPresentationArtifact,
  };
  const tools = {};
  const probes = [];
  for (const probe of RENDERER_PROBES) {
    const startedAt = Date.now();
    const admission = admit[probe.kind](probe.spec);
    if (!admission.ok) {
      probes.push({ id: probe.id, admitted: false, code: admission.code });
      continue;
    }
    let bytes;
    try {
      bytes = render[probe.kind](admission.spec).bytes;
    } catch (error) {
      probes.push({ id: probe.id, admitted: true, rendered: false, error: String(error?.code ?? error?.name ?? "error") });
      continue;
    }
    const observed = { byteLength: bytes.byteLength };
    if (probe.format === "pdf") {
      Object.assign(observed, await inspectPdf(bytes, tools, { containsHangul, textItemsOutsidePage }));
      observed.embedsFont = pdfEmbedsFontProgram(bytes);
    } else {
      observed.parts = zipPartNames(bytes);
    }
    probes.push({
      id: probe.id,
      admitted: true,
      rendered: true,
      ...observed,
      parts: observed.parts ? observed.parts.length : observed.parts,
      findings: rendererProbeFindings(probe, observed),
      elapsedMs: Date.now() - startedAt,
    });
  }
  return { mode: "renderers", platform: `${process.platform}-${process.arch}`, tools, probes };
}

async function inspectPdf(bytes, tools, { containsHangul, textItemsOutsidePage }) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
  });
  try {
    const document = await loadingTask.promise;
    tools.pdfParse = "ok";
    let text = "";
    let outsidePage = 0;
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items
        .filter((item) => typeof item.str === "string")
        .map((item) => ({ x: item.transform[4], y: item.transform[5], width: item.width, str: item.str }));
      text += items.map((item) => item.str).join(" ");
      outsidePage += textItemsOutsidePage(items, { width: viewport.width, height: viewport.height });
      page.cleanup();
    }
    let rasterInkPixels = null;
    try {
      const { createCanvas } = await import("@napi-rs/canvas");
      const page = await document.getPage(1);
      const viewport = page.getViewport({ scale: 0.5 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, canvas, viewport }).promise;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      rasterInkPixels = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] < 200 || pixels[index + 1] < 200 || pixels[index + 2] < 200) rasterInkPixels += 1;
      }
      tools.raster = "ok";
    } catch (error) {
      tools.raster = `failed: ${errorCode(error)}`;
    }
    return { pages: document.numPages, hangulInText: containsHangul(text), outsidePage, rasterInkPixels };
  } finally {
    await loadingTask.destroy();
  }
}

// ---------------------------------------------------------------- all

/**
 * The container's peak memory from its cgroup, which counts Chromium's
 * processes as well as Node's. Null where the file is not there (a workstation,
 * or a runtime that does not expose it).
 */
function containerMemoryPeakBytes() {
  for (const path of ["/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"]) {
    try {
      const value = Number(readFileSync(path, "utf8").trim());
      if (Number.isFinite(value)) return value;
    } catch {
      // try the next layout
    }
  }
  return null;
}

async function runAll() {
  // Unset and empty are off, the same reading as every product-research switch
  // (docs/policy/product-research-agent.md §6).
  if (!process.env.PRODUCT_RESEARCH_SCOUT_ENABLED) {
    return { mode: "all", skipped: "PRODUCT_RESEARCH_SCOUT_ENABLED is not set" };
  }
  const firstMeasurementAtMs = Math.round(process.uptime() * 1000);
  // A sample, not a peak: the interval does not run while a renderer holds the
  // thread, and Chromium's processes are not Node's. The cgroup figure below is
  // the container's.
  let nodeRssSampledPeak = process.memoryUsage().rss;
  const sample = setInterval(() => {
    nodeRssSampledPeak = Math.max(nodeRssSampledPeak, process.memoryUsage().rss);
  }, 250);
  const timed = async (run) => {
    const startedAt = Date.now();
    try {
      return { ...(await run()), elapsedMs: Date.now() - startedAt };
    } catch (error) {
      return { error: errorCode(error), elapsedMs: Date.now() - startedAt };
    }
  };
  try {
    const fixture = await timed(runFixture);
    const pages = await timed(runPages);
    const renderers = await timed(runRenderers);
    return {
      mode: "all",
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      firstMeasurementAtMs,
      totalMs: Math.round(process.uptime() * 1000),
      nodeRssSampledPeakBytes: nodeRssSampledPeak,
      containerMemoryPeakBytes: containerMemoryPeakBytes(),
      variableNames: Object.keys(process.env).sort(),
      fixture,
      pages,
      renderers,
    };
  } finally {
    clearInterval(sample);
  }
}

const run = { fixture: runFixture, pages: runPages, renderers: runRenderers, all: runAll }[mode];
const result = await run();
if (asJson || mode === "all") {
  console.log(JSON.stringify(result, null, 2));
} else if (mode === "fixture") {
  for (const entry of result.results) {
    const verdict =
      entry.pass === undefined
        ? entry.controlDetected === undefined
          ? ""
          : `, control ${entry.controlDetected ? "detected sw.js" : "DID NOT detect sw.js"}`
        : `, ${entry.pass ? "PASS" : "FAIL"}`;
    console.log(`${entry.configuration}: sandbox ${entry.sandboxLaunch}${verdict}`);
    if (entry.launchError || entry.error) console.log(`  error: ${entry.launchError ?? entry.error}`);
    if (entry.stoppedDocumentRan?.length) console.log(`  stopped document ran: ${JSON.stringify(entry.stoppedDocumentRan)}`);
    if (entry.framedChallenge !== undefined && entry.framedChallenge !== null) console.log(`  page visits that must stop: ${JSON.stringify(entry.framedChallenge)}`);
    if (entry.allowedArrived) console.log(`  allowed requests arrived: ${JSON.stringify(entry.allowedArrived)}`);
    if (entry.reachedOtherOrigin?.length) console.log(`  reached other origin: ${JSON.stringify(entry.reachedOtherOrigin)}`);
    if (entry.forbiddenReachedAllowedOrigin?.length) console.log(`  forbidden on allowed origin: ${JSON.stringify(entry.forbiddenReachedAllowedOrigin)}`);
    if (entry.serviceWorker) console.log(`  service worker: ${entry.serviceWorker}; websockets refused: ${entry.webSocketsRefusedByRoute}`);
    if (entry.navigation) console.log(`  navigation: ${JSON.stringify(entry.navigation)}`);
  }
} else if (mode === "renderers") {
  console.log(`tools: ${JSON.stringify(result.tools)}`);
  for (const probe of result.probes) console.log(`${probe.id}: ${JSON.stringify(probe)}`);
} else {
  for (const page of result.pages) {
    console.log(
      page.error
        ? `${page.id}: error ${page.error}`
        : page.stopped
          ? `${page.id}: ${page.status} STOPPED (${page.stopped})`
          : `${page.id}: ${page.status} lang=${page.documentLang}${page.langMatches ? "" : " (mismatch)"} console=${page.consoleErrors}(+${page.scoutCausedConsoleErrors} scout-caused) sameOrigin4xx5xx=${page.sameOriginErrors} ${page.elapsedMs}ms`,
    );
  }
  console.log(`other origins tried: ${JSON.stringify(result.otherOriginsTried)}`);
}

// The improvement scout's S0 probe (docs/policy/product-research-agent.md §20).
//
//   node scripts/agents/product-research-scout-s0-probe.mjs fixture [--json]
//   node scripts/agents/product-research-scout-s0-probe.mjs pages [--json]
//   npm run agent:product-research-scout-s0-probe -- renderers [--json]
//   npm run agent:product-research-scout-s0-probe -- all
//
// `fixture` measures S0 (4) and (11): it serves a page on a local allowed origin
// that tries every request the browser rules forbid -- other methods, another
// origin, a redirect to another origin, a WebSocket, a service worker, a
// download, a form POST -- and the two local servers count what actually
// reached them. Interception that only looks right in the browser's own event
// stream is not a measurement; a request that arrived is.
//
// It runs the browser two ways. `route` is Playwright request interception
// alone. `route+resolver` adds Chromium's host resolver rules, which make every
// host outside the allowed list unresolvable inside the browser. Playwright
// calls a route handler only for the first URL of a redirect chain, so the
// first configuration is expected to leak the redirect and the second is the
// one the browser service would run; the probe reports both so the reason for
// the second is on the record.
//
// `pages` measures S0 (3): the twenty production public pages (§12), one at a
// time, as a guest, GET and HEAD only, with the same rules. It records whether
// a page answered with a bot challenge, the document language, and which other
// origins the page tried to reach -- the candidates for the first-party static
// origin list S0 (4) has to settle. It never clicks, types, solves or waits out
// a challenge.
//
// `renderers` measures S0 (2): every fixed renderer probe goes through the chat
// tool's admission and renderer, then the checks the RND rules need -- zip
// parts, PDF parse, the embedded font, Korean in the extracted text, text
// positions against the page, and a raster of the first page. It needs the
// app's TypeScript modules, hence the npm script (tsx, react-server).
//
// `all` is what the Railway probe service runs (docs/ops/product-research-agent.md):
// the three modes in one process, one JSON document, plus what S0 (1) and (10)
// need -- Node version, process start to first measurement, each mode's time and
// the peak resident memory -- and the *names* of the variables the container
// was given, never a value. It does nothing unless PRODUCT_RESEARCH_SCOUT_ENABLED
// is set, because a Railway service without a schedule runs on every deploy.
//
// Read-only and credential-free: no variable is read, nothing is written
// outside stdout, and the only network destinations are 127.0.0.1 (fixture)
// and https://tomverse.app (pages).

import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import {
  AbortTally,
  SCOUT_LOCALES,
  SCOUT_PAGE_ORIGIN,
  SCOUT_PAGES,
  decideScoutRequest,
  isBotChallenge,
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
const passThroughResolverRules = (allowedHosts) =>
  `--host-resolver-rules=MAP * ~NOTFOUND, ${allowedHosts.map((host) => `EXCLUDE ${host}`).join(", ")}`;

async function launch(extraArgs) {
  return chromium.launch({ chromiumSandbox: true, args: extraArgs });
}

/**
 * A browser context with every rule of §13 applied. Returns the tally the
 * route handler fills; the caller reads it after the page settles.
 */
async function ruledContext(browser, { allowedOrigins, locale, serviceWorkers = "block" }) {
  const context = await browser.newContext({
    locale,
    serviceWorkers,
    acceptDownloads: false,
    permissions: [],
    javaScriptEnabled: true,
  });
  const tally = new AbortTally();
  await context.route("**/*", (route) => {
    const request = route.request();
    const decision = decideScoutRequest({ method: request.method(), url: request.url(), allowedOrigins });
    if (decision.allow) return route.continue();
    tally.add({ reason: decision.reason, method: request.method(), url: request.url() });
    return route.abort("blockedbyclient");
  });
  let webSocketsRefused = 0;
  await context.routeWebSocket(/.*/, (ws) => {
    webSocketsRefused += 1;
    ws.close({ code: 1008, reason: "scout" });
  });
  return { context, tally, webSocketsRefused: () => webSocketsRefused };
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function fixturePage(other) {
  return `<!doctype html><html lang="en"><head><title>fixture</title>
<link rel="stylesheet" href="${other}/style.css">
<script src="${other}/script.js"></script>
</head><body>
<img src="${other}/direct.png"><img src="/redirect-off"><img src="/redirect-on">
<script>
(async () => {
  const settle = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 2000))]);
  const attempts = [
    fetch("/get"),
    fetch("/head-ok", { method: "HEAD" }),
    fetch("/post", { method: "POST", body: "x" }),
    fetch("/put", { method: "PUT", body: "x" }),
    fetch("/delete", { method: "DELETE" }),
    fetch("${other}/cors"),
  ].map((attempt) => settle(attempt.catch(() => null)));
  try { navigator.sendBeacon("/beacon", "x"); } catch {}
  try { new WebSocket(location.origin.replace("http", "ws") + "/ws"); } catch {}
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

async function runFixture() {
  const other = recordingServer("other", (request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("other");
  });
  const otherPort = await other.listen();
  const otherOrigin = `http://other.test:${otherPort}`;

  const allowed = recordingServer("allowed", (request, response) => {
    const path = new URL(request.url, "http://x").pathname;
    if (path === "/" || path === "/page") {
      response.writeHead(200, { "content-type": "text/html" });
      return response.end(fixturePage(otherOrigin));
    }
    if (path === "/form") {
      response.writeHead(200, { "content-type": "text/html" });
      return response.end(`<!doctype html><form method="post" action="/form-post"></form>
<script>document.forms[0].submit();</script>`);
    }
    if (path === "/redirect-off" || path === "/nav-redirect-off") {
      response.writeHead(302, { location: `${otherOrigin}/landing${path}` });
      return response.end();
    }
    if (path === "/redirect-on") {
      response.writeHead(302, { location: "/get" });
      return response.end();
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
  // `navigator.serviceWorker` and the service worker rule is actually exercised.
  const allowedOrigin = `http://localhost:${allowedPort}`;

  const configurations = [
    { name: "route", args: ["--host-resolver-rules=MAP other.test 127.0.0.1"] },
    { name: "route+resolver", args: [passThroughResolverRules(["localhost"])] },
    // A control, not a configuration the service would run: service workers
    // allowed, so the fixture shows it can see one. Without it, "absent" in the
    // two rows above could mean the rule worked or that the page never had the
    // API.
    { name: "control:service-workers-allowed", args: [passThroughResolverRules(["localhost"])], serviceWorkers: "allow", control: true },
  ];
  const results = [];
  for (const configuration of configurations) {
    allowed.received.length = 0;
    other.received.length = 0;
    const startedAt = Date.now();
    let browser;
    let launchError = null;
    try {
      browser = await launch(configuration.args);
    } catch (error) {
      launchError = String(error?.message ?? error).split("\n")[0];
    }
    if (!browser) {
      results.push({ configuration: configuration.name, sandboxLaunch: "failed", launchError });
      continue;
    }
    const { context, tally, webSocketsRefused } = await ruledContext(browser, {
      allowedOrigins: [allowedOrigin],
      locale: SCOUT_LOCALES.en,
      serviceWorkers: configuration.serviceWorkers,
    });
    const page = await context.newPage();
    await page.goto(`${allowedOrigin}/page`, { waitUntil: "load", timeout: PAGE_DEADLINE_MS });
    await page.waitForFunction(() => document.title.startsWith("done:"), null, { timeout: 15_000 }).catch(() => null);
    const workerOutcome = await page.title();
    const navigation = {};
    for (const path of ["/nav-redirect-off", "/download", "/form"]) {
      const probe = await context.newPage();
      const response = await probe
        .goto(`${allowedOrigin}${path}`, { waitUntil: "load", timeout: 15_000 })
        .then((value) => ({ status: value?.status() ?? null, finalOrigin: originOf(probe.url()) }))
        .catch((error) => ({ error: String(error?.message ?? error).split("\n")[0].slice(0, 120), finalOrigin: originOf(probe.url()) }));
      await probe.waitForTimeout(1_000);
      navigation[path] = response;
      await probe.close();
    }
    await context.close();
    await browser.close();
    const reachedOther = other.received.map(({ method, path, upgrade }) => ({ method, path, upgrade }));
    const forbiddenOnAllowed = allowed.received
      .filter(({ method, upgrade, path }) => upgrade || !["GET", "HEAD"].includes(method) || path === "/sw.js")
      .map(({ method, path, upgrade }) => ({ method, path, upgrade }));
    results.push({
      configuration: configuration.name,
      sandboxLaunch: "ok",
      elapsedMs: Date.now() - startedAt,
      serviceWorker: workerOutcome.replace(/^done:/, ""),
      webSocketsRefusedByRoute: webSocketsRefused(),
      aborted: tally.entries().map((entry) => ({ ...entry, origin: entry.origin.replace(String(otherPort), "<other>").replace(String(allowedPort), "<allowed>") })),
      navigation,
      reachedOtherOrigin: reachedOther,
      forbiddenReachedAllowedOrigin: forbiddenOnAllowed,
      ...(configuration.control
        ? { controlDetected: allowed.received.some(({ path }) => path === "/sw.js") }
        : { pass: reachedOther.length === 0 && forbiddenOnAllowed.length === 0 }),
    });
  }
  await allowed.close();
  await other.close();
  return { mode: "fixture", platform: `${process.platform}-${process.arch}`, chromium: chromium.name(), results };
}

// ---------------------------------------------------------------- pages

async function runPages() {
  const allowedOrigins = [SCOUT_PAGE_ORIGIN];
  const browser = await launch([passThroughResolverRules([new URL(SCOUT_PAGE_ORIGIN).hostname])]);
  const pages = [];
  const otherOrigins = new Map();
  for (const target of SCOUT_PAGES) {
    const startedAt = Date.now();
    const { context, tally, webSocketsRefused } = await ruledContext(browser, {
      allowedOrigins,
      locale: SCOUT_LOCALES[target.lang],
    });
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
      if (originOf(response.url()) === SCOUT_PAGE_ORIGIN && response.status() >= 400) sameOriginErrors += 1;
    });
    page.on("requestfailed", (request) => {
      const origin = originOf(request.url()) ?? "opaque";
      if (origin !== SCOUT_PAGE_ORIGIN) failedOrigins.set(origin, (failedOrigins.get(origin) ?? 0) + 1);
    });
    let record;
    try {
      const response = await page.goto(`${SCOUT_PAGE_ORIGIN}${target.path}`, {
        waitUntil: "load",
        timeout: PAGE_DEADLINE_MS - SETTLE_MS - 5_000,
      });
      await page.waitForTimeout(SETTLE_MS);
      const headers = response ? await response.allHeaders() : {};
      const title = await page.title().catch(() => "");
      const documentLang = await page.evaluate(() => document.documentElement.lang).catch(() => null);
      const finalOrigin = originOf(page.url());
      record = {
        id: target.id,
        status: response?.status() ?? null,
        challenge: isBotChallenge({ status: response?.status() ?? 0, headers, title }),
        cfMitigated: headers["cf-mitigated"] ?? null,
        finalOriginAllowed: finalOrigin === SCOUT_PAGE_ORIGIN,
        documentLang,
        langMatches: typeof documentLang === "string" && documentLang.toLowerCase().startsWith(target.lang),
        titlePresent: title.length > 0,
        consoleErrors,
        scoutCausedConsoleErrors,
        sameOriginErrors,
        webSocketsRefused: webSocketsRefused(),
        aborted: tally.entries(),
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      record = { id: target.id, error: String(error?.message ?? error).split("\n")[0].slice(0, 160), elapsedMs: Date.now() - startedAt };
    }
    for (const entry of record.aborted ?? []) {
      if (entry.reason === "origin") otherOrigins.set(entry.origin, (otherOrigins.get(entry.origin) ?? 0) + entry.count);
    }
    for (const [origin, count] of failedOrigins) otherOrigins.set(origin, (otherOrigins.get(origin) ?? 0) + count);
    pages.push(record);
    await context.close();
  }
  await browser.close();
  return {
    mode: "pages",
    platform: `${process.platform}-${process.arch}`,
    pages,
    otherOriginsTried: [...otherOrigins.entries()].map(([origin, count]) => ({ origin, count })).sort((a, b) => b.count - a.count),
  };
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
    tools.raster = `failed: ${String(error?.message ?? error).split("\n")[0].slice(0, 120)}`;
  }
  const pages = document.numPages;
  await loadingTask.destroy();
  return { pages, hangulInText: containsHangul(text), outsidePage, rasterInkPixels };
}

// ---------------------------------------------------------------- all

async function runAll() {
  // Unset and empty are off, the same reading as every product-research switch
  // (docs/policy/product-research-agent.md §6).
  if (!process.env.PRODUCT_RESEARCH_SCOUT_ENABLED) {
    return { mode: "all", skipped: "PRODUCT_RESEARCH_SCOUT_ENABLED is not set" };
  }
  const firstMeasurementAtMs = Math.round(process.uptime() * 1000);
  let peakRss = process.memoryUsage().rss;
  const sample = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 250);
  const timed = async (run) => {
    const startedAt = Date.now();
    try {
      return { ...(await run()), elapsedMs: Date.now() - startedAt };
    } catch (error) {
      return { error: String(error?.message ?? error).split("\n")[0].slice(0, 200), elapsedMs: Date.now() - startedAt };
    }
  };
  const fixture = await timed(runFixture);
  const pages = await timed(runPages);
  const renderers = await timed(runRenderers);
  clearInterval(sample);
  return {
    mode: "all",
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    firstMeasurementAtMs,
    totalMs: Math.round(process.uptime() * 1000),
    peakRssBytes: peakRss,
    variableNames: Object.keys(process.env).sort(),
    fixture,
    pages,
    renderers,
  };
}

const run = { fixture: runFixture, pages: runPages, renderers: runRenderers, all: runAll }[mode];
const result = await run();
if (asJson || mode === "all") {
  console.log(JSON.stringify(result, null, 2));
} else if (mode === "fixture") {
  for (const entry of result.results) {
    const verdict = entry.pass === undefined ? (entry.controlDetected === undefined ? "" : `, control ${entry.controlDetected ? "detected sw.js" : "DID NOT detect sw.js"}`) : `, ${entry.pass ? "PASS" : "FAIL"}`;
    console.log(`${entry.configuration}: sandbox ${entry.sandboxLaunch}${verdict}`);
    if (entry.launchError) console.log(`  launch: ${entry.launchError}`);
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
    console.log(page.error
      ? `${page.id}: error ${page.error}`
      : `${page.id}: ${page.status}${page.challenge ? " CHALLENGE" : ""} lang=${page.documentLang}${page.langMatches ? "" : " (mismatch)"} console=${page.consoleErrors}(+${page.scoutCausedConsoleErrors} scout-caused) sameOrigin4xx5xx=${page.sameOriginErrors} ${page.elapsedMs}ms`);
  }
  console.log(`other origins tried: ${JSON.stringify(result.otherOriginsTried)}`);
}

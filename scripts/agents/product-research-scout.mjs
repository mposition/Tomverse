// The improvement scout's walker (docs/policy/product-research-agent.md §10).
//
//   npm run agent:product-research-scout                      capture and send
//   npm run agent:product-research-scout -- --out <dir>       capture and save locally, send nothing
//
// It gathers what a person would look at and leaves the judging to the model:
// the twenty public pages at desktop and 320px, the first page of a generated
// PDF, the text of generated Office files, and the catalogue mismatches the
// 0-step report finds. When the app has a test account (§14) it also sees the
// signed-in screens and makes real files and an image, within the cap an owner
// set. Each subject goes to the app's scout route on its own; the app calls the
// model and stores the suggestions.
//
// Variables: PRODUCT_RESEARCH_SCOUT_ENABLED (unset or empty: nothing runs),
// PRODUCT_RESEARCH_SCOUT_INGEST_URL and PRODUCT_RESEARCH_SCOUT_INGEST_SECRET;
// PRODUCT_RESEARCH_SCOUT_SANDBOX_FALLBACK=off stops the unsandboxed retry;
// PRODUCT_RESEARCH_SCOUT_PAGE_ORIGIN points it at dev or Test, with
// PRODUCT_RESEARCH_SCOUT_ACCESS_CLIENT_ID and _SECRET to pass Cloudflare Access.
// It holds no model key and no database credential. A send whose outcome is
// unknown is not repeated; the next day's run covers the subject again.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installCdpRules, launch, resolverRules, ruledContext, sandboxHost } from "../../lib/productResearchScoutBrowser.mjs";
import {
  SCOUT_GENERATIONS,
  SCOUT_LOCALES,
  SCOUT_PAGES,
  SCOUT_SANDBOX_FALLBACK_ENV,
  SCOUT_SIGNED_IN_PAGES,
  errorCode,
  isScoutCausedConsoleError,
  isSignedOutPath,
  launchFailure,
  originOf,
  retriesWithoutSandbox,
  scoutWalkTarget,
  signedInAccess,
} from "../../lib/productResearchScoutBrowserPolicy.mjs";
import { SCOUT_PAGE_TIMEOUT_MS, generateFile, generateImage, officePackage, pdfFirstPage, screenshot } from "../../lib/productResearchScoutGeneration.mjs";
import { scoutSendOutcome } from "../../lib/productResearchScoutCore.ts";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : null;

const SETTLE_MS = 2_000;
const SEND_TIMEOUT_MS = 150_000;
const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 900 },
  { label: "phone-320", width: 320, height: 720 },
];

if (!process.env.PRODUCT_RESEARCH_SCOUT_ENABLED && !outDir) {
  console.log(JSON.stringify({ event: "product_research_scout_skipped", reason: "switch_off" }));
  process.exit(0);
}

const ingestUrl = process.env.PRODUCT_RESEARCH_SCOUT_INGEST_URL ?? "";
const ingestSecret = process.env.PRODUCT_RESEARCH_SCOUT_INGEST_SECRET ?? "";
if (!outDir && (!/^https:\/\/[^/\s]+\/api\/internal\/product-research\/scout$/.test(ingestUrl) || ingestSecret.length < 32)) {
  console.error(JSON.stringify({ event: "product_research_scout_misconfigured" }));
  process.exit(1);
}

const walk = scoutWalkTarget({
  origin: process.env.PRODUCT_RESEARCH_SCOUT_PAGE_ORIGIN,
  accessClientId: process.env.PRODUCT_RESEARCH_SCOUT_ACCESS_CLIENT_ID,
  accessClientSecret: process.env.PRODUCT_RESEARCH_SCOUT_ACCESS_CLIENT_SECRET,
});
if (walk.refused) {
  console.error(JSON.stringify({ event: "product_research_scout_misconfigured", reason: walk.refused }));
  process.exit(1);
}

/** The whole run stops here, whatever it is doing; tomorrow covers what was left. */
const RUN_DEADLINE_MS = 45 * 60_000;
setTimeout(() => {
  console.error(JSON.stringify({ event: "product_research_scout_deadline", minutes: RUN_DEADLINE_MS / 60_000 }));
  process.exit(1);
}, RUN_DEADLINE_MS).unref();

const outcomes = { sent: 0, stored: 0, modelOff: 0, capped: 0, refused: 0, failed: 0, stopped: 0, skipped: 0, signedInPages: 0, generated: 0 };
/** Set by the route's first daily_cap_reached; nothing more is captured or sent today. */
let capReached = false;

async function deliver(subject) {
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    for (const image of subject.images ?? []) {
      writeFileSync(join(outDir, `${subject.subject}.${image.label}.${image.mediaType === "image/png" ? "png" : "jpg"}`), Buffer.from(image.base64, "base64"));
    }
    writeFileSync(join(outDir, `${subject.subject}.json`), JSON.stringify({ ...subject, images: (subject.images ?? []).map(({ label, mediaType, base64 }) => ({ label, mediaType, bytes: Math.round((base64.length * 3) / 4) })) }, null, 2));
    outcomes.sent += 1;
    return;
  }
  if (capReached) {
    outcomes.capped += 1;
    return;
  }
  try {
    const response = await fetch(ingestUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${ingestSecret}`, "content-type": "application/json" },
      body: JSON.stringify(subject),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const answer = await response.json().catch(() => ({}));
    outcomes.sent += 1;
    const outcome = scoutSendOutcome(answer);
    if (outcome === "judged") outcomes.stored += Number(answer.stored) || 0;
    else outcomes[outcome] += 1;
    if (outcome === "capped") capReached = true;
  } catch (error) {
    // Unknown outcome: the app may have stored it. Not repeated.
    outcomes.failed += 1;
    console.warn(JSON.stringify({ event: "product_research_scout_send_unknown", subject: subject.subject, error: errorCode(error) }));
  }
}

// ---------------------------------------------------------------- pages

async function capturePage(browser, rules, target, { cookies = [] } = {}) {
  const images = [];
  const consoleErrors = [];
  const sameOriginErrors = [];
  let documentLang = null;
  for (const viewport of VIEWPORTS) {
    rules.stops = [];
    const context = await ruledContext(browser, { locale: SCOUT_LOCALES[target.lang], headers: walk.headers, cookies });
    try {
      await context.setDefaultTimeout(SCOUT_PAGE_TIMEOUT_MS);
      const page = await context.newPage();
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      page.on("console", (message) => {
        if (message.type() === "error" && !isScoutCausedConsoleError(message.text()) && consoleErrors.length < 5) {
          consoleErrors.push(message.text().slice(0, 200));
        }
      });
      page.on("pageerror", (error) => {
        if (consoleErrors.length < 5) consoleErrors.push(`pageerror: ${String(error?.message ?? error).slice(0, 200)}`);
      });
      page.on("response", (response) => {
        if (originOf(response.url()) === walk.origin && response.status() >= 400 && sameOriginErrors.length < 5) {
          sameOriginErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
        }
      });
      await page.goto(`${walk.origin}${target.path}`, { waitUntil: "load", timeout: SCOUT_PAGE_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
      if (rules.stops.length > 0) return { stopped: rules.stops[0].stop };
      if (cookies.length > 0 && isSignedOutPath(page.url())) return { error: "signed_out" };
      documentLang ??= await page.evaluate(() => document.documentElement.lang).catch(() => null);
      const base64 = await screenshot(page);
      if (base64) images.push({ label: viewport.label, mediaType: "image/jpeg", base64 });
    } catch (error) {
      if (rules.stops.length > 0) return { stopped: rules.stops[0].stop };
      return { error: errorCode(error) };
    } finally {
      await context.close();
    }
  }
  if (images.length === 0) return { error: "no_screenshot" };
  const signals = [
    ...(cookies.length > 0 ? ["Seen signed in as a test account with no real user's data."] : []),
    `expected language: ${target.lang}; document lang attribute: ${documentLang ?? "none"}`,
    `console errors (not caused by the scout's own blocking): ${consoleErrors.length ? `\n- ${consoleErrors.join("\n- ")}` : "none"}`,
    `same-origin responses with status 400 or more: ${sameOriginErrors.length ? sameOriginErrors.join(", ") : "none"}`,
  ].join("\n");
  return { subject: { kind: "page", subject: target.id, language: target.lang, images, signals } };
}

/**
 * Whether this run's Chromium had its sandbox: on; off (the retry after a
 * refused sandbox); off_failed (the retry did not start either); or none when
 * no browser started and no retry was made.
 */
let sandbox = "none";

async function walkPages() {
  const args = [resolverRules([new URL(walk.origin).hostname])];
  let browser;
  try {
    browser = await launch(args);
    sandbox = "on";
  } catch (error) {
    // Some Railway hosts refuse the sandbox's setup (§12): say why, then
    // start once more without it unless the operator turned that off.
    const failure = launchFailure(error);
    console.warn(JSON.stringify({ event: "product_research_scout_browser_launch_failed", ...failure, host: sandboxHost() }));
    if (!retriesWithoutSandbox(process.env.PRODUCT_RESEARCH_SCOUT_SANDBOX_FALLBACK, failure)) throw error;
    sandbox = "off_failed";
    try {
      browser = await launch(args, { sandbox: false });
    } catch (retryError) {
      console.warn(JSON.stringify({ event: "product_research_scout_browser_unsandboxed_failed", ...launchFailure(retryError), host: sandboxHost() }));
      throw retryError;
    }
    sandbox = "off";
    console.warn(JSON.stringify({ event: "product_research_scout_browser_unsandboxed", cause: failure.cause, source: failure.source, switch: SCOUT_SANDBOX_FALLBACK_ENV }));
  }
  try {
    const rules = await installCdpRules(browser, [walk.origin]);
    for (const target of SCOUT_PAGES) {
      if (capReached) {
        outcomes.capped += 1;
        continue;
      }
      const captured = await capturePage(browser, rules, target);
      if (captured.subject) await deliver(captured.subject);
      else {
        outcomes[captured.stopped ? "stopped" : "skipped"] += 1;
        console.warn(JSON.stringify({ event: "product_research_scout_page_not_captured", page: target.id, ...captured }));
      }
    }
    try {
      await walkSignedIn(browser, rules);
    } catch (error) {
      outcomes.failed += 1;
      console.warn(JSON.stringify({ event: "product_research_scout_step_failed", step: "signed_in", error: errorCode(error) }));
    }
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- signed in

/**
 * The app's answer to "may I come in as the test account?": a short-lived
 * session and today's generation permits, or null when there is no test account
 * (the route is 404) or the app refused.
 */
async function askSignedIn() {
  const response = await fetch(`${ingestUrl}/signed-in`, {
    method: "POST",
    headers: { authorization: `Bearer ${ingestSecret}`, "content-type": "application/json" },
    body: JSON.stringify({ generations: SCOUT_GENERATIONS.map((generation) => generation.id) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  const answer = await response.json().catch(() => ({}));
  const access = response.ok ? signedInAccess(answer, { ingestUrl, origin: walk.origin }) : { refused: String(answer.refused ?? response.status) };
  if (access.refused) {
    console.warn(JSON.stringify({ event: "product_research_scout_signed_in_refused", reason: access.refused }));
    return null;
  }
  return access;
}

async function walkSignedIn(browser, rules) {
  // Nothing signed in is worth paying for when the model will not judge it.
  if (outDir || capReached || outcomes.modelOff > 0) return;
  const access = await askSignedIn();
  if (!access) return;
  for (const target of SCOUT_SIGNED_IN_PAGES) {
    if (capReached) {
      outcomes.capped += 1;
      continue;
    }
    const captured = await capturePage(browser, rules, target, { cookies: [access.cookie] });
    if (captured.subject) {
      outcomes.signedInPages += 1;
      await deliver(captured.subject);
    } else {
      outcomes[captured.stopped ? "stopped" : "skipped"] += 1;
      console.warn(JSON.stringify({ event: "product_research_scout_page_not_captured", page: target.id, ...captured }));
      // A session the app no longer honours fails every page after it, and every real file too.
      if (captured.error === "signed_out") return;
    }
  }
  for (const id of access.permits) {
    // The model went off or the cap ran out during this run: stop paying for what nothing will judge.
    if (capReached || outcomes.modelOff > 0) {
      outcomes.capped += 1;
      continue;
    }
    const generation = SCOUT_GENERATIONS.find((entry) => entry.id === id);
    const place = { walk, cookie: access.cookie };
    const subject = id === "generated.image"
      ? await generateImage(browser, generation, place)
      : await generateFile(browser, rules, generation, place);
    if (subject) {
      outcomes.generated += 1;
      await deliver(subject);
    } else {
      outcomes.skipped += 1;
    }
  }
}

// ---------------------------------------------------------------- generated files

async function walkFiles() {
  const { RENDERER_PROBES } = await import("../../lib/productResearchScoutRendererProbes.mjs");
  const core = await import("../../lib/generatedArtifactCore.ts");
  const renderers = await import("../../lib/generatedArtifactRenderers.ts");
  const admit = { document: core.admitDocumentSpec, spreadsheet: core.admitWorkbookSpec, presentation: core.admitPresentationSpec };
  const render = {
    document: renderers.renderDocumentArtifact,
    spreadsheet: renderers.renderSpreadsheetArtifact,
    presentation: renderers.renderPresentationArtifact,
  };
  for (const probe of RENDERER_PROBES) {
    const admission = admit[probe.kind](probe.spec);
    if (!admission.ok) {
      outcomes.skipped += 1;
      continue;
    }
    let bytes;
    try {
      bytes = render[probe.kind](admission.spec).bytes;
    } catch (error) {
      await deliver({ kind: "file", subject: probe.id, signals: `The renderer failed on the fixed specification: ${String(error?.code ?? error?.name ?? "error")}.` });
      continue;
    }
    const specLine = `Fixed specification given to the renderer: ${JSON.stringify(probe.spec).slice(0, 1_500)}`;
    if (probe.format === "pdf") {
      const image = await pdfFirstPage(bytes).catch(() => null);
      await deliver({
        kind: "file",
        subject: probe.id,
        images: image ? [{ label: "pdf-page-1", mediaType: "image/png", base64: image }] : [],
        signals: `${bytes.byteLength} bytes.\n${specLine}`,
      });
    } else {
      const { parts, text } = officePackage(bytes);
      await deliver({
        kind: "file",
        subject: probe.id,
        signals: `${bytes.byteLength} bytes, ${parts} package parts.\n${specLine}\nText the file contains:\n${text}`,
      });
    }
  }
}

// ---------------------------------------------------------------- catalogue

async function walkCatalogue() {
  const { parseCatalogue, productConsistencyReport } = await import("../report-product-consistency-core.mjs");
  const { getWebSearchCapability, WEB_SEARCH_CAPABILITIES } = await import("../../lib/webSearchCapability.ts");
  const response = await fetch(`${walk.origin}/api/models/catalog`, { headers: { accept: "application/json", ...walk.headers }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    outcomes.skipped += 1;
    return;
  }
  const parsed = parseCatalogue(await response.json());
  if (parsed.problems) {
    outcomes.skipped += 1;
    return;
  }
  const report = productConsistencyReport({ models: parsed.models, register: WEB_SEARCH_CAPABILITIES, capabilityOf: getWebSearchCapability });
  const lines = report.findings.map((finding) => JSON.stringify(finding));
  await deliver({
    kind: "catalogue",
    subject: "catalogue",
    signals: [
      `Live catalogue: ${report.catalogue.models} models, ${report.catalogue.enabled} enabled.`,
      "Mismatches between the live catalogue and the code (web search route, retired-model successors):",
      lines.length ? lines.join("\n") : "none",
    ].join("\n").slice(0, 4_000),
  });
}

const startedAt = Date.now();
for (const [name, step] of [["pages", walkPages], ["files", walkFiles], ["catalogue", walkCatalogue]]) {
  try {
    await step();
  } catch (error) {
    outcomes.failed += 1;
    console.warn(JSON.stringify({ event: "product_research_scout_step_failed", step: name, error: errorCode(error) }));
  }
}
console.log(JSON.stringify({ event: "product_research_scout_run", elapsedMs: Date.now() - startedAt, ...outcomes, sandbox, mode: outDir ? "local" : "send" }));

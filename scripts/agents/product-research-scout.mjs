// The improvement scout's walker (docs/policy/product-research-agent.md §10).
//
//   npm run agent:product-research-scout                      capture and send
//   npm run agent:product-research-scout -- --out <dir>       capture and save locally, send nothing
//
// It gathers what a person would look at and leaves the judging to the model:
// the twenty public pages at desktop and 320px, the first page of a generated
// PDF, the text of generated Office files, and the catalogue mismatches the
// 0-step report finds. Each subject goes to the app's scout route on its own;
// the app calls the model and stores the suggestions.
//
// Variables: PRODUCT_RESEARCH_SCOUT_ENABLED (unset or empty: nothing runs),
// PRODUCT_RESEARCH_SCOUT_INGEST_URL and PRODUCT_RESEARCH_SCOUT_INGEST_SECRET.
// It holds no model key and no database credential. A send whose outcome is
// unknown is not repeated; the next day's run covers the subject again.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { installCdpRules, launch, resolverRules, ruledContext } from "../../lib/productResearchScoutBrowser.mjs";
import {
  AbortTally,
  SCOUT_LOCALES,
  SCOUT_PAGE_ORIGIN,
  SCOUT_PAGES,
  errorCode,
  isScoutCausedConsoleError,
  originOf,
} from "../../lib/productResearchScoutBrowserPolicy.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : null;

const PAGE_TIMEOUT_MS = 45_000;
const SETTLE_MS = 2_000;
const SEND_TIMEOUT_MS = 150_000;
/** Taller than this is cut: the model reads the top of a page best, and the body stays bounded. */
const SCREENSHOT_MAX_HEIGHT = 2_400;
const IMAGE_BASE64_LIMIT = 1_400_000;
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

/** The whole run stops here, whatever it is doing; tomorrow covers what was left. */
const RUN_DEADLINE_MS = 45 * 60_000;
setTimeout(() => {
  console.error(JSON.stringify({ event: "product_research_scout_deadline", minutes: RUN_DEADLINE_MS / 60_000 }));
  process.exit(1);
}, RUN_DEADLINE_MS).unref();

const outcomes = { sent: 0, stored: 0, modelOff: 0, refused: 0, failed: 0, stopped: 0, skipped: 0 };

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
  try {
    const response = await fetch(ingestUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${ingestSecret}`, "content-type": "application/json" },
      body: JSON.stringify(subject),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const answer = await response.json().catch(() => ({}));
    outcomes.sent += 1;
    if (answer.judged === true) outcomes.stored += Number(answer.stored) || 0;
    else if (answer.reason === "model_off") outcomes.modelOff += 1;
    else if (answer.refused) outcomes.refused += 1;
    else outcomes.failed += 1;
  } catch (error) {
    // Unknown outcome: the app may have stored it. Not repeated.
    outcomes.failed += 1;
    console.warn(JSON.stringify({ event: "product_research_scout_send_unknown", subject: subject.subject, error: errorCode(error) }));
  }
}

// ---------------------------------------------------------------- pages

async function screenshot(page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
  const viewport = page.viewportSize();
  const clip = { x: 0, y: 0, width: viewport.width, height: Math.max(viewport.height, Math.min(height, SCREENSHOT_MAX_HEIGHT)) };
  for (const quality of [60, 40, 25]) {
    const bytes = await page.screenshot({ type: "jpeg", quality, clip, fullPage: true });
    const base64 = bytes.toString("base64");
    if (base64.length <= IMAGE_BASE64_LIMIT) return base64;
  }
  return null;
}

async function capturePage(browser, rules, target) {
  const images = [];
  const consoleErrors = [];
  const sameOriginErrors = [];
  let documentLang = null;
  for (const viewport of VIEWPORTS) {
    rules.tally = new AbortTally();
    rules.stops = [];
    const { context } = await ruledContext(browser, {
      allowedOrigins: [SCOUT_PAGE_ORIGIN],
      locale: SCOUT_LOCALES[target.lang],
      playwrightRoute: false,
      tally: rules.tally,
    });
    try {
      await context.setDefaultTimeout(PAGE_TIMEOUT_MS);
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
        if (originOf(response.url()) === SCOUT_PAGE_ORIGIN && response.status() >= 400 && sameOriginErrors.length < 5) {
          sameOriginErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
        }
      });
      await page.goto(`${SCOUT_PAGE_ORIGIN}${target.path}`, { waitUntil: "load", timeout: PAGE_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
      if (rules.stops.length > 0) return { stopped: rules.stops[0].stop };
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
    `expected language: ${target.lang}; document lang attribute: ${documentLang ?? "none"}`,
    `console errors (not caused by the scout's own blocking): ${consoleErrors.length ? `\n- ${consoleErrors.join("\n- ")}` : "none"}`,
    `same-origin responses with status 400 or more: ${sameOriginErrors.length ? sameOriginErrors.join(", ") : "none"}`,
  ].join("\n");
  return { subject: { kind: "page", subject: target.id, language: target.lang, images, signals } };
}

async function walkPages() {
  const browser = await launch([resolverRules([new URL(SCOUT_PAGE_ORIGIN).hostname])]);
  try {
    const rules = await installCdpRules(browser, [SCOUT_PAGE_ORIGIN]);
    for (const target of SCOUT_PAGES) {
      const captured = await capturePage(browser, rules, target);
      if (captured.subject) await deliver(captured.subject);
      else {
        outcomes[captured.stopped ? "stopped" : "skipped"] += 1;
        console.warn(JSON.stringify({ event: "product_research_scout_page_not_captured", page: target.id, ...captured }));
      }
    }
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- generated files

const xmlText = (xml) => xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

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
      const parts = unzipSync(bytes);
      const textParts = Object.keys(parts)
        .filter((name) => /^(word\/document|xl\/sharedStrings|ppt\/slides\/slide\d+)\.xml$/.test(name))
        .sort();
      const text = textParts.map((name) => xmlText(strFromU8(parts[name]))).join("\n").slice(0, 1_500);
      await deliver({
        kind: "file",
        subject: probe.id,
        signals: `${bytes.byteLength} bytes, ${Object.keys(parts).length} package parts.\n${specLine}\nText the file contains:\n${text}`,
      });
    }
  }
}

async function pdfFirstPage(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true, isEvalSupported: false, useSystemFonts: false });
  try {
    const document = await loadingTask.promise;
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1.25 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, canvas, viewport }).promise;
    return canvas.toBuffer("image/png").toString("base64");
  } finally {
    await loadingTask.destroy();
  }
}

// ---------------------------------------------------------------- catalogue

async function walkCatalogue() {
  const { parseCatalogue, productConsistencyReport } = await import("../report-product-consistency-core.mjs");
  const { getWebSearchCapability, WEB_SEARCH_CAPABILITIES } = await import("../../lib/webSearchCapability.ts");
  const response = await fetch(`${SCOUT_PAGE_ORIGIN}/api/models/catalog`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
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
console.log(JSON.stringify({ event: "product_research_scout_run", elapsedMs: Date.now() - startedAt, ...outcomes, mode: outDir ? "local" : "send" }));

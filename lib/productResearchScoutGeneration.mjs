// What the Scout's walker does as the test account beyond looking
// (docs/policy/product-research-agent.md §14): it asks the product for a real
// file or image and reports what came back, for the model to judge. Also the
// capture helpers the walker's other steps share.

import { unzipSync, strFromU8 } from "fflate";
import { ruledContext } from "./productResearchScoutBrowser.mjs";
import {
  SCOUT_LOCALES,
  errorCode,
  isSignedOutPath,
  scoutTurnWrites,
} from "./productResearchScoutBrowserPolicy.mjs";

export const SCOUT_PAGE_TIMEOUT_MS = 45_000;
/** How long a real chat turn or image may take before the walker reports that nothing came. */
const GENERATION_TIMEOUT_MS = 4 * 60_000;
const IMAGE_POLL_MS = 5_000;
/** Taller than this is cut: the model reads the top of a page best, and the body stays bounded. */
const SCREENSHOT_MAX_HEIGHT = 2_400;
const IMAGE_BASE64_LIMIT = 1_400_000;
const SIGNALS_LIMIT = 4_000;

export async function screenshot(page) {
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

const xmlText = (xml) => xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** An Office file's part count and the text of its documents, bounded for the model. */
export function officePackage(bytes) {
  const parts = unzipSync(bytes);
  const textParts = Object.keys(parts)
    // A workbook's cell text is in its worksheets (the renderer writes inline strings) and in sharedStrings when present.
    .filter((name) => /^(word\/document|xl\/sharedStrings|xl\/worksheets\/sheet\d+|ppt\/slides\/slide\d+)\.xml$/.test(name))
    .sort();
  return { parts: Object.keys(parts).length, text: textParts.map((name) => xmlText(strFromU8(parts[name]))).join("\n").slice(0, 1_500) };
}

export async function pdfFirstPage(bytes) {
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

/** Small enough for the model and the route, whatever size the provider returned. */
async function asJpeg(bytes) {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(bytes);
  const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
  const canvas = createCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toBuffer("image/jpeg", 80).toString("base64");
}

/** What a real file holds: a PDF's first page as an image, an Office file's text. */
async function describeFile(bytes) {
  const head = Buffer.from(bytes.subarray(0, 4)).toString("latin1");
  if (head === "%PDF") {
    const image = await pdfFirstPage(bytes).catch(() => null);
    return { image, description: `A PDF of ${bytes.byteLength} bytes.${image ? "" : " Its first page could not be drawn."}` };
  }
  if (head.startsWith("PK")) {
    try {
      const { parts, text } = officePackage(bytes);
      return { description: `An Office package of ${bytes.byteLength} bytes, ${parts} parts.\nText the file contains:\n${text}` };
    } catch {
      return { description: `${bytes.byteLength} bytes that look like an Office package but could not be opened.` };
    }
  }
  return { description: `${bytes.byteLength} bytes that are neither a PDF nor an Office package.` };
}

const elapsedSeconds = (startedAt) => Math.round((Date.now() - startedAt) / 1000);
const realPath = (prompt) => `Made through the real product as a test account. What was asked for: ${prompt}`;

/**
 * One real file: the prompt typed into the chat composer, then the card's own
 * download. POST is open only from pressing send until the answer settles, and
 * only for what a turn makes (scoutTurnWrites). A subject for the model, including
 * when no file came; null only when the session was not honoured or a challenge
 * stopped the page.
 */
export async function generateFile(browser, rules, generation, { walk, cookie, timeoutMs = GENERATION_TIMEOUT_MS }) {
  rules.stops = [];
  rules.refusedWrites = [];
  const context = await ruledContext(browser, { locale: SCOUT_LOCALES.ko, headers: walk.headers, cookies: [cookie] });
  const startedAt = Date.now();
  const facts = [realPath(generation.prompt)];
  const images = [];
  let step = "open";
  try {
    context.setDefaultTimeout(SCOUT_PAGE_TIMEOUT_MS);
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    try {
      await page.goto(`${walk.origin}/chat`, { waitUntil: "load", timeout: SCOUT_PAGE_TIMEOUT_MS });
      if (isSignedOutPath(page.url())) {
        console.warn(JSON.stringify({ event: "product_research_scout_generation_skipped", subject: generation.id, reason: "signed_out" }));
        return null;
      }
      step = "type";
      await page.getByTestId("chat-textarea").fill(generation.prompt);
      step = "send";
      rules.allowWrite = scoutTurnWrites();
      await page.getByTestId("chat-send-button").click();
      step = "wait_for_file";
      await page
        .locator('[data-testid="generated-artifact-download"], [data-testid="generated-artifact-failure"]')
        .first()
        .waitFor({ state: "visible", timeout: timeoutMs });
      rules.allowWrite = null;
      facts.push(`The answer settled after ${elapsedSeconds(startedAt)} seconds.`);
      const download = page.getByTestId("generated-artifact-download").first();
      if (await download.isVisible()) {
        step = "download";
        const [response] = await Promise.all([
          page.waitForResponse((candidate) => candidate.url().startsWith(`${walk.origin}/api/artifacts/`)),
          download.click(),
        ]);
        facts.push(`The download button answered with status ${response.status()}.`);
        if (response.ok()) {
          // The browser's own copy reads as empty while CDP Fetch holds the
          // session, so the same URL is read once more with the same session.
          const copy = await context.request.get(response.url(), { maxRedirects: 0, timeout: SCOUT_PAGE_TIMEOUT_MS });
          const file = await describeFile(await copy.body());
          facts.push(file.description);
          if (file.image) images.push({ label: "pdf-page-1", mediaType: "image/png", base64: file.image });
        }
      } else {
        const failure = await page.getByTestId("generated-artifact-failure").first().innerText();
        facts.push(`The file card shows a failure: ${failure.slice(0, 300)}`);
      }
    } catch (error) {
      rules.allowWrite = null;
      facts.push(`The walk stopped at the step "${step}" after ${elapsedSeconds(startedAt)} seconds (${errorCode(error)}). If this step is wait_for_file, no file appeared.`);
    }
    if (rules.refusedWrites.length > 0) {
      facts.push(`The walker's own rule refused these POSTs during the turn, so a failure here may be the walker's: ${rules.refusedWrites.join(", ")}.`);
    }
    // A challenge or an error document (§12) stopped the page: there is nothing to judge.
    if (rules.stops.length > 0) {
      console.warn(JSON.stringify({ event: "product_research_scout_generation_skipped", subject: generation.id, reason: rules.stops[0].stop }));
      return null;
    }
    const chat = await screenshot(page).catch(() => null);
    if (chat) images.unshift({ label: "chat", mediaType: "image/jpeg", base64: chat });
    return { kind: "file", subject: generation.id, language: "ko", images, signals: facts.join("\n").slice(0, SIGNALS_LIMIT) };
  } finally {
    rules.allowWrite = null;
    await context.close();
  }
}

/**
 * One real image, through the same route the image workspace posts to. A refusal
 * (the account's plan, a switched-off feature) is logged and answers null: there
 * is nothing the model could judge.
 */
export async function generateImage(browser, generation, { walk, cookie, timeoutMs = GENERATION_TIMEOUT_MS, pollMs = IMAGE_POLL_MS }) {
  const context = await ruledContext(browser, { locale: SCOUT_LOCALES.ko, headers: walk.headers, cookies: [cookie] });
  const startedAt = Date.now();
  const facts = [realPath(generation.prompt)];
  const api = (path) => `${walk.origin}${path}`;
  const subject = (images) => ({ kind: "file", subject: generation.id, language: "ko", images, signals: facts.join("\n").slice(0, SIGNALS_LIMIT) });
  try {
    // The same key all UTC day, so a second run that day reads the first image instead of paying again.
    const started = await context.request.post(api("/api/images/generations"), {
      headers: { origin: walk.origin },
      data: { prompt: generation.prompt, size: "1024x1024", quality: "low", idempotencyKey: `scout-image-${new Date().toISOString().slice(0, 10)}` },
      maxRedirects: 0,
      timeout: SCOUT_PAGE_TIMEOUT_MS,
    });
    if (!started.ok()) {
      const refusal = await started.json().catch(() => ({}));
      console.warn(JSON.stringify({ event: "product_research_scout_generation_skipped", subject: generation.id, status: started.status(), code: String(refusal.code ?? "") }));
      return null;
    }
    const { generationId } = await started.json();
    const deadline = Date.now() + timeoutMs;
    let state = { status: "pending" };
    while (state.status !== "succeeded" && state.status !== "failed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const read = await context.request.get(api(`/api/images/generations/${generationId}`), { maxRedirects: 0, timeout: SCOUT_PAGE_TIMEOUT_MS });
      if (read.ok()) state = await read.json();
    }
    facts.push(`Status ${state.status} after ${elapsedSeconds(startedAt)} seconds.`);
    if (state.status === "failed") facts.push(`The product's error code: ${String(state.publicErrorCode ?? "none")}.`);
    if (state.status !== "succeeded") return subject([]);
    const file = await context.request.get(api(`/api/images/generations/${generationId}/download`), { maxRedirects: 0, timeout: SCOUT_PAGE_TIMEOUT_MS });
    facts.push(`The download answered with status ${file.status()}.`);
    const base64 = file.ok() ? await asJpeg(await file.body()).catch(() => null) : null;
    if (file.ok() && !base64) facts.push("The downloaded bytes could not be read as an image.");
    return subject(base64 ? [{ label: "generated-image", mediaType: "image/jpeg", base64 }] : []);
  } finally {
    await context.close();
  }
}

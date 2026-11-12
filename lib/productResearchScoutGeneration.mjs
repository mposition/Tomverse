// What the Scout's walker does as the test account beyond looking
// (docs/policy/product-research-agent.md §14): it asks the product for a real
// file or image and reports what came back, for the model to judge. Also the
// capture helpers the walker's other steps share.

import { unzipSync, strFromU8 } from "fflate";
import { ruledContext } from "./productResearchScoutBrowser.mjs";
import {
  SCOUT_FIXTURES,
  SCOUT_LOCALES,
  errorCode,
  isSignedOutPath,
  originOf,
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
 * The synthetic files of SCOUT_FIXTURES, made here so nothing real is uploaded.
 * Text is ASCII: the walker's image may have no Korean font.
 */
export async function scoutFixtureBytes(name) {
  if (name === "sales.csv") {
    const rows = ["month,revenue,cost"];
    for (let month = 1; month <= 12; month += 1) rows.push(`2026-${String(month).padStart(2, "0")},${12_000 + month * 850},${8_000 + month * 410}`);
    return Buffer.from(`${rows.join("\n")}\n`, "utf8");
  }
  const { createCanvas } = await import("@napi-rs/canvas");
  if (name === "chart.png") {
    const canvas = createCanvas(640, 420);
    const draw = canvas.getContext("2d");
    draw.fillStyle = "#ffffff";
    draw.fillRect(0, 0, 640, 420);
    draw.fillStyle = "#111827";
    draw.font = "24px sans-serif";
    draw.fillText("Example sales, Jan-Apr 2026", 32, 44);
    [["Jan", 180], ["Feb", 240], ["Mar", 210], ["Apr", 300]].forEach(([label, height], index) => {
      draw.fillStyle = "#2563eb";
      draw.fillRect(70 + index * 140, 370 - height, 80, height);
      draw.fillStyle = "#111827";
      draw.font = "18px sans-serif";
      draw.fillText(label, 92 + index * 140, 400);
    });
    return canvas.toBuffer("image/png");
  }
  if (name === "receipt.jpg") {
    const canvas = createCanvas(420, 600);
    const draw = canvas.getContext("2d");
    draw.fillStyle = "#e5e7eb";
    draw.fillRect(0, 0, 420, 600);
    draw.fillStyle = "#fffdf7";
    draw.fillRect(40, 30, 340, 540);
    draw.fillStyle = "#1f2937";
    draw.font = "22px monospace";
    draw.fillText("EXAMPLE CAFE", 120, 80);
    draw.font = "18px monospace";
    const lines = [["Americano", "4.50"], ["Latte", "5.20"], ["Croissant", "3.80"], ["Water", "2.00"], ["", ""], ["TOTAL", "15.50"]];
    lines.forEach(([item, price], index) => {
      draw.fillText(item, 70, 150 + index * 44);
      draw.fillText(price, 290, 150 + index * 44);
    });
    return canvas.toBuffer("image/jpeg", 85);
  }
  throw new Error(`unknown fixture ${name}`);
}

/**
 * Puts the request and its attached fixtures into the account's new-chat draft,
 * the way the composer itself saves one, so the chat page opens with them in
 * place and the browser never writes before send (§11-4, §14). The upload's
 * prepare and finalise go to Tomverse with the test account's session; the bytes
 * go to the storage URL Tomverse handed back, from Node and without the Access
 * headers, so the browser's origin rule is untouched. Answers null, or why not.
 */
export async function draftWithAttachments(context, { walk, prompt, names, timeoutMs = SCOUT_PAGE_TIMEOUT_MS }) {
  const api = (path) => `${walk.origin}${path}`;
  const options = (data) => ({ headers: { origin: walk.origin }, data, maxRedirects: 0, timeout: timeoutMs });
  const references = [];
  for (const name of names) {
    const fixture = SCOUT_FIXTURES[name];
    if (!fixture) return `unknown fixture ${name}`;
    const bytes = await scoutFixtureBytes(name);
    const file = { name, mediaType: fixture.mediaType, size: bytes.byteLength };
    const prepared = await context.request.put(api("/api/chat"), options(file));
    if (!prepared.ok()) return `preparing ${name} answered ${prepared.status()}`;
    const { key, uploadUrl, uploadHeaders } = await prepared.json();
    if (typeof key !== "string" || typeof uploadUrl !== "string" || originOf(uploadUrl) === null) return `preparing ${name} gave no upload URL`;
    const stored = await fetch(uploadUrl, {
      method: "PUT",
      headers: uploadHeaders && typeof uploadHeaders === "object" ? uploadHeaders : { "Content-Type": fixture.mediaType },
      body: bytes,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await stored.arrayBuffer().catch(() => null);
    if (!stored.ok) return `storing ${name} answered ${stored.status}`;
    const finalized = await context.request.patch(api("/api/chat"), options({ key, ...file }));
    if (!finalized.ok()) return `finalising ${name} answered ${finalized.status()}`;
    const { uploadId } = await finalized.json();
    if (typeof uploadId !== "string") return `finalising ${name} gave no upload id`;
    references.push({ uploadId });
  }
  // The new-chat draft's current revision, also when a stale draft's attachment is gone (409).
  const current = await context.request.get(api("/api/products/chat/drafts/new"), { maxRedirects: 0, timeout: timeoutMs });
  const read = await current.json().catch(() => null);
  const revision = Number(read?.draft?.revision ?? read?.currentRevision ?? 0) || 0;
  const written = await context.request.put(api("/api/products/chat/drafts/new"), options({ expectedRevision: revision, text: prompt, attachmentReferences: references }));
  if (!written.ok()) return `saving the draft answered ${written.status()}`;
  return null;
}

const CARD = '[data-testid="generated-artifact-download"], [data-testid="generated-artifact-failure"]';
/** The answer is over: a file card, the report button a finished answer shows, or the error icon. */
const SETTLED = `${CARD}, [data-testid="memory-answer-feedback"], [data-testid="chat-error-icon"]`;
/** A card may land a moment after the text of the answer finishes. */
const CARD_GRACE_MS = 5_000;
const ANSWER_EXCERPT_CHARS = 1_200;

/**
 * One real chat turn: the request in the composer (typed, or with attached
 * fixtures through the draft), then the file card's own download when one comes.
 * Writes are open only from pressing send until the answer settles, and only for
 * what a turn makes (scoutTurnWrites). A subject for the model, including when no
 * file came or the answer declined; null only when the session was not honoured
 * or a challenge stopped the page.
 */
export async function generateFile(browser, rules, generation, { walk, cookie, timeoutMs = GENERATION_TIMEOUT_MS }) {
  rules.stops = [];
  rules.refusedWrites = [];
  const context = await ruledContext(browser, { locale: SCOUT_LOCALES.ko, headers: walk.headers, cookies: [cookie] });
  const startedAt = Date.now();
  const attachments = generation.attachments ?? [];
  const facts = [realPath(generation.prompt)];
  if (attachments.length > 0) {
    facts.push(`Attached to the message: ${attachments.map((name) => `${name} (${SCOUT_FIXTURES[name]?.description ?? "file"})`).join("; ")}.`);
  }
  if (generation.expectation) facts.push(`What a user would expect: ${generation.expectation}`);
  const images = [];
  let step = "open";
  try {
    context.setDefaultTimeout(SCOUT_PAGE_TIMEOUT_MS);
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    try {
      if (attachments.length > 0) {
        step = "attach";
        const refused = await draftWithAttachments(context, { walk, prompt: generation.prompt, names: attachments });
        if (refused) throw Object.assign(new Error(refused), { code: "attach_failed", detail: refused });
      }
      step = "open";
      await page.goto(`${walk.origin}/chat`, { waitUntil: "load", timeout: SCOUT_PAGE_TIMEOUT_MS });
      if (isSignedOutPath(page.url())) {
        console.warn(JSON.stringify({ event: "product_research_scout_generation_skipped", subject: generation.id, reason: "signed_out" }));
        return null;
      }
      if (attachments.length > 0) {
        step = "restore_draft";
        await page.locator('[data-testid="attachment-complete"]').nth(attachments.length - 1).waitFor({ state: "visible" });
        await page.waitForFunction(
          () => (document.querySelector('[data-testid="chat-textarea"]')?.value ?? "").trim().length > 0,
          undefined,
          { timeout: SCOUT_PAGE_TIMEOUT_MS },
        );
      } else {
        step = "type";
        await page.getByTestId("chat-textarea").fill(generation.prompt);
      }
      step = "send";
      rules.allowWrite = scoutTurnWrites();
      await page.getByTestId("chat-send-button").click();
      step = "wait_for_answer";
      await page.locator(SETTLED).first().waitFor({ state: "visible", timeout: timeoutMs });
      if (!(await page.locator(CARD).first().isVisible())) {
        await page.locator(CARD).first().waitFor({ state: "visible", timeout: CARD_GRACE_MS }).catch(() => {});
      }
      rules.allowWrite = null;
      facts.push(`The answer settled after ${elapsedSeconds(startedAt)} seconds.`);
      const answeredBy = await page.getByTestId("assistant-message-model-name").last().innerText({ timeout: 1_000 }).catch(() => "");
      if (answeredBy.trim()) facts.push(`The answer is labelled as coming from: ${answeredBy.trim().slice(0, 80)}.`);
      const answer = await page.locator('[data-testid="chat-message"][data-message-role="assistant"]').last().innerText({ timeout: 1_000 }).catch(() => "");
      if (answer.trim()) facts.push(`The answer's text (first ${ANSWER_EXCERPT_CHARS} characters):\n${answer.trim().slice(0, ANSWER_EXCERPT_CHARS)}`);
      const download = page.getByTestId("generated-artifact-download").first();
      const failure = page.getByTestId("generated-artifact-failure").first();
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
      } else if (await failure.isVisible()) {
        facts.push(`The file card shows a failure: ${(await failure.innerText()).slice(0, 300)}`);
      } else {
        facts.push("The answer finished without a file card: no file was made.");
      }
    } catch (error) {
      rules.allowWrite = null;
      const detail = error?.code === "attach_failed" ? `: ${error.detail}` : "";
      facts.push(`The walk stopped at the step "${step}" after ${elapsedSeconds(startedAt)} seconds (${errorCode(error)}${detail}). If this step is wait_for_answer, no answer finished in time.`);
    }
    if (rules.refusedWrites.length > 0) {
      facts.push(`The walker's own rule refused these writes during the turn, so a failure here may be the walker's: ${rules.refusedWrites.join(", ")}.`);
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

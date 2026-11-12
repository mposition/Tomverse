// Real screens for one creative short, recorded fresh (owner 2026-11-12: films
// keep coming out about travel because the only capture packs on the box are
// one travel question; each film should take a different subject at random).
//
//   node fresh-review.mjs <locale> <out-dir> <question-file> <topic> [--dry]
//
// Opens Tomverse Review on tomverse.app with the marketing demo account
// (~/.config/tomverse/demo-state.json, a secret: never printed), asks the
// question ONCE to GPT 6 Luna, Claude Haiku 5.5 and Gemini Flash, runs the
// answer analysis ONCE, and writes screenshots plus <out-dir>/pack.json in the
// capture-pack shape (creative-core normalizePack). Each capture's text is the
// text visible in that screenshot, so a film can quote only what it shows.
//
// Paid: the two steps spend the demo account's credits. The creative job runs
// this only when MARKETING_CREATIVE_FRESH_REVIEW=on. No step is retried after
// a paid one; an out-dir that already holds a recording is refused.
// --dry stops before the send: nothing is paid, only the composer is captured.
//
// The demo account's language and theme are switched for the recording and
// restored in finally (owner OK 2026-10-31 for recordings).
//
// Exit 0 recorded, 1 stopped before any paid step, 2 usage, 3 a recording
// was started in this folder already, 4 stopped after a paid step, 5 the
// account settings were not restored (stop and look; the pack is kept when the
// recording itself finished). A non-dry run claims <out-dir>/started.json first.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FRESH_REVIEW_ENV = "MARKETING_CREATIVE_FRESH_REVIEW";

/**
 * Everyday subjects a film's question can come from. Tone (owner 2026-11-11):
 * nothing that reads as death, illness, loss or danger, so no health, medicine,
 * accidents or grief. Travel stays one subject among many.
 */
export const SUBJECTS = Object.freeze([
  "cooking dinner for friends",
  "weekly meal prep on a budget",
  "choosing a first laptop",
  "planning a small birthday party",
  "learning a new language",
  "studying for an exam",
  "preparing for a job interview",
  "writing a cover letter",
  "starting a vegetable garden",
  "caring for a new puppy",
  "decorating a small apartment",
  "moving to a new city",
  "a weekend hobby: film photography",
  "learning to play the guitar",
  "picking a book club novel",
  "a short travel weekend",
  "planning a family picnic",
  "budgeting for a first car",
  "naming a small online shop",
  "making a simple website",
  "organising a home office",
  "choosing a board game for a family night",
  "a beginner's running plan for a 5 km fun run",
  "writing a speech for a friend's wedding",
]);

/**
 * A subject at random, never one of the last `recent` films' subjects
 * (history entries carry `subject` from this list; older ones have none).
 */
export function pickSubject(history = [], random = Math.random, recent = 6) {
  const used = new Set(history.slice(-recent).map((entry) => entry?.subject).filter(Boolean));
  const open = SUBJECTS.filter((subject) => !used.has(subject));
  const from = open.length > 0 ? open : SUBJECTS;
  return from[Math.min(from.length - 1, Math.floor(random() * from.length))];
}

export const FRESH_LOCALES = Object.freeze(["en", "ko", "zh-Hant"]);
// The names production's model catalogue shows (it is set in Admin, not lib/models.ts): all three
// were found and chosen on tomverse.app by --dry runs in en, ko and zh-Hant on 2026-11-12, and are
// the ones the approved Review shorts show. A name the catalogue no longer has stops the recording
// before the send (exit 1, nothing paid).
const MODELS = Object.freeze(["GPT 6 Luna", "Claude Haiku 5.5", "Gemini Flash"]);
// The app's own words (lib/reviewWorkspaceCopy.ts).
const LABELS = Object.freeze({
  en: { models: /Selected models/u, pro: "Professional", side: "Side by side", browser: "en-AU" },
  ko: { models: /선택한 모델/u, pro: "전문가", side: "나란히 비교", browser: "ko-KR" },
  "zh-Hant": { models: /已選模型/u, pro: "Professional", side: "並排比較", browser: "zh-TW" },
});

/**
 * Runs in the page (page.evaluate): the words of <sel> (or the body) a viewer can see, split by
 * Intl.Segmenter (so ko and zh split too). A word counts only when every box of it lies wholly
 * inside the viewport and every clipping ancestor; a hidden run becomes one ellipsis, so no quote
 * joins across it.
 */
export function visibleTextInPage(sel) {
  const root = sel ? document.querySelector(sel) : document.body;
  if (!root) return "";
  // The boxes a node's text is clipped to (viewport first), or null when it is not shown at all.
  const clipsOf = (element) => {
    const boxes = [{ top: 0, left: 0, bottom: innerHeight, right: innerWidth }];
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return null;
      if (/(hidden|auto|scroll|clip)/u.test(`${style.overflowX} ${style.overflowY}`)) boxes.push(node.getBoundingClientRect());
    }
    return boxes;
  };
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  const range = document.createRange();
  const parts = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement || !node.textContent.trim()) continue;
    const clips = clipsOf(node.parentElement);
    if (!clips) continue;
    for (const { segment, index } of segmenter.segment(node.textContent)) {
      if (!segment.trim()) {
        parts.push(" ");
        continue;
      }
      range.setStart(node, index);
      range.setEnd(node, index + segment.length);
      // Whole: every box of the word (one per line it wraps over) fully inside every clip, so a word
      // cut at a panel's edge, or wrapped onto a hidden line, is not quotable.
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      const shown = rects.length > 0 && rects.every((rect) => clips.every((box) => rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5));
      parts.push(shown ? segment : " … ");
    }
    parts.push(" ");
  }
  return parts.join("").replace(/(?:\s*…\s*)+/gu, " … ").replace(/\s+/gu, " ").replace(/^ … | … $/gu, "").trim().slice(0, 4000);
}

async function record({ locale, outDir, question, dry }) {
  const { chromium } = await import("playwright");
  const L = LABELS[locale];
  const state = path.join(homedir(), ".config", "tomverse", "demo-state.json");
  const captures = {};
  const log = [];
  let paid = 0;
  let restore = null;
  let result = null;
  const DRY = Symbol("dry run ends before the send");
  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", locale: L.browser });
  const page = await context.newPage();
  const settings = (body) =>
    page.evaluate(async (payload) => {
      const response = await fetch("/api/user/settings", payload ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {});
      const json = await response.json().catch(() => ({}));
      return { status: response.status, language: json.language ?? json.settings?.language, theme: json.theme ?? json.settings?.theme };
    }, body ?? null);
  // The words a viewer can see in the frame (visibleTextInPage): word by word, whole words only.
  const visibleText = (selector) => page.evaluate(visibleTextInPage, selector ?? null);
  // The account's own sidebar (its other conversations) and its analytics notice never go into a
  // film; the notice is hidden, not answered, so the account's settings stay as they are. Set
  // through the CSSOM, which the site's CSP allows (an injected <style> is refused), before every capture.
  const hideSidebar = () =>
    page.evaluate(() => {
      for (const element of document.querySelectorAll('[data-testid="chat-sidebar"],[data-testid="chat-sidebar-rail"],[data-testid="chat-consent-notice"]')) element.style.setProperty("visibility", "hidden", "important");
    });
  const capture = async (name, shows, selector) => {
    const file = `${name}.png`;
    await hideSidebar();
    await page.screenshot({ path: path.join(outDir, file) });
    captures[name] = { file, text: await visibleText(selector), shows };
    log.push({ capture: name });
  };
  try {
    await page.goto(`https://tomverse.app/review?lang=${locale}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    const now = await settings();
    if (now.status !== 200 || !now.language) throw new Error(`settings unreadable (${now.status}); is the demo login signed out?`);
    restore = { language: now.language, theme: now.theme };
    await settings({ language: locale, theme: "light" });
    await page.goto(`https://tomverse.app/review?lang=${locale}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);
    // Any welcome or tip dialog: dismissed without choosing anything.
    for (let k = 0; k < 2; k += 1) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
    if (await page.evaluate(() => document.documentElement.classList.contains("dark"))) throw new Error("the page is still dark");
    const professional = page.getByRole("button", { name: L.pro, exact: true });
    if (await professional.count()) await professional.first().click();
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: L.models }).first().click();
    await page.waitForTimeout(1000);
    const all = page.locator('[data-testid="model-picker-open-all"]');
    if (await all.count()) await all.first().click();
    await page.waitForTimeout(1000);
    // In the picker: each option's own pressed state, by its exact name ("GPT 6 Luna", not "GPT-5.6 Luna").
    const option = (name) => page.locator('[data-testid="model-option"]').filter({ has: page.getByTestId("model-option-name").getByText(name, { exact: true }) });
    const selected = () =>
      page.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid="model-option"][aria-pressed="true"] [data-testid="model-option-name"]')].map((node) => node.textContent.trim()))].sort());
    for (const name of await selected()) {
      if (!MODELS.includes(name)) {
        await option(name).first().click();
        await page.waitForTimeout(500);
      }
    }
    for (const name of MODELS) {
      if ((await option(name).first().getAttribute("aria-pressed")) === "true") continue;
      await option(name).first().click();
      await page.waitForTimeout(700);
    }
    const chosen = await selected();
    if (chosen.join("|") !== [...MODELS].sort().join("|")) throw new Error(`models are ${JSON.stringify(chosen)}, not the three; nothing sent`);
    await page.locator('[data-testid="model-picker-done"]').first().click();
    await page.waitForTimeout(1000);
    // Web search off: it costs more and the locales should ask the same way (the chip's remove button).
    const web = page.locator('[data-testid="web-search-mode-chip"] button:last-of-type');
    if (await web.count()) {
      await web.first().click();
      await page.waitForTimeout(600);
    }
    if (await page.locator('[data-testid="web-search-mode-chip"]').count()) throw new Error("web search is still on; nothing sent");

    const box = page.locator('[data-testid="chat-input"] textarea').first();
    await box.click();
    await box.fill("");
    await page.keyboard.type(question, { delay: 25 });
    await page.waitForTimeout(800);
    // The whole question must show in the box (no inner scroll), since the capture's text is the question.
    const whole = await box.evaluate((area) => area.value === area.value.trim() && area.scrollHeight <= area.clientHeight + 1);
    if (!whole) throw new Error("the question does not fit the box; nothing sent");
    await capture("question", "the question typed in Review, three models chosen");
    captures.question.text = question;
    if (dry) throw DRY;

    // Marked paid before the click: a click that sent and then threw must count as sent.
    paid = 1;
    log.push({ paid: "send attempted" });
    await page.locator('[data-testid="chat-send-button"]').click();
    const entry = page.locator('[data-testid="studio-analysis-entry"]');
    await entry.locator("button:not([disabled])").first().waitFor({ timeout: 300_000 });
    let last = -1;
    for (let k = 0, still = 0; k < 240 && still < 4; k += 1) {
      await page.waitForTimeout(1000);
      const length = await page.evaluate(() => document.body.innerText.length);
      still = length === last ? still + 1 : 0;
      last = length;
    }
    await page.getByRole("button", { name: L.side }).first().click();
    await page.waitForTimeout(2000);
    await capture("answers", "the three answers side by side, from the top");
    for (const x of [640, 940, 1240]) {
      await page.mouse.move(x, 520);
      for (let k = 0; k < 6; k += 1) {
        await page.mouse.wheel(0, 110);
        await page.waitForTimeout(150);
      }
    }
    await page.waitForTimeout(800);
    await capture("answers-more", "the three answers side by side, each scrolled further down");

    paid = 2;
    log.push({ paid: "analysis attempted" });
    await entry.locator("button").first().click();
    await page.locator('[data-testid="studio-analysis-entry"][data-state="done"]').waitFor({ state: "attached", timeout: 300_000 });
    await page.waitForTimeout(2500);
    await capture("summary", "Tomverse answer analysis: its summary", ".studio-analysis-panel");
    const tab = page.getByRole("tab").nth(1);
    if (await tab.count()) {
      await tab.click();
      await page.waitForTimeout(2000);
      await capture("differences", "Tomverse answer analysis: where the answers differ, with their quotes", ".studio-analysis-panel");
    }
    result = { code: 0, paid, captures, log };
  } catch (error) {
    if (error === DRY) {
      result = { code: 0, paid, captures, log };
    } else {
      log.push({ error: String(error?.message ?? error).slice(0, 400) });
      await page.screenshot({ path: path.join(outDir, "error.png") }).catch(() => {});
      result = { code: paid ? 4 : 1, paid, captures, log };
    }
  } finally {
    // The account's own language and theme back, checked by reading them again. If that fails the
    // caller stops (exit 5): the next recording would take the temporary values as the originals.
    if (restore) {
      const back = await settings(restore).catch((error) => ({ error: String(error) }));
      const now = await settings().catch((error) => ({ error: String(error) }));
      const restored = back.status === 200 && now.status === 200 && now.language === restore.language && (restore.theme === undefined || now.theme === restore.theme);
      log.push({ restored, back, now });
      if (!restored) result = { ...(result ?? { paid, captures, log }), code: 5 };
    }
    await context.storageState({ path: state }).catch(() => {});
    await browser.close().catch(() => {});
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [locale, outArg, questionFile, topic] = process.argv.slice(2);
  const dry = process.argv.includes("--dry");
  if (!FRESH_LOCALES.includes(locale) || !outArg || !questionFile || !/^[a-z0-9-]{3,60}$/u.test(topic ?? "")) {
    console.error("usage: node fresh-review.mjs <en|ko|zh-Hant> <out-dir> <question-file> <topic> [--dry]");
    process.exit(2);
  }
  const outDir = path.resolve(outArg);
  const question = readFileSync(questionFile, "utf8").trim();
  if (question.length < 8 || question.length > 200 || question.includes("\n") || question.includes("\r")) {
    console.error("the question must be one line of 8-200 characters");
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  // One recording at a time on the demo account, from any folder or run, dry runs included: each
  // switches the account's language and theme. Taken exclusively (O_EXCL) before the browser opens
  // and given back only after the settings were read back as restored; after a kill or a failed
  // restore it stays, and every later recording refuses until a person has looked at the account
  // and removed it.
  const lock = path.join(homedir(), ".local", "state", "tomverse", "demo-account.lock");
  mkdirSync(path.dirname(lock), { recursive: true });
  try {
    closeSync(openSync(lock, "wx"));
    writeFileSync(lock, JSON.stringify({ locale, outDir, at: new Date().toISOString(), pid: process.pid }));
  } catch {
    console.log(JSON.stringify({ step: "fresh-review", locale, refused: `the demo account is in use or was left locked (${lock}); nothing sent` }));
    process.exit(1);
  }
  // Claimed before the browser opens, exclusively (O_EXCL): a second run, at the same time or after
  // a crash, a kill or an unknown end past a paid step, finds it and never sends again.
  if (!dry) {
    try {
      closeSync(openSync(path.join(outDir, "started.json"), "wx"));
      writeFileSync(path.join(outDir, "started.json"), JSON.stringify({ locale, question, at: new Date().toISOString(), pid: process.pid }));
    } catch {
      rmSync(lock, { force: true });
      console.log(JSON.stringify({ step: "fresh-review", locale, refused: "a recording was started here already; never sent twice" }));
      process.exit(3);
    }
  }
  const result = await record({ locale, outDir, question, dry });
  if (result.code !== 5) rmSync(lock, { force: true });
  writeFileSync(path.join(outDir, dry ? "dry-log.json" : "log.json"), JSON.stringify({ locale, question, dry, ...result }, null, 2));
  // Recorded in full (exit 0, or 5 when only the settings restore failed): the pack is usable.
  if ((result.code === 0 || result.code === 5) && !dry && result.log.every((entry) => !entry.error)) {
    // <out-dir> is job/creative/<run>/sources/<locale>: the id names the run.
    const pack = { assetId: `fresh-${path.basename(path.dirname(path.dirname(outDir)))}-${locale.toLowerCase()}`, locale, topic, question, captures: result.captures };
    writeFileSync(path.join(outDir, "pack.json"), JSON.stringify(pack, null, 2));
  }
  console.log(JSON.stringify({ step: "fresh-review", locale, dry, code: result.code, paid: result.paid, captures: Object.keys(result.captures), error: result.log.find((entry) => entry.error)?.error ?? null }));
  process.exit(result.code);
}

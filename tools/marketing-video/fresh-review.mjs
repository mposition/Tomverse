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
// Exit 0 recorded, 1 stopped before any paid step, 2 usage, 3 already
// recorded, 4 stopped after a paid step (do not run it again for this film).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const MODELS = Object.freeze(["GPT 6 Luna", "Claude Haiku 5.5", "Gemini Flash"]);
// The app's own words (lib/reviewWorkspaceCopy.ts).
const LABELS = Object.freeze({
  en: { models: /Selected models/u, side: "Side by side", browser: "en-AU" },
  ko: { models: /선택한 모델/u, side: "나란히 비교", browser: "ko-KR" },
  "zh-Hant": { models: /已選模型/u, side: "並排比較", browser: "zh-TW" },
});

async function record({ locale, outDir, question, dry }) {
  const { chromium } = await import("playwright");
  const L = LABELS[locale];
  const state = path.join(homedir(), ".config", "tomverse", "demo-state.json");
  const captures = {};
  const log = [];
  let paid = 0;
  let restore = null;
  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", locale: L.browser });
  const page = await context.newPage();
  const settings = (body) =>
    page.evaluate(async (payload) => {
      const response = await fetch("/api/user/settings", payload ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {});
      const json = await response.json().catch(() => ({}));
      return { status: response.status, language: json.language ?? json.settings?.language, theme: json.theme ?? json.settings?.theme };
    }, body ?? null);
  // The words a viewer can see in the frame: text nodes inside the viewport and inside every
  // clipping ancestor, so a quote taken from here is on screen.
  const visibleText = (selector) =>
    page.evaluate((sel) => {
      const root = sel ? document.querySelector(sel) : document.body;
      if (!root) return "";
      const inside = (element, rect) => {
        for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
          if (/(hidden|auto|scroll|clip)/u.test(`${style.overflowX} ${style.overflowY}`)) {
            const box = node.getBoundingClientRect();
            if (rect.bottom <= box.top || rect.top >= box.bottom || rect.right <= box.left || rect.left >= box.right) return false;
          }
        }
        return true;
      };
      const words = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent.replace(/\s+/gu, " ").trim();
        if (!text || !node.parentElement) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const seen = [...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && inside(node.parentElement, rect));
        if (seen) words.push(text);
      }
      return words.join(" ").replace(/\s+/gu, " ").slice(0, 4000);
    }, selector ?? null);
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
    const professional = page.getByRole("button", { name: "Professional" });
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
    await capture("question", "the question typed in Review, three models chosen");
    captures.question.text = question;
    if (dry) return { code: 0, paid, captures, log };

    await page.locator('[data-testid="chat-send-button"]').click();
    paid = 1;
    log.push({ paid: "sent" });
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

    await entry.locator("button").first().click();
    paid = 2;
    log.push({ paid: "analysis" });
    await page.locator('[data-testid="studio-analysis-entry"][data-state="done"]').waitFor({ state: "attached", timeout: 300_000 });
    await page.waitForTimeout(2500);
    await capture("summary", "Tomverse answer analysis: its summary", ".studio-analysis-panel");
    const tab = page.getByRole("tab").nth(1);
    if (await tab.count()) {
      await tab.click();
      await page.waitForTimeout(2000);
      await capture("differences", "Tomverse answer analysis: where the answers differ, with their quotes", ".studio-analysis-panel");
    }
    return { code: 0, paid, captures, log };
  } catch (error) {
    log.push({ error: String(error?.message ?? error).slice(0, 400) });
    await page.screenshot({ path: path.join(outDir, "error.png") }).catch(() => {});
    return { code: paid ? 4 : 1, paid, captures, log };
  } finally {
    if (restore) log.push({ restored: await settings(restore).catch((error) => ({ error: String(error) })) });
    await context.storageState({ path: state }).catch(() => {});
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [locale, outArg, questionFile, topic] = process.argv.slice(2);
  const dry = process.argv.includes("--dry");
  if (!FRESH_LOCALES.includes(locale) || !outArg || !questionFile || !/^[a-z0-9-]{3,60}$/u.test(topic ?? "")) {
    console.error("usage: node fresh-review.mjs <en|ko|zh-Hant> <out-dir> <question-file> <topic> [--dry]");
    process.exit(2);
  }
  const outDir = path.resolve(outArg);
  if (!dry && (existsSync(path.join(outDir, "pack.json")) || existsSync(path.join(outDir, "log.json")))) {
    console.log(JSON.stringify({ step: "fresh-review", locale, refused: "already recorded here; never sent twice" }));
    process.exit(3);
  }
  const question = readFileSync(questionFile, "utf8").trim();
  if (question.length < 8 || question.length > 200) {
    console.error("the question must be 8-200 characters");
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  const result = await record({ locale, outDir, question, dry });
  writeFileSync(path.join(outDir, dry ? "dry-log.json" : "log.json"), JSON.stringify({ locale, question, dry, ...result }, null, 2));
  if (result.code === 0 && !dry) {
    const pack = { assetId: `fresh-${path.basename(path.dirname(outDir))}-${locale.toLowerCase()}`, locale, topic, question, captures: result.captures };
    writeFileSync(path.join(outDir, "pack.json"), JSON.stringify(pack, null, 2));
  }
  console.log(JSON.stringify({ step: "fresh-review", locale, dry, code: result.code, paid: result.paid, captures: Object.keys(result.captures), error: result.log.find((entry) => entry.error)?.error ?? null }));
  process.exit(result.code);
}

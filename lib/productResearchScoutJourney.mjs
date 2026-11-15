// The Scout's journey (docs/policy/product-research-agent.md §14): the walker
// follows the steps the app's planner model wrote, as the test account, and
// records what each step left on screen -- the address, the composer, the open
// dialogs, the answers -- with a picture of every step. The model then judges the
// whole run, so a defect that only shows between two screens has the two screens.

import { ruledContext } from "./productResearchScoutBrowser.mjs";
import { SCOUT_FIXTURES, SCOUT_LOCALES, errorCode, isSignedOutPath, scoutJourneyWrites } from "./productResearchScoutBrowserPolicy.mjs";
import { GENERATION_TIMEOUT_MS, SCOUT_PAGE_TIMEOUT_MS, draftWithAttachments, waitForAnswer } from "./productResearchScoutGeneration.mjs";

const VIEWPORTS = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };
const STEP_SETTLE_MS = 1_500;
const CLICK_TIMEOUT_MS = 5_000;
const FRAMES_PER_SHEET = 4;
const SIGNALS_LIMIT = 4_000;

/** The named controls of JOURNEY_ANCHORS, each a list of places it lives in the product's shells. */
const ANCHOR_SELECTORS = {
  menu: ['[data-testid="mobile-sidebar-open"]', "button.review-navigation-history", '[data-testid="sidebar-expand-button"]'],
  "new-chat": ["button.review-new-task", '[data-testid="sidebar-new-chat"]'],
};
const CLICKABLE_ROLES = ["button", "link", "menuitem", "tab", "option", "checkbox"];

async function firstVisible(locator) {
  const count = Math.min(await locator.count(), 20);
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible()) return locator.nth(index);
  }
  return null;
}

/** The element a click step names: an anchor, the Nth history row, or a control by its visible name. */
async function clickTarget(page, value) {
  for (const selector of ANCHOR_SELECTORS[value] ?? []) {
    const found = await firstVisible(page.locator(selector));
    if (found) return found;
  }
  if (ANCHOR_SELECTORS[value]) return null;
  const row = /^conversation:([1-9])$/.exec(value);
  if (row) {
    const rows = page.locator('[data-testid="sidebar-conversation-item"]');
    const visible = [];
    for (let index = 0; index < Math.min(await rows.count(), 30) && visible.length < Number(row[1]); index += 1) {
      if (await rows.nth(index).isVisible()) visible.push(rows.nth(index));
    }
    return visible[Number(row[1]) - 1] ?? null;
  }
  for (const role of CLICKABLE_ROLES) {
    const found = await firstVisible(page.getByRole(role, { name: value }));
    if (found) return found;
  }
  return firstVisible(page.getByText(value));
}

/** What a step left: measured in the page, never read by the model as instructions. */
const pageState = (page) =>
  page.evaluate(() => {
    const shown = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const composer = document.querySelector('[data-testid="chat-textarea"]');
    return {
      path: location.pathname,
      composer: composer && shown(composer) ? composer.value : null,
      attachments: [...document.querySelectorAll('[data-testid="attachment-complete"]')].filter(shown).length,
      dialogs: [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(shown).length,
      historyShown: [...document.querySelectorAll('[data-testid="sidebar-conversation-list"]')].some(shown),
      answers: document.querySelectorAll('[data-testid="chat-message"][data-message-role="assistant"]').length,
      images: document.querySelectorAll('[data-testid="chat-image-turn"] img').length,
      captions: [...document.querySelectorAll('[data-testid="chat-image-turn"] figcaption')].map((node) => (node.textContent ?? "").trim()).filter(Boolean).slice(-3),
      lastAnswer: ([...document.querySelectorAll('[data-testid="chat-message"][data-message-role="assistant"]')].at(-1)?.innerText ?? "").trim().slice(0, 200),
    };
  });

const describeStep = (label, state, note) => {
  if (!state) return `${label}: ${note ?? "the page could not be read"}.`;
  const composer = state.composer === null ? "no composer on screen" : `composer holds ${JSON.stringify(state.composer.slice(0, 120))}`;
  return [
    `${label}${note ? ` -- ${note}` : ""}: at ${state.path}; ${composer}, ${state.attachments} attachment(s);`,
    `${state.dialogs} open dialog(s) or drawer(s); history list ${state.historyShown ? "shown" : "hidden"};`,
    `${state.answers} answer(s), ${state.images} image(s)${state.captions.length ? ` captioned ${state.captions.map((caption) => JSON.stringify(caption.slice(0, 60))).join(", ")}` : ""}`,
    state.lastAnswer ? `; last answer begins ${JSON.stringify(state.lastAnswer)}.` : ".",
  ].join(" ");
};

/** Every step's screen, four to a sheet with the step's number, so a run fits the subject's three images. */
export async function journeySheets(frames, viewport) {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const scale = viewport.width > 600 ? 0.5 : 0.8;
  const width = Math.round(viewport.width * scale);
  const height = Math.round(viewport.height * scale);
  const sheets = [];
  for (let first = 0; first < frames.length; first += FRAMES_PER_SHEET) {
    const group = frames.slice(first, first + FRAMES_PER_SHEET);
    const canvas = createCanvas(width * 2, height * Math.ceil(group.length / 2));
    const draw = canvas.getContext("2d");
    draw.fillStyle = "#ffffff";
    draw.fillRect(0, 0, canvas.width, canvas.height);
    for (const [index, frame] of group.entries()) {
      const x = (index % 2) * width;
      const y = Math.floor(index / 2) * height;
      draw.drawImage(await loadImage(Buffer.from(frame.base64, "base64")), x, y, width, height);
      draw.fillStyle = "#dc2626";
      draw.fillRect(x, y, 96, 30);
      draw.fillStyle = "#ffffff";
      draw.font = "bold 18px sans-serif";
      draw.fillText(frame.label, x + 8, y + 21);
      draw.strokeStyle = "#111827";
      draw.strokeRect(x, y, width, height);
    }
    sheets.push({ label: `steps-${first}-${first + group.length - 1}`, mediaType: "image/jpeg", base64: canvas.toBuffer("image/jpeg", 70).toString("base64") });
  }
  return sheets;
}

/**
 * Follows one planned journey and answers the subject for the model, or null
 * when the session was not honoured or a challenge stopped the page. It starts on
 * a new chat, with the planned draft (text and fixtures) put in place the way the
 * composer saves one. A step that cannot be done is recorded and the next is
 * tried; sends wait for the answer to settle.
 */
export async function walkJourney(browser, rules, journey, { walk, cookie, timeoutMs = GENERATION_TIMEOUT_MS }) {
  rules.stops = [];
  rules.refusedWrites = [];
  const viewport = VIEWPORTS[journey.viewport];
  const context = await ruledContext(browser, { locale: SCOUT_LOCALES.ko, headers: walk.headers, cookies: [cookie] });
  const writes = scoutJourneyWrites();
  const frames = [];
  const facts = [
    `A journey through the real product as a test account on a ${journey.viewport} screen (${viewport.width}x${viewport.height}), following steps a planner wrote. Step 0 is the new chat it starts on.`,
    `What a user would expect: ${journey.expectation}`,
  ];
  if (journey.start.text || journey.start.attachments.length) {
    facts.push(`Before step 0 the new-chat draft holds ${JSON.stringify(journey.start.text)}${journey.start.attachments.length ? ` and ${journey.start.attachments.map((name) => `${name} (${SCOUT_FIXTURES[name]?.description ?? "file"})`).join("; ")}` : ""}.`);
  }
  let signedOut = false;
  const record = async (page, label, note) => {
    facts.push(describeStep(label, await pageState(page).catch(() => null), note));
    const bytes = await page.screenshot({ type: "jpeg", quality: 55 }).catch(() => null);
    if (bytes) frames.push({ label, base64: bytes.toString("base64") });
  };
  try {
    context.setDefaultTimeout(SCOUT_PAGE_TIMEOUT_MS);
    const page = await context.newPage();
    await page.setViewportSize(viewport);
    rules.allowWrite = writes;
    if (journey.start.text || journey.start.attachments.length) {
      const refused = await draftWithAttachments(context, { walk, prompt: journey.start.text, names: journey.start.attachments });
      if (refused) facts.push(`The start draft could not be put in place: ${refused}.`);
    }
    await page.goto(`${walk.origin}/chat`, { waitUntil: "load", timeout: SCOUT_PAGE_TIMEOUT_MS });
    signedOut = isSignedOutPath(page.url());
    if (signedOut) throw Object.assign(new Error("signed out"), { code: "signed_out" });
    await page.waitForTimeout(STEP_SETTLE_MS);
    await record(page, "Step 0");
    for (const [index, step] of journey.steps.entries()) {
      const label = `Step ${index + 1}`;
      let note = `${step.action}${step.value ? ` ${JSON.stringify(step.value)}` : ""}`;
      try {
        if (step.action === "open") {
          await page.goto(`${walk.origin}${step.value}`, { waitUntil: "load", timeout: SCOUT_PAGE_TIMEOUT_MS });
        } else if (step.action === "click") {
          const target = await clickTarget(page, step.value);
          if (target) await target.click({ timeout: CLICK_TIMEOUT_MS });
          else note += ", but nothing visible matched it";
        } else if (step.action === "type") {
          const composer = page.getByTestId("chat-textarea");
          if (await composer.isVisible()) await composer.fill(step.value);
          else note += ", but no composer was on screen";
        } else if (step.action === "send") {
          const button = page.getByTestId("chat-send-button");
          if (!(await button.isVisible())) note += ", but no send button was on screen";
          else if (!writes.openTurn()) note += ", but the journey's sends were used up";
          else {
            try {
              const before = await page.locator('[data-testid="chat-message"][data-message-role="assistant"]').count();
              await button.click();
              await waitForAnswer(page, before, timeoutMs);
            } finally {
              writes.closeTurn();
            }
          }
        } else if (step.action === "back") {
          await page.goBack({ waitUntil: "load", timeout: SCOUT_PAGE_TIMEOUT_MS });
        } else if (step.action === "press") {
          await page.keyboard.press(step.value);
        }
        await page.waitForTimeout(STEP_SETTLE_MS);
      } catch (error) {
        note += `, which failed (${errorCode(error)})`;
      }
      if (isSignedOutPath(page.url())) {
        facts.push(`${label}: the session ended; the journey stopped.`);
        break;
      }
      await record(page, label, note);
    }
  } catch (error) {
    facts.push(`The journey stopped (${errorCode(error)}).`);
  } finally {
    rules.allowWrite = null;
  }
  try {
    if (rules.refusedWrites.length > 0) {
      facts.push(`The walker's own rule refused these writes, so a failure after them may be the walker's: ${rules.refusedWrites.join(", ")}.`);
    }
    if (signedOut) {
      console.warn(JSON.stringify({ event: "product_research_scout_generation_skipped", subject: "generated.journey", reason: "signed_out" }));
      return null;
    }
    if (rules.stops.length > 0) {
      console.warn(JSON.stringify({ event: "product_research_scout_generation_skipped", subject: "generated.journey", reason: rules.stops[0].stop }));
      return null;
    }
    const images = frames.length ? await journeySheets(frames, viewport).catch(() => []) : [];
    return { kind: "file", subject: "generated.journey", language: "ko", images: images.slice(0, 3), signals: facts.join("\n").slice(0, SIGNALS_LIMIT) };
  } finally {
    await context.close();
  }
}

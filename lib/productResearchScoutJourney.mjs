// The Scout's journey (docs/policy/product-research-agent.md §14): the walker
// follows the steps the app's planner model wrote, as the test account, and
// records what each step left on screen -- the address, the composer, the open
// dialogs, the answers -- with a picture of every step. The model then judges the
// whole run, so a defect that only shows between two screens has the two screens.

import { ruledContext } from "./productResearchScoutBrowser.mjs";
import { SCOUT_FIXTURES, SCOUT_JOURNEY_GENERATION, SCOUT_LOCALES, errorCode, isSignedOutPath, scoutJourneyWrites } from "./productResearchScoutBrowserPolicy.mjs";
import { GENERATION_TIMEOUT_MS, SCOUT_PAGE_TIMEOUT_MS, draftWithAttachments, waitForAnswer } from "./productResearchScoutGeneration.mjs";

const VIEWPORTS = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };
const STEP_SETTLE_MS = 1_500;
const CLICK_TIMEOUT_MS = 5_000;
const FRAMES_PER_SHEET = 4;
/** How long Enter in the composer has to start a turn before it counts as not sending. */
const ENTER_SEND_WAIT_MS = 3_000;

const composerFocused = (page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "chat-textarea").catch(() => false);
const SIGNALS_LIMIT = 4_000;
/** Of a journey's lines over the limit, the setup and the latest steps are kept: the last turn and the walker's refusals come last. */
const SIGNALS_HEAD = 900;
export const fitSignals = (facts) => {
  const all = facts.join("\n");
  if (all.length <= SIGNALS_LIMIT) return all;
  const gap = "\n[earlier steps cut to fit]\n";
  return `${all.slice(0, SIGNALS_HEAD)}${gap}${all.slice(-(SIGNALS_LIMIT - SIGNALS_HEAD - gap.length))}`;
};
/** The composer's own attachments: in its tray, so the chips of earlier messages are not counted. */
const COMPOSER_ATTACHMENT = '[data-testid="attachment-tray"] [data-testid="attachment-complete"]';

/** The named controls of JOURNEY_ANCHORS, each a list of places it lives in the product's shells. */
const ANCHOR_SELECTORS = {
  menu: ['[data-testid="mobile-sidebar-open"]', "button.review-navigation-history", '[data-testid="sidebar-expand-button"]'],
  "new-chat": ["button.review-new-task", '[data-testid="sidebar-new-chat"]'],
};
const CLICKABLE_ROLES = ["button", "link", "menuitem", "tab", "option", "checkbox"];

/** Whether a person could click it now: shown, and not covered by a drawer or backdrop (a trial click). */
const clickable = async (candidate) =>
  (await candidate.isVisible()) && (await candidate.click({ trial: true, timeout: 1_000 }).then(() => true, () => false));

/** The first `count`-th clickable match, so a control hidden behind an open drawer is passed over. */
async function nthClickable(locator, nth = 1) {
  let found = 0;
  for (let index = 0; index < Math.min(await locator.count(), 30); index += 1) {
    if (await clickable(locator.nth(index)) && (found += 1) === nth) return locator.nth(index);
  }
  return null;
}

/** Where a person's eye goes first: the open dialog or drawer on top, then the page. */
async function clickScopes(page) {
  const dialogs = page.locator('[role="dialog"], [aria-modal="true"]');
  for (let index = Math.min(await dialogs.count(), 10) - 1; index >= 0; index -= 1) {
    if (await dialogs.nth(index).isVisible()) return [dialogs.nth(index), page];
  }
  return [page];
}

/** The element a click step names: an anchor, the Nth history row, or a control by its visible name. */
async function clickTarget(page, value) {
  const row = /^conversation:([1-9])$/.exec(value);
  for (const scope of await clickScopes(page)) {
    let found = null;
    if (ANCHOR_SELECTORS[value]) {
      for (const selector of ANCHOR_SELECTORS[value]) found ??= await nthClickable(scope.locator(selector));
    } else if (row) {
      found = await nthClickable(scope.locator('[data-testid="sidebar-conversation-item"]'), Number(row[1]));
    } else {
      for (const role of CLICKABLE_ROLES) found ??= await nthClickable(scope.getByRole(role, { name: value }));
      found ??= await nthClickable(scope.getByText(value));
    }
    if (found) return found;
  }
  return null;
}

/** What a step left: measured in the page, never read by the model as instructions. */
const pageState = (page) =>
  page.evaluate(() => {
    const shown = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const composer = document.querySelector('[data-testid="chat-textarea"]');
    return {
      path: location.pathname,
      composer: composer && shown(composer) ? composer.value : null,
      // The composer's own tray, so the chips of earlier messages are not counted.
      attachments: [...document.querySelectorAll('[data-testid="attachment-tray"] [data-testid="attachment-complete"]')].filter(shown).length,
      attachmentsFailed: [...document.querySelectorAll('[data-testid="attachment-tray"] [data-testid="attachment-failed"]')].filter(shown).length,
      dialogs: [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(shown).length,
      historyShown: [...document.querySelectorAll('[data-testid="sidebar-conversation-list"]')].some(shown),
      answers: document.querySelectorAll('[data-testid="chat-message"][data-message-role="assistant"]').length,
      images: document.querySelectorAll('[data-testid="chat-image-turn"] img').length,
      drawn: [...document.querySelectorAll('[data-testid="chat-image-turn"] img')].filter((picture) => picture.complete && picture.naturalWidth > 0).length,
      captions: [...document.querySelectorAll('[data-testid="chat-image-turn"] figcaption')].map((node) => (node.textContent ?? "").trim()).filter(Boolean).slice(-3),
      // Every answer's file cards, oldest first: whether each is ready, still coming or failed.
      files: [...document.querySelectorAll('[data-testid="chat-message"][data-message-role="assistant"]')].flatMap((answer, index) =>
        [...answer.querySelectorAll('[data-testid="generated-artifact-card"], [data-testid="generated-artifact-pending"]')].map((card) => ({
          answer: index + 1,
          // The card's own status (ready, failed, ...); its name, kind, size and model, or its failure sentence, are its text.
          state: card.getAttribute("data-testid") === "generated-artifact-pending" ? "pending" : card.getAttribute("data-artifact-status") || "unknown",
          text: (card.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        }))).slice(-4),
      lastAnswer: ([...document.querySelectorAll('[data-testid="chat-message"][data-message-role="assistant"]')].at(-1)?.innerText ?? "").trim().slice(0, 300),
    };
  });

const describeStep = (label, state, note) => {
  if (!state) return `${label}: ${note ?? "the page could not be read"}.`;
  const composer = state.composer === null ? "no composer on screen" : `composer holds ${JSON.stringify(state.composer.slice(0, 120))}`;
  return [
    `${label}${note ? ` -- ${note}` : ""}: at ${state.path}; ${composer}, ${state.attachments} attachment(s)${state.attachmentsFailed ? ` and ${state.attachmentsFailed} failed upload(s)` : ""};`,
    `${state.dialogs} open dialog(s) or drawer(s); history list ${state.historyShown ? "shown" : "hidden"};`,
    `${state.answers} answer(s), ${state.images} image(s)${state.images ? ` (${state.drawn} drawn in the walker's browser)` : ""}${state.captions.length ? ` captioned ${state.captions.map((caption) => JSON.stringify(caption.slice(0, 60))).join(", ")}` : ""}`,
    state.files.length ? `; file cards: ${state.files.map((file) => `answer ${file.answer} ${file.state} ${JSON.stringify(file.text)}`).join(", ")}` : "",
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
 * Follows one journey and answers the subject for the model, or null
 * when the session was not honoured or a challenge stopped the page. It starts on
 * a new chat, with the planned draft (text and fixtures) put in place the way the
 * composer saves one. A step that cannot be done is recorded and the next is
 * tried; sends wait for the answer to settle. `subject` and `author` name a
 * fixed journey (a regression check) instead of the planner's.
 */
export async function walkJourney(browser, rules, journey, { walk, cookie, subject = SCOUT_JOURNEY_GENERATION, author = "a planner", timeoutMs = GENERATION_TIMEOUT_MS, reporter = null }) {
  rules.stops = [];
  rules.refusedWrites = [];
  const viewport = VIEWPORTS[journey.viewport];
  const context = await ruledContext(browser, { locale: SCOUT_LOCALES.ko, headers: walk.headers, cookies: [cookie] });
  const writes = scoutJourneyWrites();
  const frames = [];
  const facts = [
    `A journey through the real product as a test account on a ${journey.viewport} screen (${viewport.width}x${viewport.height}), following steps ${author} wrote. Step 0 is the new chat it starts on.`,
    `What a user would expect: ${journey.expectation}`,
    "The walker's browser loads only Tomverse's own address, so a picture stored elsewhere can look broken or blank in these screens: that alone is the walker's, not a product defect. Judge a picture by its count and caption here.",
  ];
  if (journey.start.text || journey.start.attachments.length) {
    facts.push(`Before step 0 the new-chat draft holds ${JSON.stringify(journey.start.text)}${journey.start.attachments.length ? ` and ${journey.start.attachments.map((name) => `${name} (${SCOUT_FIXTURES[name]?.description ?? "file"})`).join("; ")}` : ""}.`);
  }
  let signedOut = false;
  /**
   * One paid turn: counted against the journey's sends, its writes open only until
   * the answer settles. A key that may not send (Enter can be a new line) waits a
   * moment for the turn's request and closes the writes again if none went out.
   * Answers what to add to the step's note.
   */
  const sendTurnOnce = async (page, trigger, { mayNotSend = false } = {}) => {
    if (!writes.openTurn()) return ", but the journey's sends were used up";
    try {
      const before = await page.locator('[data-testid="chat-message"][data-message-role="assistant"]').count();
      const sent = mayNotSend
        ? page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/chat", { timeout: ENTER_SEND_WAIT_MS }).then(() => true, () => false)
        : Promise.resolve(true);
      const startedAt = Date.now();
      await trigger();
      if (!(await sent)) return ", which did not send";
      await waitForAnswer(page, before, timeoutMs);
      // A file the answer makes may still be on its way: wait for its card to be ready or failed,
      // within the same budget as the answer (what the answer used is not given again).
      const made = await page.waitForFunction(
        () => ![...document.querySelectorAll('[data-testid="chat-message"][data-message-role="assistant"]')].at(-1)?.querySelector('[data-testid="generated-artifact-pending"]'),
        undefined,
        { timeout: Math.max(1_000, timeoutMs - (Date.now() - startedAt)), polling: 1_000 },
      ).then(() => "", () => ", and its file card was still being made when the walker stopped waiting");
      return `${mayNotSend ? ", which sent the message" : ""}${made}`;
    } finally {
      writes.closeTurn();
    }
  };
  /** TURN FAILED lines, put ahead of every other signal when the subject is built. */
  const turnFailures = [];
  /**
   * A send, then the product's own verdict on it (lib/productResearchScoutTurnHealth.mjs).
   * A wait that gave up after a new answer appeared is checked too, then the step fails as before.
   */
  const sendTurn = async (page, trigger, options) => {
    if (!reporter) return sendTurnOnce(page, trigger, options);
    const answers = () => page.locator('[data-testid="chat-message"][data-message-role="assistant"]').count().catch(() => 0);
    const before = await answers();
    const refusedBefore = rules.refusedWrites.length;
    // Whether the turn's request really went out, read from the page rather than from the step's wording.
    let sent = false;
    const onRequest = (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") sent = true;
    };
    page.on("request", onRequest);
    const verdict = async (timedOut) => {
      if (!sent) return null;
      const failed = await reporter
        .check(page, rules, subject, { timedOut, noAnswer: (await answers()) <= before, walkerRefused: rules.refusedWrites.length > refusedBefore })
        .catch(() => null);
      if (failed) turnFailures.push(failed);
      return failed;
    };
    try {
      const note = await sendTurnOnce(page, trigger, options);
      return (await verdict(false)) ? `${note}; the turn failed (see the TURN FAILED line)` : note;
    } catch (error) {
      await verdict(true);
      throw error;
    } finally {
      page.off("request", onRequest);
    }
  };
  /**
   * A file added the way the start draft is: saved into this conversation's draft
   * (or the new chat's) from outside the page with the composer's text, then the
   * page reloads so the composer brings the draft back. The browser itself never
   * uploads (its origin rule stays as it is).
   */
  const attachFixture = async (page, name) => {
    // On /chat the address names the open conversation: the workspace keeps `?conversation=` in step with it
    // (ChatPageClient). Answers on screen with none named means the walker cannot tell which draft is this one,
    // so it adds nothing rather than guess -- a later turn never goes out without its files because of the walker.
    const scope = new URL(page.url()).searchParams.get("conversation") || "new";
    if (scope === "new" && (await page.locator('[data-testid="chat-message"][data-message-role="assistant"]').count()) > 0) {
      return ", but the address names no conversation while answers are on screen, so the walker did not add it";
    }
    const composer = page.getByTestId("chat-textarea");
    // Without a composer the walker cannot carry the draft's text across, and writing it empty would be a draft
    // the walker lost, not the product.
    if (!(await composer.isVisible())) return ", but no composer was on screen, so the walker did not add it";
    const text = await composer.inputValue();
    const before = await page.locator(COMPOSER_ATTACHMENT).count();
    const refused = await draftWithAttachments(context, { walk, prompt: text, names: [name], scope, keep: true });
    if (refused) return `, but the walker could not add it (${refused})`;
    await page.reload({ waitUntil: "load", timeout: SCOUT_PAGE_TIMEOUT_MS });
    const shown = await page.locator(COMPOSER_ATTACHMENT).nth(before).waitFor({ state: "visible" }).then(() => true, () => false);
    return ` (${SCOUT_FIXTURES[name].description}): the walker saved it into ${scope === "new" ? "the new chat's" : "this conversation's"} draft and reloaded the page, which is the walker's step and not the product's${shown ? "" : "; the composer did not show it after the reload"}`;
  };
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
        } else if (step.action === "attach") {
          note += await attachFixture(page, step.value);
        } else if (step.action === "send") {
          const button = page.getByTestId("chat-send-button");
          if (!(await button.isVisible())) note += ", but no send button was on screen";
          else note += await sendTurn(page, () => button.click());
        } else if (step.action === "back") {
          await page.goBack({ waitUntil: "load", timeout: SCOUT_PAGE_TIMEOUT_MS });
        } else if (step.action === "press" && step.value === "Enter" && (await composerFocused(page))) {
          // Enter in the composer is how a person sends on a desktop: the same limit, writes and wait as a send.
          note += await sendTurn(page, () => page.keyboard.press("Enter"), { mayNotSend: true });
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
      console.warn(JSON.stringify({ event: "product_research_scout_generation_skipped", subject, reason: "signed_out" }));
      return null;
    }
    if (rules.stops.length > 0) {
      console.warn(JSON.stringify({ event: "product_research_scout_generation_skipped", subject, reason: rules.stops[0].stop }));
      return null;
    }
    const images = frames.length ? await journeySheets(frames, viewport).catch(() => []) : [];
    return { kind: "file", subject, language: "ko", images: images.slice(0, 3), signals: fitSignals([...turnFailures, ...facts]) };
  } finally {
    await context.close();
  }
}

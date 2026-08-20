import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  mockAuthenticatedApi,
  mockChatStream,
  prepareGuestPage,
  sendChatMessage,
} from "./support/app-fixtures";
import { restoreActiveConversation } from "./support/chat-state-fixtures";

/**
 * The chat welcome screen must never be shown about a conversation nobody has
 * established anything about yet.
 *
 * Restoring an existing conversation, and sending a follow-up in one, both used
 * to paint `chat-empty-state` over the transcript for a frame or two: the
 * shells asked "is this conversation empty" as a boolean, and the answer they
 * had before any panel reported back -- which is *not known yet* -- was filled
 * in as "empty". See lib/chatContentState.ts.
 *
 * A test that waits for the settled screen and then asserts cannot see that at
 * all: by the time the transcript is up, the welcome screen has already come
 * and gone, and every such assertion passes. So these tests do not look at the
 * end state. A MutationObserver installed before the app's first script records
 * every insertion of the welcome screen (and of the marketing hero, which has
 * no business appearing under /chat at all) for the whole lifetime of the page,
 * and the assertion is on that history.
 *
 * Run in every project: the two shells decide this separately, and the mobile
 * one renders the welcome surface in normal flow rather than as an overlay.
 */

const WELCOME = '[data-testid="chat-empty-state"]';
const LANDING_HERO = '[data-testid="landing-hero-title"]';

/**
 * One transition of a watched selector's presence in the document.
 * `present: true` is an appearance -- the thing was put on the page.
 */
type Sighting = {
  selector: string;
  present: boolean;
  at: number;
  contentState: string | null;
};

declare global {
  interface Window {
    __domSightings?: Sighting[];
    /**
     * Set by the test after the page has loaded. A full page load or a router
     * refresh builds a new JS context and wipes it, so its survival is the
     * proof that a send stayed on the same document.
     */
    __sameDocumentMarker?: string;
  }
}

/**
 * Records every appearance and disappearance of the watched selectors, from
 * before the app's first script runs until the page navigates away.
 *
 * Registered with addInitScript so it is installed on every navigation --
 * including the reload a restore test performs, which is the exact moment the
 * flicker happened.
 */
async function installDomHistoryProbe(page: Page) {
  await page.addInitScript(
    ({ welcome, hero }: { welcome: string; hero: string }) => {
      const log: Sighting[] = [];
      window.__domSightings = log;

      const selectors = [welcome, hero];
      const present: Record<string, boolean> = {};

      // The shells publish their own three-state answer; capturing it at the
      // moment of the transition is what turns a failure into a diagnosis
      // ("it appeared while the state read `unknown`") rather than a count.
      const contentState = () =>
        document
          .querySelector("[data-content-state]")
          ?.getAttribute("data-content-state") ?? null;

      const containsMatch = (node: Node, selector: string) =>
        node instanceof Element &&
        (node.matches(selector) || node.querySelector(selector) !== null);

      /**
       * Presence is tracked as a transition rather than as a count of DOM
       * insertions, for two reasons that pull in opposite directions and are
       * both real:
       *
       *   * React can build a subtree in more than one mutation batch, so
       *     counting insertions reports one appearance as several; and
       *   * a subtree inserted and removed inside a single task is gone by the
       *     time the observer callback runs, so reading only the current DOM
       *     misses exactly the single-frame flash this file exists to catch.
       *
       * Consulting the batch's addedNodes *and* the document covers both: the
       * added nodes prove an appearance that has already been undone, and the
       * `present` latch collapses a multi-batch build into one.
       */
      const settle = (records: MutationRecord[]) => {
        for (const selector of selectors) {
          const addedThisBatch = records.some((record) =>
            Array.from(record.addedNodes).some((node) => containsMatch(node, selector))
          );
          const nowPresent = document.querySelector(selector) !== null;
          if (!present[selector] && (addedThisBatch || nowPresent)) {
            present[selector] = true;
            log.push({
              selector,
              present: true,
              at: performance.now(),
              contentState: contentState(),
            });
          }
          if (present[selector] && !nowPresent) {
            present[selector] = false;
            log.push({
              selector,
              present: false,
              at: performance.now(),
              contentState: contentState(),
            });
          }
        }
      };

      new MutationObserver(settle).observe(document, {
        childList: true,
        subtree: true,
      });

      // Anything already present in the server-rendered HTML never passes
      // through the observer, so the document is sampled directly too.
      document.addEventListener("DOMContentLoaded", () => settle([]));
      settle([]);
    },
    { welcome: WELCOME, hero: LANDING_HERO }
  );
}

/** Every presence transition recorded for `selector`, in order. */
async function sightings(page: Page, selector: string) {
  return page.evaluate(
    (target) =>
      (window.__domSightings ?? []).filter((entry) => entry.selector === target),
    selector
  );
}

/** Only the appearances -- what the contract is actually about. */
async function appearances(page: Page, selector: string) {
  return (await sightings(page, selector)).filter((entry) => entry.present);
}

/** Drops the history so far, so the next assertion is about one interaction. */
async function forgetSightings(page: Page) {
  await page.evaluate(() => {
    if (window.__domSightings) window.__domSightings.length = 0;
  });
}

/**
 * The two facts every test in this file asserts: the welcome screen was never
 * inserted, and /chat never rendered the marketing home page.
 */
async function expectNoWelcomeEver(page: Page, context: string) {
  expect(
    await appearances(page, WELCOME),
    `${context}: the welcome screen appeared`
  ).toEqual([]);
  expect(
    await appearances(page, LANDING_HERO),
    `${context}: the marketing hero appeared under /chat`
  ).toEqual([]);
}

const shellTestId = (testInfo: TestInfo) =>
  testInfo.project.name.startsWith("mobile") ? "mobile-chat-shell" : "desktop-chat-shell";

const userMessages = (page: Page, text: string) =>
  page.locator('[data-message-role="user"]').filter({ hasText: text });

const GUEST_CHAT_ID = "guest_welcome_flicker";
const GUEST_MODEL = "gpt-5-6-luna";

/**
 * A guest who already has a conversation with a transcript in it, restored as
 * this tab's active chat -- the F5 case. Both stores are seeded exactly as the
 * app itself writes them: the conversation list and transcript in
 * localStorage, the active id in sessionStorage.
 */
async function seedGuestConversation(
  page: Page,
  options: { withTranscript: boolean }
) {
  await page.addInitScript(
    ({
      chatId,
      modelId,
      withTranscript,
    }: {
      chatId: string;
      modelId: string;
      withTranscript: boolean;
    }) => {
      window.localStorage.setItem(
        "guest_conversations",
        JSON.stringify([
          {
            id: chatId,
            title: "Restored guest conversation",
            selectedModels: [modelId],
            disabledPanels: [],
            webSearchMode: "off",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ])
      );
      if (withTranscript) {
        window.localStorage.setItem(
          `guest_messages_${chatId}_${modelId}`,
          JSON.stringify([
            { id: "u1", role: "user", content: "restored guest question", status: "normal" },
            { id: "a1", role: "assistant", content: "restored guest answer", status: "normal" },
          ])
        );
      }
      window.sessionStorage.setItem("tomverse_active_chat_id", chatId);
    },
    { chatId: GUEST_CHAT_ID, modelId: GUEST_MODEL, withTranscript: options.withTranscript }
  );
}

/**
 * Holds GET /api/conversations/qa-conversation open for `delayMs` and then
 * lets the base fixture answer it. Registered after mockAuthenticatedApi so it
 * matches first (Playwright routes are LIFO).
 */
async function delayConversationDetail(page: Page, delayMs: number) {
  await page.route(
    /.*\/api\/conversations\/qa-conversation(\?.*)?$/,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await route.fallback();
    }
  );
}

const SEEDED_TRANSCRIPT = [
  { id: "m1", role: "user" as const, content: "seeded account question" },
  {
    id: "m2",
    role: "assistant" as const,
    content: "seeded account answer",
    modelId: "gpt-5-4-mini",
  },
];

// ---------------------------------------------------------------------------
// 1. Restoring an existing conversation
// ---------------------------------------------------------------------------

test.describe("restoring an existing conversation", () => {
  test(
    "a guest reload never inserts the welcome screen over the restored transcript",
    { tag: "@ui-risk" },
    async ({ page }, testInfo) => {
      await prepareGuestPage(page, "en");
      await seedGuestConversation(page, { withTranscript: true });
      await installDomHistoryProbe(page);

      await page.goto("/chat?lang=en");
      await expect(page.getByTestId(shellTestId(testInfo))).toBeVisible();
      await expect(page.getByText("restored guest question").first()).toBeVisible();

      await expectNoWelcomeEver(page, "guest reload");
      // The settled state agrees with the history: this was decided, not just
      // never painted.
      await expect(page.getByTestId(shellTestId(testInfo))).toHaveAttribute(
        "data-content-state",
        "non-empty"
      );
    }
  );

  test(
    "a signed-in restore waits in the panel loading state, never the welcome screen",
    { tag: "@ui-risk" },
    async ({ page }, testInfo) => {
      await prepareGuestPage(page, "en");
      await mockAuthenticatedApi(page, {
        selectedModels: ["gpt-5-4-mini"],
        messages: SEEDED_TRANSCRIPT,
      });
      await restoreActiveConversation(page);
      // Deliberately slow, so the window the flicker lived in is wide open for
      // the whole assertion below rather than something to race.
      await delayConversationDetail(page, 2000);
      await installDomHistoryProbe(page);

      await page.goto("/chat?lang=en");
      await expect(page.getByTestId(shellTestId(testInfo))).toBeVisible();

      // While the transcript is still on the wire the shell shows the panel's
      // own loading state and says so.
      await expect(page.getByTestId("chat-panel-loading").first()).toBeVisible();
      expect(await appearances(page, WELCOME)).toEqual([]);

      await expect(page.getByText("seeded account answer").first()).toBeVisible({
        timeout: 15_000,
      });
      await expectNoWelcomeEver(page, "signed-in restore");
    }
  );
});

// ---------------------------------------------------------------------------
// 2. Sending a follow-up in an existing conversation
// ---------------------------------------------------------------------------

test.describe("sending a follow-up in an existing conversation", () => {
  test(
    "a signed-in follow-up never returns to the welcome screen and never navigates",
    { tag: "@ui-risk" },
    async ({ page }, testInfo) => {
      await prepareGuestPage(page, "en");
      await mockAuthenticatedApi(page, {
        selectedModels: ["gpt-5-4-mini"],
        messages: SEEDED_TRANSCRIPT,
      });
      await restoreActiveConversation(page);
      await installDomHistoryProbe(page);
      await mockChatStream(page, "follow-up answer");

      await page.goto("/chat?lang=en");
      await expect(page.getByText("seeded account answer").first()).toBeVisible();

      await page.evaluate(() => {
        window.__sameDocumentMarker = "alive";
      });
      const before = await page.evaluate(() => ({
        href: location.href,
        historyLength: history.length,
        marker: window.__sameDocumentMarker,
      }));
      await forgetSightings(page);

      await sendChatMessage(page, testInfo, "follow-up question");
      await expect(userMessages(page, "follow-up question")).toHaveCount(1);
      await expect(page.getByText("follow-up answer").first()).toBeVisible();

      await expectNoWelcomeEver(page, "signed-in follow-up");
      expect(
        await page.evaluate(() => ({
          href: location.href,
          historyLength: history.length,
          marker: window.__sameDocumentMarker,
        }))
      ).toEqual(before);
    }
  );

  test(
    "a guest follow-up never returns to the welcome screen and never navigates",
    { tag: "@ui-risk" },
    async ({ page }, testInfo) => {
      await prepareGuestPage(page, "en");
      await seedGuestConversation(page, { withTranscript: true });
      await installDomHistoryProbe(page);
      await mockChatStream(page, "guest follow-up answer");

      await page.goto("/chat?lang=en");
      await expect(page.getByText("restored guest question").first()).toBeVisible();

      await page.evaluate(() => {
        window.__sameDocumentMarker = "alive";
      });
      const before = await page.evaluate(() => ({
        href: location.href,
        historyLength: history.length,
        marker: window.__sameDocumentMarker,
      }));
      await forgetSightings(page);

      await sendChatMessage(page, testInfo, "guest follow-up question");
      await expect(userMessages(page, "guest follow-up question")).toHaveCount(1);
      await expect(page.getByText("guest follow-up answer").first()).toBeVisible();

      await expectNoWelcomeEver(page, "guest follow-up");
      expect(
        await page.evaluate(() => ({
          href: location.href,
          historyLength: history.length,
          marker: window.__sameDocumentMarker,
        }))
      ).toEqual(before);
    }
  );
});

// ---------------------------------------------------------------------------
// 3. A genuinely new conversation still gets the welcome screen -- once
// ---------------------------------------------------------------------------

test.describe("a new, empty conversation", () => {
  test(
    "a guest new chat shows the welcome screen and leaves it exactly once",
    { tag: "@ui-risk" },
    async ({ page }, testInfo) => {
      await prepareGuestPage(page, "en");
      await installDomHistoryProbe(page);
      await mockChatStream(page, "first guest answer");

      await page.goto("/chat?lang=en");
      const welcome = page.getByTestId("chat-empty-state");
      await expect(welcome).toBeVisible();
      await expect(page.getByTestId(shellTestId(testInfo))).toHaveAttribute(
        "data-content-state",
        "empty"
      );

      await sendChatMessage(page, testInfo, "first guest question");
      // A guest starts on the three-model brand trio, so the turn lands in
      // three panels; this test is about the surface, not the fan-out.
      await expect(userMessages(page, "first guest question").first()).toBeVisible();
      await expect(page.getByText("first guest answer").first()).toBeVisible();
      await expect(welcome).toHaveCount(0);

      // Give every late settler -- the stream finishing, the transcript being
      // written to localStorage, the panel re-reporting -- a chance to put it
      // back. It must not come back, and it must not have been rebuilt on the
      // way out either.
      await page.waitForTimeout(1500);
      await expect(welcome).toHaveCount(0);
      const welcomeHistory = await sightings(page, WELCOME);
      expect(
        welcomeHistory.filter((entry) => entry.present).length,
        `the welcome screen is entered exactly once and never returns: ${JSON.stringify(welcomeHistory)}`
      ).toBe(1);
      expect(await appearances(page, LANDING_HERO)).toEqual([]);
    }
  );

  test(
    "a signed-in account with nothing to restore shows the welcome screen and leaves it once",
    { tag: "@ui-risk" },
    async ({ page }, testInfo) => {
      await prepareGuestPage(page, "en");
      await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
      // No restoreActiveConversation: this tab has no conversation to return
      // to, which is the welcome-home state.
      await installDomHistoryProbe(page);
      await mockChatStream(page, "first account answer");

      await page.goto("/chat?lang=en");
      const welcome = page.getByTestId("chat-empty-state");
      await expect(welcome).toBeVisible();

      await sendChatMessage(page, testInfo, "first account question");
      await expect(userMessages(page, "first account question")).toHaveCount(1);
      await expect(page.getByText("first account answer").first()).toBeVisible();
      await expect(welcome).toHaveCount(0);

      await page.waitForTimeout(1500);
      await expect(welcome).toHaveCount(0);
      const welcomeHistory = await sightings(page, WELCOME);
      expect(
        welcomeHistory.filter((entry) => entry.present).length,
        `the welcome screen is entered exactly once and never returns: ${JSON.stringify(welcomeHistory)}`
      ).toBe(1);
      expect(await appearances(page, LANDING_HERO)).toEqual([]);
    }
  );
});

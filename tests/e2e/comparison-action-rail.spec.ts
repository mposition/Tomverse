import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  openRecentConversation,
  prepareGuestPage,
  type QaConversationMessage,
} from "./support/app-fixtures";
import {
  freezeAnimations,
  installChatModelStub,
  mockGuestUsage,
  mockUserUsage,
  restoreActiveConversation,
  submitComposer,
  suppressTransientUi,
  type ChatModelStubSpec,
} from "./support/chat-state-fixtures";

// The two comparison actions act on *finished answers*, so they are their own
// labelled section rather than another row of composer controls -- but they
// share the composer's alignment axis inside one bottom workflow dock.
//
// Before this, desktop pinned them to the far left of the shell while the
// composer stayed centred at max-w-4xl (so the gap grew with the screen), and
// mobile rendered them *above* the answers they summarise. These tests pin
// both the alignment and the reading order, plus the readiness states that
// decide whether the actions may run at all.

const MODELS = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"];
const CHAT_ID = "guest_rail_test";
const TITLE = "Rail test";

type SeededStatus = "normal" | "error";

const seedGuestComparison = async (
  page: Page,
  statuses: Record<string, SeededStatus | "missing"> = {}
) => {
  await page.addInitScript(
    ({ chatId, models, title, statuses }) => {
      window.localStorage.setItem(
        "guest_conversations",
        JSON.stringify([
          {
            id: chatId,
            title,
            selectedModels: models,
            disabledPanels: [],
            webSearchMode: "off",
            createdAt: new Date().toISOString(),
          },
        ])
      );
      for (const modelId of models) {
        const status = statuses[modelId] || "normal";
        if (status === "missing") continue;
        window.localStorage.setItem(
          `guest_messages_${chatId}_${modelId}`,
          JSON.stringify([
            { id: "u1", role: "user", content: "Compare these.", status: "normal" },
            {
              id: "a1",
              role: "assistant",
              content:
                status === "error"
                  ? "QA fixture: this model failed."
                  : `Answer from ${modelId}.`,
              status,
            },
          ])
        );
      }
    },
    { chatId: CHAT_ID, models: MODELS, title: TITLE, statuses }
  );
};

const openSeeded = async (page: Page) => {
  await page.goto("/chat?lang=en");
  await openRecentConversation(page, { title: TITLE });
  await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
};

const rail = (page: Page) => page.getByTestId("comparison-action-rail");
const quickButton = (page: Page) => page.getByTestId("quick-comparison-button");

test.describe("desktop workflow dock alignment", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("desktop"),
      "The desktop dock only renders in the desktop shell."
    );
    await prepareGuestPage(page, "en");
  });

  for (const width of [768, 1024, 1280, 1440, 1920]) {
    test(`the rail and the composer share one alignment axis at ${width}px`, async ({
      page,
    }) => {
      await seedGuestComparison(page);
      await page.setViewportSize({ width, height: 900 });
      await openSeeded(page);

      await expect(rail(page)).toBeVisible();
      const railBox = await rail(page)
        .locator("> div")
        .first()
        .boundingBox();
      const composerBox = await page.getByTestId("chat-input").boundingBox();
      expect(railBox).not.toBeNull();
      expect(composerBox).not.toBeNull();

      expect(Math.abs(railBox!.x - composerBox!.x)).toBeLessThanOrEqual(4);
      expect(
        Math.abs(
          railBox!.x + railBox!.width - (composerBox!.x + composerBox!.width)
        )
      ).toBeLessThanOrEqual(4);
      await expectNoHorizontalOverflow(page);
    });
  }

  test("the dock keeps a single full-width seam against the answer canvas", async ({
    page,
  }) => {
    await seedGuestComparison(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSeeded(page);

    await expect(rail(page)).toBeVisible();
    // The rail owns the boundary; the composer must not draw a second one at
    // the same seam, which used to stack two hairlines a few pixels apart.
    const borders = await page.evaluate(() => {
      const railSection = document.querySelector(
        '[data-testid="comparison-action-rail"]'
      );
      const composerWrapper = document.querySelector('[data-testid="chat-input"]')
        ?.parentElement;
      const topBorder = (element: Element | null | undefined) =>
        element
          ? Number.parseFloat(getComputedStyle(element).borderTopWidth) || 0
          : 0;
      return {
        rail: topBorder(railSection),
        composer: topBorder(composerWrapper),
      };
    });
    expect(borders.rail).toBeGreaterThan(0);
    expect(borders.composer).toBe(0);
  });

  test("each action keeps a 44px hit area", async ({ page }) => {
    await seedGuestComparison(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSeeded(page);

    for (const testId of ["quick-comparison-button", "ai-review-button"]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box, testId).not.toBeNull();
      expect(box!.height, testId).toBeGreaterThanOrEqual(44);
      expect(box!.width, testId).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("mobile comparison rail", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "The mobile rail ordering only applies to the mobile shell."
    );
    await prepareGuestPage(page, "en");
  });

  test("follow-up tools come after the answers and before the composer", async ({
    page,
  }) => {
    await seedGuestComparison(page);
    await openSeeded(page);

    await expect(rail(page)).toBeVisible();
    const order = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll(
          '[data-testid="mobile-model-tab"], [data-testid="chat-message"], [data-testid="comparison-action-rail"], [data-testid="chat-input"]'
        )
      );
      // Reduce to the first occurrence of each landmark, in document order.
      const seen: string[] = [];
      for (const node of nodes) {
        const id = node.getAttribute("data-testid")!;
        if (!seen.includes(id)) seen.push(id);
      }
      return seen;
    });

    expect(order.indexOf("chat-message")).toBeGreaterThan(
      order.indexOf("mobile-model-tab")
    );
    expect(order.indexOf("comparison-action-rail")).toBeGreaterThan(
      order.indexOf("chat-message")
    );
    expect(order.indexOf("chat-input")).toBeGreaterThan(
      order.indexOf("comparison-action-rail")
    );
  });

  for (const width of [320, 360, 390]) {
    test(`the two actions fit ${width}px without truncating away their meaning`, async ({
      page,
    }) => {
      await seedGuestComparison(page);
      await page.setViewportSize({ width, height: 640 });
      await openSeeded(page);

      await expect(rail(page)).toBeVisible();
      await expectNoHorizontalOverflow(page);

      const label = quickButton(page).locator("span").first();
      await expect(label).toHaveText("Differences");
      const clipped = await label.evaluate(
        (node) => node.scrollWidth > node.clientWidth + 1
      );
      expect(clipped).toBe(false);

      const box = await quickButton(page).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    });
  }

  test("landscape gets the same one-row treatment, without losing the actions", async ({
    page,
  }) => {
    await seedGuestComparison(page);
    await page.setViewportSize({ width: 740, height: 360 });
    await openSeeded(page);

    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");
    const disclosure = page.getByTestId("comparison-action-rail-disclosure");
    await expect(disclosure).toBeVisible();
    const box = await disclosure.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    // Still reachable: expanding brings both actions back on the same screen.
    await disclosure.click();
    await expect(quickButton(page)).toBeVisible();
    await expect(page.getByTestId("ai-review-button")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("the rail collapses to one row while the keyboard covers the viewport", async ({
    page,
  }) => {
    await seedGuestComparison(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSeeded(page);
    await expect(rail(page)).toHaveAttribute("data-collapsed", "false");

    // Stand in for the on-screen keyboard: visualViewport shrinks while the
    // layout viewport does not, which is exactly the signal the shell reads.
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      Object.defineProperty(viewport, "height", {
        configurable: true,
        get: () => window.innerHeight * 0.5,
      });
      viewport.dispatchEvent(new Event("resize"));
    });

    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");
    await expect(page.getByTestId("comparison-action-rail-disclosure")).toBeVisible();
    await expect(quickButton(page)).toHaveCount(0);

    // The composer keeps its rows: both the textarea and the send control stay
    // hit-testable with the keyboard up.
    await expect(page.getByTestId("chat-textarea")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("comparison readiness states", () => {
  test.beforeEach(async ({ page }) => {
    await prepareGuestPage(page, "en");
    // The rail asks the server what this guest may run, so these readiness
    // cases need that answer to be the ordinary one -- otherwise every
    // assertion below reads the fail-closed "still checking" state instead of
    // the readiness state it is about.
    await mockGuestUsage(page, 0, 20);
  });

  test("a conversation with no answers at all offers no rail", async ({ page }) => {
    await seedGuestComparison(page, {
      "gpt-5-4-mini": "missing",
      "claude-haiku-4-5": "missing",
      "gemini-2-5-flash": "missing",
    });
    await page.goto("/chat?lang=en");
    await expect(rail(page)).toHaveCount(0);
  });

  test("three completed answers run against all three", async ({ page }) => {
    await seedGuestComparison(page);
    await openSeeded(page);

    await expect(rail(page)).toHaveAttribute("data-state", "ready");
    await expect(rail(page)).toHaveAttribute("data-ready-count", "3");
    await expect(quickButton(page)).toHaveAttribute("aria-disabled", "false");
    await expect(page.getByTestId("comparison-action-rail-status")).toContainText(
      "Comparing 3 completed answers"
    );
  });

  test("a failed answer is excluded, said so, and does not block the rest", async ({
    page,
  }) => {
    await seedGuestComparison(page, { "gemini-2-5-flash": "error" });
    await openSeeded(page);

    await expect(rail(page)).toHaveAttribute("data-state", "ready");
    await expect(rail(page)).toHaveAttribute("data-ready-count", "2");
    await expect(rail(page)).toHaveAttribute("data-excluded-count", "1");
    const status = page.getByTestId("comparison-action-rail-status");
    await expect(status).toContainText("Comparing 2 completed answers");
    await expect(status).toContainText("1 unfinished excluded");
    await expect(quickButton(page)).toHaveAttribute("aria-disabled", "false");
  });

  test("one usable answer blocks both actions and says why, reachably", async ({
    page,
  }) => {
    await seedGuestComparison(page, {
      "claude-haiku-4-5": "error",
      "gemini-2-5-flash": "error",
    });
    await openSeeded(page);

    await expect(rail(page)).toHaveAttribute("data-state", "needsMore");
    await expect(quickButton(page)).toHaveAttribute("aria-disabled", "true");

    // The reason is a described-by status, not a `title` -- so it survives
    // keyboard focus and screen readers, and the control stays focusable.
    const describedBy = await quickButton(page).getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toContainText(
      "one more completed answer is needed"
    );
    await quickButton(page).focus();
    await expect(quickButton(page)).toBeFocused();

    // aria-disabled blocks activation rather than only dimming the control:
    // Playwright already refuses a normal click on an aria-disabled control,
    // so force one through and confirm nothing runs.
    await quickButton(page).click({ force: true });
    await expect(page.getByTestId("quick-comparison-dialog")).toHaveCount(0);
  });

  test("the quick summary never quotes a fixed price it cannot guarantee", async ({
    page,
  }) => {
    await seedGuestComparison(page);
    await openSeeded(page);

    const badge = page.getByTestId("quick-comparison-credit-cost");
    await expect(badge).toHaveAttribute("data-approximate", "true");
    await expect(badge).toContainText("~1");
    await expect(badge).toHaveAttribute(
      "aria-label",
      /About 1 credit .*Long answers may use more/
    );
  });
});

// ===========================================================================
// The status sentence: hidden when it has nothing left to say, on screen the
// moment it does -- and the *same* policy in both shells.
//
// "Comparing 3 completed answers" is the state a user is in almost all of the
// time, and it cost a whole row under two buttons that already say what they
// do and what they cost, next to panels/tabs that already name the models. It
// is now visually hidden in exactly that state -- and only there, on desktop
// as well as on a phone, because "the desktop has room for it" is not a reason
// to repeat information. It stays in the accessibility tree throughout, where
// each action points at its *own* description: its own comparison target, its
// own price and its own reason for being unavailable. Two actions at two
// different prices sharing one "not enough credits" sentence is what made the
// 1-credit action look as unaffordable as the 4-credit one.
//
// See docs/ui-contracts/comparison-action-rail.md.
// ===========================================================================

const AUTH_MODELS = ["gpt-5-4-mini", "claude-sonnet-5", "gemini-3-5-flash"];
const MOBILE_VIEWPORT = { width: 390, height: 680 };
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

/** The two shells the policy must agree on, driven from one table. */
const SHELLS = [
  { name: "desktop" as const, viewport: DESKTOP_VIEWPORT },
  { name: "mobile" as const, viewport: MOBILE_VIEWPORT },
];

const completedMessages = (
  models: string[],
  statuses: Record<string, string> = {}
): QaConversationMessage[] => [
  { id: "u1", role: "user", content: "Compare these." },
  ...models.map((modelId, index) => ({
    id: `a${index + 1}`,
    role: "assistant" as const,
    modelId,
    status: statuses[modelId] || "normal",
    content: `Answer from ${modelId}.`,
  })),
];

async function enterAuthenticatedComparison(
  page: Page,
  options: {
    models?: string[];
    statuses?: Record<string, string>;
    viewport?: { width: number; height: number };
    lang?: string;
    credits?: number;
    modelStub?: ChatModelStubSpec;
    messages?: QaConversationMessage[];
    suppressUpsell?: boolean;
  } = {}
) {
  const {
    models = AUTH_MODELS,
    statuses = {},
    viewport = MOBILE_VIEWPORT,
    lang = "en",
    credits,
    modelStub,
    messages,
    suppressUpsell = false,
  } = options;

  await prepareGuestPage(page, "en");
  if (suppressUpsell) await suppressTransientUi(page);
  await mockAuthenticatedApi(page, {
    selectedModels: models,
    messages: messages ?? completedMessages(models, statuses),
  });
  if (credits !== undefined) {
    await mockUserUsage(page, {
      balances: { planRemainingCredits: credits, purchasedRemainingCredits: 0 },
      limits: { creditsDay: credits },
      usage: { creditsDay: 0 },
    });
  }
  await restoreActiveConversation(page);
  if (modelStub) await installChatModelStub(page, modelStub);

  await page.setViewportSize(viewport);
  await page.goto(`/chat?lang=${lang}`);
  // Which shell mounts is a function of the viewport (and pointer), so the
  // same helper drives both -- the policy under test must not depend on it.
  await expect(
    page.getByTestId(viewport.width >= 768 ? "desktop-chat-shell" : "mobile-chat-shell")
  ).toBeVisible();
  await freezeAnimations(page);
}

const status = (page: Page) => page.getByTestId("comparison-action-rail-status");

/**
 * A guest looking at three completed answers, with the server's own view of
 * what they may run.
 *
 * The rail decides the cross-review's availability from `/api/user/guest-usage`
 * -- never from `isGuestMode` -- so a spec that wants a trial available, a
 * trial used up or a credit shortfall states it here, exactly as the server
 * would report it.
 */
async function openGuestComparison(
  page: Page,
  options: {
    viewport: { width: number; height: number };
    creditsAvailable?: number;
    aiReviewTrial?: { limit: number; used: number; remaining: number };
    lang?: string;
  }
) {
  await prepareGuestPage(page, "en");
  await mockGuestUsage(page, 0, 20, {
    creditsAvailable: options.creditsAvailable,
    aiReviewTrial: options.aiReviewTrial,
  });
  await seedGuestComparison(page);
  await page.setViewportSize(options.viewport);
  await page.goto(`/chat?lang=${options.lang ?? "en"}`);
  await openRecentConversation(page, { title: TITLE });
  await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
  await expect(rail(page)).toBeVisible();
  await freezeAnimations(page);
}

const QUICK_SUMMARY_SETUP = {
  available: true,
  title: "QA conversation",
  responseCount: 3,
  estimatedCredits: 1,
  cached: false,
};

const QUICK_SUMMARY_RESULT = {
  id: "quick-summary-1",
  title: "QA conversation",
  result: {
    commonConclusions: [
      { text: "All three answers agree.", citations: [], verified: false },
    ],
    importantDifferences: [],
    modelKeyClaims: [],
    verificationNeeded: [],
  },
  usageCredits: 1,
  cached: false,
};

/**
 * The quick summary's own endpoint. `hold: true` never resolves the POST, so
 * the rail stays in its "running the analysis" state for the whole test.
 */
async function mockQuickSummaryRun(page: Page, { hold = false } = {}) {
  await page.route("**/api/conversations/*/compare-summary**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(QUICK_SUMMARY_SETUP),
      });
      return;
    }
    if (hold) return; // deliberately left in flight
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(QUICK_SUMMARY_RESULT),
    });
  });
}

/** On screen means it really paints a row, not that it survives in the DOM. */
async function expectStatusOnScreen(page: Page) {
  await expect(status(page)).toBeVisible();
  const box = await status(page).boundingBox();
  expect(box!.height, "status sentence renders no row").toBeGreaterThan(8);
}

/**
 * The bottom edge the sentence used to sit on: with it hidden, the rail must
 * not keep an empty row's worth of height under the buttons either.
 */
async function readRailGeometry(page: Page) {
  return page.evaluate(() => {
    const railNode = document.querySelector<HTMLElement>(
      '[data-testid="comparison-action-rail"]'
    )!;
    const statusNode = document.querySelector<HTMLElement>(
      '[data-testid="comparison-action-rail-status"]'
    );
    const actionNode =
      document.querySelector<HTMLElement>('[data-testid="quick-comparison-button"]') ??
      document.querySelector<HTMLElement>(
        '[data-testid="comparison-action-rail-disclosure"]'
      );
    const railRect = railNode.getBoundingClientRect();
    return {
      railHeight: railRect.height,
      statusHeight: statusNode?.getBoundingClientRect().height ?? null,
      /** Whatever is left under the last action: padding, and nothing else. */
      spaceBelowActions: actionNode
        ? railRect.bottom - actionNode.getBoundingClientRect().bottom
        : null,
      statusHidden: railNode.dataset.statusHidden,
      steady: railNode.dataset.steady,
      layout: railNode.dataset.layout,
    };
  });
}

for (const shell of SHELLS) {
  test.describe(`status disclosure policy (${shell.name})`, () => {
    test.use({ hasTouch: true });

    test.beforeEach(async ({}, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop-chromium",
        "Driven at explicit viewports on one engine; run with --project=desktop-chromium."
      );
    });

    test("every answer complete: the sentence is hidden visually, not removed", async ({
      page,
    }) => {
      await enterAuthenticatedComparison(page, { viewport: shell.viewport });

      await expect(rail(page)).toHaveAttribute("data-layout", shell.name);
      await expect(rail(page)).toHaveAttribute("data-steady", "true");
      await expect(rail(page)).toHaveAttribute("data-status-hidden", "true");

      // Still in the DOM, still readable, still the right sentence.
      await expect(status(page)).toHaveCount(1);
      await expect(status(page)).toContainText("Comparing 3 completed answers");
      // ...and genuinely out of the layout, measured rather than assumed from a
      // class name: a 1px clipped box costs the rail no row, but Playwright's
      // toBeVisible() still counts it, so this reads the geometry directly.
      const geometry = await readRailGeometry(page);
      expect(
        geometry.statusHeight!,
        "visually hidden status still occupies a row"
      ).toBeLessThanOrEqual(1);
      // No empty row, and no orphaned bottom gap where the sentence used to be.
      expect(
        geometry.spaceBelowActions!,
        "the hidden sentence left a gap under the actions"
      ).toBeLessThanOrEqual(12);

      // Both actions, their prices and the help control stay on screen: the
      // feature must not become less discoverable than it was.
      await expect(quickButton(page)).toBeVisible();
      await expect(page.getByTestId("ai-review-button")).toBeVisible();
      await expect(page.getByTestId("quick-comparison-credit-cost")).toBeVisible();
      await expect(page.getByTestId("ai-review-entry-credit-cost")).toBeVisible();
      await expect(
        page.getByTestId(
          shell.name === "mobile" ? "ai-review-help-mobile" : "ai-review-help"
        )
      ).toBeVisible();

      // The count a sighted user no longer needs is still one focus away.
      const quickId = await quickButton(page).getAttribute("aria-describedby");
      const reviewId = await page
        .getByTestId("ai-review-button")
        .getAttribute("aria-describedby");
      await expect(page.locator(`#${quickId}`)).toContainText(
        "Comparing 3 completed answers"
      );
      await expect(page.locator(`#${reviewId}`)).toContainText(
        "Comparing 3 completed answers"
      );
      await expectNoHorizontalOverflow(page);
    });

    test("an excluded failure puts the sentence back on screen", async ({ page }) => {
      await enterAuthenticatedComparison(page, {
        viewport: shell.viewport,
        statuses: { "gemini-3-5-flash": "error" },
      });

      await expect(rail(page)).toHaveAttribute("data-steady", "false");
      await expectStatusOnScreen(page);
      await expect(status(page)).toContainText("Comparing 2 completed answers");
      await expect(status(page)).toContainText("1 unfinished excluded");
      await expectNoHorizontalOverflow(page);
    });

    test("too few completed answers puts the sentence back on screen", async ({
      page,
    }) => {
      await enterAuthenticatedComparison(page, {
        viewport: shell.viewport,
        statuses: { "claude-sonnet-5": "error", "gemini-3-5-flash": "error" },
      });

      await expect(rail(page)).toHaveAttribute("data-state", "needsMore");
      await expectStatusOnScreen(page);
      await expect(status(page)).toContainText("one more completed answer is needed");
    });

    test("answers still generating put the sentence back on screen, and announce", async ({
      page,
    }) => {
      await enterAuthenticatedComparison(page, {
        viewport: shell.viewport,
        messages: [],
        modelStub: {
          "gpt-5-4-mini": { kind: "success", chunks: ["Paris."], intervalMs: 15 },
          "claude-sonnet-5": { kind: "hold" },
          "gemini-3-5-flash": { kind: "hold" },
        },
      });

      await submitComposer(
        page,
        "Which city is the capital of France?",
        shell.viewport.width
      );

      await expect(rail(page)).toHaveAttribute("data-state", "generating");
      await expectStatusOnScreen(page);
      await expect(status(page)).toContainText("still generating");
      // Progress -- and only progress -- is what the live region carries.
      await expect(page.getByTestId("comparison-action-rail-live")).toContainText(
        "still generating"
      );
    });

    test("a running analysis is said out loud, in both shells", async ({ page }) => {
      await enterAuthenticatedComparison(page, { viewport: shell.viewport });
      // Hold the quick-summary request open: the rail is busy for as long as
      // the route never resolves.
      await mockQuickSummaryRun(page, { hold: true });
      await quickButton(page).click();

      await expect(rail(page)).toHaveAttribute("data-steady", "false");
      await expectStatusOnScreen(page);
      await expect(status(page)).toContainText("Running the AI analysis");
      await expect(page.getByTestId("comparison-action-rail-live")).toContainText(
        "Running the AI analysis"
      );
    });

    test("insufficient credits name the action they belong to", async ({ page }) => {
      await enterAuthenticatedComparison(page, {
        viewport: shell.viewport,
        credits: 2,
      });

      await expect(rail(page)).toHaveAttribute("data-steady", "false");
      await expectStatusOnScreen(page);
      await expect(status(page)).toContainText(
        "AI review · 8 credits needed · 2 available"
      );
      // The 1-credit action is not dragged into the other's shortfall.
      await expect(status(page)).not.toContainText("1 credit needed");
      await expect(quickButton(page)).toHaveAttribute("aria-disabled", "false");
    });

    test("both actions unaffordable states both prices", async ({ page }) => {
      await enterAuthenticatedComparison(page, {
        viewport: shell.viewport,
        credits: 0,
      });

      await expectStatusOnScreen(page);
      await expect(status(page)).toContainText("Differences · 1 credits needed");
      await expect(status(page)).toContainText("AI review · 8 credits needed");
      await expect(quickButton(page)).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByTestId("ai-review-button")).toHaveAttribute(
        "aria-disabled",
        "true"
      );
    });

    test("a replayed summary costs 0 and keeps the state steady", async ({ page }) => {
      await enterAuthenticatedComparison(page, {
        viewport: shell.viewport,
        // A first successful comparison is also what triggers the upsell
        // toast; it would sit over the dialog's own close control here and
        // has nothing to do with the policy under test.
        suppressUpsell: true,
      });
      await mockQuickSummaryRun(page);

      await expect(page.getByTestId("quick-comparison-credit-cost")).toContainText("~1");
      await quickButton(page).click();
      const dialog = page.getByTestId("quick-comparison-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);

      // The replay is free: the badge drops to 0 and the state is still the
      // steady one, so the sentence stays off screen and in the a11y tree.
      await expect(page.getByTestId("quick-comparison-credit-cost")).toContainText("0");
      await expect(quickButton(page)).toHaveAttribute("aria-disabled", "false");
      await expect(rail(page)).toHaveAttribute("data-steady", "true");
      await expect(rail(page)).toHaveAttribute("data-status-hidden", "true");
      await expect(status(page)).toContainText("Comparing 3 completed answers");
    });

    test("a guest with a trial left runs the review under the same policy", async ({
      page,
    }) => {
      await openGuestComparison(page, { viewport: shell.viewport });

      // A real action, not a lock: the homepage promises a guest can run the
      // AI Review, and this is where that promise is either kept or broken.
      const review = page.getByTestId("ai-review-button");
      await expect(review).toBeVisible();
      await expect(review).toHaveAttribute("data-access", "guestTrial");
      await expect(review).toHaveAttribute("aria-disabled", "false");
      await expect(quickButton(page)).toBeVisible();
      // Its own price, on the button itself.
      await expect(page.getByTestId("ai-review-entry-credit-cost")).toContainText("8");

      // ...and the disclosure policy does not change for a guest: with a run
      // available this is the steady state in both shells, so the sentence is
      // hidden visually and reachable in the accessibility tree.
      await expect(rail(page)).toHaveAttribute("data-status-hidden", "true");
      await expect(rail(page)).toHaveAttribute("data-steady", "true");
      await expect(status(page)).toContainText("Comparing 3 completed answers");

      // The trial condition is carried by the action's own description, in
      // both shells, whether or not there is room for the desktop badge.
      await expect(page.getByTestId("ai-review-description")).toContainText(
        "Monthly guest trial available"
      );
      // ...and only on that action. The quick summary is a guest's every-day
      // action and must not inherit the review's trial language.
      await expect(page.getByTestId("quick-comparison-description")).not.toContainText(
        "Monthly guest trial"
      );
    });

    test("a guest whose trial is used up is told exactly that, on screen", async ({
      page,
    }) => {
      await openGuestComparison(page, {
        viewport: shell.viewport,
        aiReviewTrial: { limit: 1, used: 1, remaining: 0 },
      });

      const review = page.getByTestId("ai-review-button");
      await expect(review).toHaveAttribute("data-access", "guestTrialExhausted");
      await expect(review).toHaveAttribute("aria-disabled", "true");
      // A blocked action is an exception state, so the sentence comes back on
      // screen -- in both shells, by the same policy.
      await expect(rail(page)).toHaveAttribute("data-status-hidden", "false");
      await expectStatusOnScreen(page);
      await expect(status(page)).toContainText("trial");
      // Named against its own action only; the quick summary is still runnable.
      await expect(status(page)).toContainText("AI review");
      await expect(quickButton(page)).toHaveAttribute("aria-disabled", "false");
      await expect(page.getByTestId("ai-review-description")).toContainText("trial");
      await expect(page.getByTestId("quick-comparison-description")).not.toContainText(
        "trial"
      );
    });

    test("a guest short of credits is told that, not that the trial is gone", async ({
      page,
    }) => {
      // Two different blocks with two different ways out: waiting for the
      // daily budget to reset, versus signing in. Collapsing them would leave
      // the user acting on the wrong one.
      await openGuestComparison(page, {
        viewport: shell.viewport,
        creditsAvailable: 2,
      });

      await expect(rail(page)).toHaveAttribute("data-status-hidden", "false");
      await expectStatusOnScreen(page);
      await expect(status(page)).toContainText("8 credits needed");
      await expect(status(page)).toContainText("2 available");
      // The 1-credit quick summary is still affordable at a balance of 2, and
      // must not be described as unaffordable alongside the 8-credit review.
      await expect(quickButton(page)).toHaveAttribute("aria-disabled", "false");
      await expect(page.getByTestId("quick-comparison-description")).not.toContainText(
        "8 credits needed"
      );
      await expect(page.getByTestId("ai-review-button")).toHaveAttribute(
        "aria-disabled",
        "true"
      );
    });

    test("a guest keeps the accessibility contract the actions already had", async ({
      page,
    }) => {
      await openGuestComparison(page, { viewport: shell.viewport });

      const quickDescribedBy = await quickButton(page).getAttribute(
        "aria-describedby"
      );
      const reviewDescribedBy = await page
        .getByTestId("ai-review-button")
        .getAttribute("aria-describedby");
      expect(quickDescribedBy).toBeTruthy();
      expect(reviewDescribedBy).toBeTruthy();
      expect(quickDescribedBy).not.toBe(reviewDescribedBy);

      // Each description still carries the comparison target count itself.
      for (const testId of ["quick-comparison-description", "ai-review-description"]) {
        await expect(page.getByTestId(testId)).toContainText(
          "Comparing 3 completed answers"
        );
      }
      // The accessible name stays the action alone.
      await expect(page.getByTestId("ai-review-button")).toHaveAttribute(
        "aria-label",
        "AI answer cross-review"
      );
    });

    test("the live region stays silent once everything has settled", async ({
      page,
    }) => {
      await enterAuthenticatedComparison(page, { viewport: shell.viewport });

      await expect(rail(page)).toHaveAttribute("data-steady", "true");
      await expect(page.getByTestId("comparison-action-rail-live")).toHaveText("");
    });
  });
}

test.describe("collapsed rail (keyboard/landscape)", () => {
  test.use({ hasTouch: true });

  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Driven at explicit mobile viewports on one engine; run with --project=desktop-chromium."
    );
  });

  test("an exception rides the disclosure while collapsed, and returns on expand", async ({
    page,
  }) => {
    await enterAuthenticatedComparison(page, {
      statuses: { "gemini-3-5-flash": "error" },
    });
    await expectStatusOnScreen(page);

    // Stand in for the on-screen keyboard.
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      Object.defineProperty(viewport, "height", {
        configurable: true,
        get: () => window.innerHeight * 0.5,
      });
      viewport.dispatchEvent(new Event("resize"));
    });

    const disclosure = page.getByTestId("comparison-action-rail-disclosure");
    await expect(disclosure).toBeVisible();
    await expect(rail(page)).toHaveAttribute("data-status-hidden", "true");

    // Collapsed is allowed to hide the sentence visually -- but only because
    // the button that replaces it carries the exact same state.
    const describedBy = await disclosure.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toContainText(
      "1 unfinished excluded"
    );

    await disclosure.click();
    await expect(rail(page)).toHaveAttribute("data-collapsed", "false");
    await expectStatusOnScreen(page);
    await expect(status(page)).toContainText("1 unfinished excluded");
  });
});

test.describe("the two shells agree on the policy", () => {
  test.use({ hasTouch: true });

  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Driven at explicit viewports on one engine; run with --project=desktop-chromium."
    );
  });

  test("steady and excluded states hide/show identically on desktop and mobile", async ({
    page,
  }) => {
    // The setup helper returns as soon as the shell mounts, but the rail's
    // state is derived from answers that land after that. Every other test
    // here reads it through a retrying `expect`; this one captures raw
    // attributes, so it waits for the rail itself first -- the rail only
    // renders once readiness has been computed from the loaded answers.
    const captureRail = async (): Promise<{ steady: string; hidden: string }> => {
      await expect(rail(page)).toBeVisible();
      return {
        steady: (await rail(page).getAttribute("data-steady"))!,
        hidden: (await rail(page).getAttribute("data-status-hidden"))!,
      };
    };

    const seen: Record<string, { steady: string; hidden: string }> = {};
    for (const shell of SHELLS) {
      await enterAuthenticatedComparison(page, { viewport: shell.viewport });
      seen[`${shell.name}-steady`] = await captureRail();

      await enterAuthenticatedComparison(page, {
        viewport: shell.viewport,
        statuses: { "gemini-3-5-flash": "error" },
      });
      seen[`${shell.name}-excluded`] = await captureRail();
    }

    expect(seen["desktop-steady"]).toEqual({ steady: "true", hidden: "true" });
    expect(seen["mobile-steady"]).toEqual(seen["desktop-steady"]);
    expect(seen["desktop-excluded"]).toEqual({ steady: "false", hidden: "false" });
    expect(seen["mobile-excluded"]).toEqual(seen["desktop-excluded"]);
  });

  test("hiding the sentence shortens the desktop rail without moving its actions", async ({
    page,
  }) => {
    await enterAuthenticatedComparison(page, { viewport: DESKTOP_VIEWPORT });
    await expect(rail(page)).toHaveAttribute("data-status-hidden", "true");
    const steady = await readRailGeometry(page);
    const steadyActions = await quickButton(page).boundingBox();

    await enterAuthenticatedComparison(page, {
      viewport: DESKTOP_VIEWPORT,
      statuses: { "gemini-3-5-flash": "error" },
    });
    await expect(rail(page)).toHaveAttribute("data-status-hidden", "false");
    const explaining = await readRailGeometry(page);
    const explainingActions = await quickButton(page).boundingBox();

    expect(steady.railHeight).toBeLessThan(explaining.railHeight);
    // The buttons keep their own left edge and size; only the sentence goes.
    expect(steadyActions!.x).toBeCloseTo(explainingActions!.x, 0);
    expect(steadyActions!.height).toBeCloseTo(explainingActions!.height, 0);
  });
});

test.describe("per-action descriptions", () => {
  test.use({ hasTouch: true });

  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Driven at explicit mobile viewports on one engine; run with --project=desktop-chromium."
    );
  });

  test("the two actions point at two different descriptions", async ({ page }) => {
    await enterAuthenticatedComparison(page);

    const quickId = await quickButton(page).getAttribute("aria-describedby");
    const reviewId = await page
      .getByTestId("ai-review-button")
      .getAttribute("aria-describedby");
    expect(quickId).toBeTruthy();
    expect(reviewId).toBeTruthy();
    expect(quickId).not.toBe(reviewId);

    // Each description names that action's own comparison target and price.
    await expect(page.locator(`#${quickId}`)).toContainText(
      "Comparing 3 completed answers"
    );
    await expect(page.locator(`#${quickId}`)).toContainText("About 1 credit");
    await expect(page.locator(`#${reviewId}`)).toContainText(
      "Comparing 3 completed answers"
    );
    await expect(page.locator(`#${reviewId}`)).toContainText("8 credits");
    // The name is the action alone -- the description is not read twice.
    await expect(quickButton(page)).toHaveAccessibleName("Quick difference summary");
    await expect(page.getByTestId("ai-review-button")).toHaveAccessibleName(
      "AI answer cross-review"
    );
  });

  test("a 2-credit balance blocks only the action that costs more than 2", async ({
    page,
  }) => {
    await enterAuthenticatedComparison(page, { credits: 2 });

    // 1 credit is affordable; 8 is not, and only the 8-credit action is gated.
    await expect(quickButton(page)).toHaveAttribute("aria-disabled", "false");
    await expect(page.getByTestId("ai-review-button")).toHaveAttribute(
      "aria-disabled",
      "true"
    );

    const quickId = await quickButton(page).getAttribute("aria-describedby");
    const reviewId = await page
      .getByTestId("ai-review-button")
      .getAttribute("aria-describedby");
    // The affordable action is not told it cannot afford itself.
    await expect(page.locator(`#${quickId}`)).not.toContainText("Not enough credits");
    // The blocked one quotes its own price against the real balance.
    await expect(page.locator(`#${reviewId}`)).toContainText(
      "Not enough credits: 8 needed, 2 available"
    );

    // Insufficient credits is an exception, so the sentence is on screen and
    // says which action it is about.
    await expect(rail(page)).toHaveAttribute("data-steady", "false");
    await expectStatusOnScreen(page);
    await expect(status(page)).toContainText("AI review · 8 credits needed · 2 available");
  });

  test("the blocked reason survives keyboard focus without a title attribute", async ({
    page,
  }) => {
    await enterAuthenticatedComparison(page, { credits: 2 });

    const review = page.getByTestId("ai-review-button");
    await review.focus();
    await expect(review).toBeFocused();
    await expect(review).not.toHaveAttribute("title", /./);
    await review.click({ force: true });
    await expect(page.getByTestId("comparison-review-setup")).toHaveCount(0);
  });
});

test.describe("mobile rail geometry", () => {
  test.use({ hasTouch: true });

  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Driven at explicit mobile viewports on one engine; run with --project=desktop-chromium."
    );
  });

  for (const lang of ["en", "ko"]) {
    for (const width of [320, 360, 390, 430]) {
      test(`[${lang}] both actions keep their whole label and a 44px target at ${width}px`, async ({
        page,
      }) => {
        await enterAuthenticatedComparison(page, {
          lang,
          viewport: { width, height: 680 },
        });

        await expect(rail(page)).toBeVisible();
        for (const testId of ["quick-comparison-button", "ai-review-button"]) {
          const box = await page.getByTestId(testId).boundingBox();
          expect(box, testId).not.toBeNull();
          expect(box!.height, `${testId} height`).toBeGreaterThanOrEqual(43.5);
          expect(box!.width, `${testId} width`).toBeGreaterThanOrEqual(43.5);

          const label = page.getByTestId(testId).locator("span.truncate").first();
          const clipped = await label.evaluate(
            (node) => node.scrollWidth > node.clientWidth + 1
          );
          expect(clipped, `${testId} label truncated at ${width}px in ${lang}`).toBe(
            false
          );
        }

        const help = await page.getByTestId("ai-review-help-mobile").boundingBox();
        expect(Math.min(help!.width, help!.height)).toBeGreaterThanOrEqual(43.5);

        await expectNoHorizontalOverflow(page);
      });
    }
  }

  test("the steady rail is shorter than the one that still has to explain itself", async ({
    page,
  }) => {
    await enterAuthenticatedComparison(page);
    const steady = await rail(page).boundingBox();

    await enterAuthenticatedComparison(page, {
      statuses: { "gemini-3-5-flash": "error" },
    });
    const explaining = await rail(page).boundingBox();

    expect(steady!.height).toBeLessThan(explaining!.height);
    // The row itself is untouched; only the sentence under it goes away.
    expect(explaining!.height - steady!.height).toBeGreaterThanOrEqual(16);
  });
});

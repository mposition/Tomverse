import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import {
  freezeAnimations,
  installChatModelStub,
  mockAuthenticatedApi,
  restoreActiveConversation,
  submitComposer,
  type AuthenticatedQaState,
  type ChatModelStubSpec,
} from "./support/chat-state-fixtures";

// ---------------------------------------------------------------------------
// The mobile header's status row (guest badge / lock / share / responding /
// error) used to render unconditionally, so a signed-in new conversation --
// where every one of those is false -- still paid mt-1.5 + min-h-6 for an
// empty strip. That was ~30px of blank header on every phone, on the state
// users see most often.
//
// These tests pin both halves of the fix: the row is gone (not merely
// visually hidden) when there is nothing to say, and it is unchanged when
// there is. Everything is measured from real layout boxes rather than class
// names, so a future "just hide it with CSS" regression fails here.
//
// Runs on desktop-chromium with hasTouch so one project can drive arbitrary
// viewports (320..412, landscape, and a halved viewport standing in for 200%
// browser zoom). useIsMobileShell() needs a coarse pointer as well as a
// narrow width, so without hasTouch this shell would never mount.
// ---------------------------------------------------------------------------

test.use({ hasTouch: true });

test.beforeEach(async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Header geometry is measured on one engine at explicit viewports; run with --project=desktop-chromium."
  );
});

const MODEL_A = "gpt-5-4-mini";
const MODEL_B = "claude-sonnet-5";
const MODEL_C = "gemini-3-6-flash";
const THREE_MODELS = [MODEL_A, MODEL_B, MODEL_C];

/**
 * Header height, safe-area excluded (the test browser reports 0 insets). One
 * row -- title plus model picker -- in every state, so this single band covers
 * the hydration placeholder, a single-model chat and a restored multi-model
 * comparison alike, and any of them drifting apart is a layout shift.
 */
const HEADER_MIN_HEIGHT = 56;
const HEADER_MAX_HEIGHT = 66;
/** Breathing room between the last header content and the divider below it. */
const DIVIDER_GAP_MIN = 7;
const DIVIDER_GAP_MAX = 12;
/** 44px targets, with the sub-pixel slack the other suites already allow. */
const TOUCH_MIN = 43.5;

const MOBILE_WIDTHS = [320, 360, 390, 412];
const DEFAULT_VIEWPORT = { width: 390, height: 844 };

const header = (page: Page) => page.getByTestId("mobile-chat-header");
const statusRow = (page: Page) => page.getByTestId("mobile-header-status-row");
const summary = (page: Page) => page.getByTestId("mobile-header-model-summary");
const extraCount = (page: Page) => page.getByTestId("mobile-header-extra-model-count");
const modelCount = (page: Page) => page.getByTestId("mobile-header-model-count");

type HeaderMetrics = {
  hasStatus: boolean;
  height: number;
  /**
   * Distance from the bottom of the last piece of header content to the
   * header's own bottom edge -- i.e. the divider. The model summary button
   * carries -my-0.5, so its painted box reaches 2px past its column; this
   * measures the real visual gap, not the declared padding.
   */
  lastContentToDivider: number;
  statusRowHeight: number | null;
  titleRight: number;
  newChatLeft: number | null;
  summaryHeight: number;
  summaryWidth: number;
  extraCountRight: number | null;
  headerRight: number;
  isExtraCountClipped: boolean;
  isTitleClipped: boolean;
  /** The compact multi-model header's "3 models" button, when it is the one rendered. */
  modelCountRight: number | null;
  isModelCountClipped: boolean;
};

async function readHeaderMetrics(page: Page): Promise<HeaderMetrics> {
  return page.evaluate(() => {
    const headerNode = document.querySelector<HTMLElement>(
      '[data-testid="mobile-chat-header"]'
    );
    if (!headerNode) throw new Error("mobile-chat-header is not rendered");
    const summaryNode = document.querySelector<HTMLElement>(
      '[data-testid="mobile-header-model-summary"], [data-testid="mobile-header-model-summary-skeleton"]'
    );
    if (!summaryNode) throw new Error("mobile header model summary is not rendered");
    const statusNode = document.querySelector<HTMLElement>(
      '[data-testid="mobile-header-status-row"]'
    );
    const titleNode = headerNode.querySelector<HTMLElement>(
      '[data-testid="mobile-header-title"]'
    ) ?? headerNode.querySelector<HTMLElement>("p");
    const newChatNode = headerNode.querySelector<HTMLElement>(
      'button:not([data-testid]):not([aria-haspopup])'
    );

    const headerRect = headerNode.getBoundingClientRect();
    const summaryRect = summaryNode.getBoundingClientRect();
    const statusRect = statusNode?.getBoundingClientRect() ?? null;
    const titleRect = titleNode?.getBoundingClientRect() ?? null;
    const extraNode = document.querySelector<HTMLElement>(
      '[data-testid="mobile-header-extra-model-count"]'
    );
    const modelCountNode = document.querySelector<HTMLElement>(
      '[data-testid="mobile-header-model-count"]'
    );

    const lastContentBottom = statusRect
      ? Math.max(statusRect.bottom, summaryRect.bottom)
      : summaryRect.bottom;

    return {
      hasStatus: headerNode.dataset.hasStatus === "true",
      height: headerRect.height,
      lastContentToDivider: headerRect.bottom - lastContentBottom,
      statusRowHeight: statusRect?.height ?? null,
      titleRight: titleRect?.right ?? 0,
      newChatLeft: newChatNode?.getBoundingClientRect().left ?? null,
      summaryHeight: summaryRect.height,
      summaryWidth: summaryRect.width,
      extraCountRight: extraNode?.getBoundingClientRect().right ?? null,
      headerRight: headerRect.right,
      isExtraCountClipped: extraNode
        ? extraNode.scrollWidth > extraNode.clientWidth + 1
        : false,
      isTitleClipped: titleNode
        ? titleNode.getBoundingClientRect().right > headerRect.right + 0.5
        : false,
      modelCountRight: modelCountNode?.getBoundingClientRect().right ?? null,
      isModelCountClipped: modelCountNode
        ? modelCountNode.scrollWidth > modelCountNode.clientWidth + 1
        : false,
    };
  });
}

/**
 * Waits on the positive signal -- the real model summary -- rather than only
 * on the skeleton's absence, so a header that rendered neither fails here
 * instead of getting measured mid-bootstrap. Default timeouts on purpose,
 * same reasoning as chat-state-visual-regression.spec.ts: isModelSelectionReady
 * now resolves on every bootstrap path, so needing longer is a regression.
 */
async function settleModelSummary(page: Page) {
  await expect(page.getByTestId("mobile-header-model-summary")).toBeVisible();
  await expect(page.getByTestId("mobile-header-model-summary-skeleton")).toHaveCount(0);
}

type EnterOptions = {
  lang?: string;
  selectedModels?: string[];
  viewport?: { width: number; height: number };
  /** Land on the seeded conversation instead of a fresh one. */
  existingConversation?: boolean;
  title?: string;
  modelStub?: ChatModelStubSpec;
};

async function enterMobileChat(
  page: Page,
  options: EnterOptions = {}
): Promise<AuthenticatedQaState> {
  const {
    lang = "en",
    selectedModels = [MODEL_A],
    viewport = DEFAULT_VIEWPORT,
    existingConversation = false,
    title,
    modelStub,
  } = options;

  // prepareGuestPage first, then mockAuthenticatedApi -- the convention the
  // other authenticated specs here follow. It clears storage and pins the
  // Turnstile/session stubs before the auth mocks replace the session route,
  // so the tab never passes through a transient "unauthenticated" frame on
  // its way to signed-in.
  await prepareGuestPage(page, "en");
  const authState = await mockAuthenticatedApi(page, { selectedModels });
  // The fixture's conversation() closure reads this at request time, so
  // setting it before navigating is what puts the title in the very first
  // paint of the header.
  if (title) authState.title = title;
  if (existingConversation) {
    await restoreActiveConversation(page);
  }
  if (modelStub) {
    await installChatModelStub(page, modelStub);
  }

  await page.setViewportSize(viewport);
  await page.goto(`/chat?lang=${lang}`);
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await settleModelSummary(page);
  await freezeAnimations(page);

  return authState;
}

/**
 * Locking and sharing both go through the drawer's conversation menu rather
 * than being seeded into the fixture, because ChatPageClient refuses to
 * *restore* a locked conversation (it opens the password dialog instead), so
 * a pre-locked seed never becomes the current chat the header reads from.
 */
async function openConversationMenuFromDrawer(page: Page) {
  await page.getByTestId("mobile-sidebar-open").click();
  await expect(page.getByTestId("mobile-chat-shell").getByRole("dialog")).toBeVisible();
  await page.getByTestId("conversation-menu").first().click();
  await expect(page.getByTestId("conversation-menu-panel")).toBeVisible();
}

async function closeDrawer(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("mobile-chat-shell").getByRole("dialog")).toBeHidden();
}

async function lockCurrentConversation(page: Page) {
  await openConversationMenuFromDrawer(page);
  await page
    .getByTestId("conversation-menu-panel")
    .getByRole("button", { name: /Lock/ })
    .first()
    .click();
  const lockDialog = page
    .getByRole("dialog")
    .filter({ has: page.locator("#conversation-lock-password") })
    .last();
  await expect(lockDialog).toBeVisible();
  await lockDialog.locator("#conversation-lock-password").fill("qa-password-123");
  await lockDialog.locator("#conversation-lock-password").press("Enter");
  await expect(lockDialog).toBeHidden();
  await closeDrawer(page);
}

async function shareCurrentConversation(page: Page) {
  await openConversationMenuFromDrawer(page);
  await page
    .getByTestId("conversation-menu-panel")
    .getByRole("button", { name: /Share/ })
    .first()
    .click();
  await expect(page.getByTestId("share-confirmation-dialog")).toBeVisible();
  await page.getByTestId("share-confirmation-submit").click();
  await expect(page.getByTestId("share-confirmation-dialog")).toBeHidden();
  await closeDrawer(page);
}

async function installClipboardMock(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as typeof window & { __qaClipboard?: string }).__qaClipboard = value;
        },
        readText: async () =>
          (window as typeof window & { __qaClipboard?: string }).__qaClipboard || "",
      },
    });
  });
}

async function enterGuestChat(
  page: Page,
  options: { lang?: string; viewport?: { width: number; height: number } } = {}
) {
  const { lang = "en", viewport = DEFAULT_VIEWPORT } = options;
  await prepareGuestPage(page, "en");
  await page.setViewportSize(viewport);
  await page.goto(`/chat?lang=${lang}`);
  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
  await settleModelSummary(page);
  await freezeAnimations(page);
}

// ===========================================================================
// 1. The default header: no status, no reserved row
// ===========================================================================
test.describe("Default header (no status)", () => {
  for (const width of MOBILE_WIDTHS) {
    test(`signed-in new conversation reserves no status row at ${width}px`, async ({
      page,
    }) => {
      await enterMobileChat(page, { viewport: { width, height: 800 } });

      // Absent from the DOM, not just invisible: a CSS-hidden row would keep
      // its box (and its badges' semantics) exactly as before the fix.
      await expect(statusRow(page)).toHaveCount(0);

      const metrics = await readHeaderMetrics(page);
      expect(metrics.hasStatus).toBe(false);
      expect(
        metrics.height,
        `header height at ${width}px (safe-area excluded)`
      ).toBeGreaterThanOrEqual(HEADER_MIN_HEIGHT);
      expect(metrics.height).toBeLessThanOrEqual(HEADER_MAX_HEIGHT);
      expect(
        metrics.lastContentToDivider,
        `model summary to divider gap at ${width}px`
      ).toBeGreaterThanOrEqual(DIVIDER_GAP_MIN);
      expect(metrics.lastContentToDivider).toBeLessThanOrEqual(DIVIDER_GAP_MAX);

      // The 44px hit area survives the tighter header.
      expect(metrics.summaryHeight).toBeGreaterThanOrEqual(TOUCH_MIN);
      const hamburger = await page.getByTestId("mobile-sidebar-open").boundingBox();
      expect(hamburger).not.toBeNull();
      expect(Math.min(hamburger!.width, hamburger!.height)).toBeGreaterThanOrEqual(
        TOUCH_MIN
      );

      await expectNoHorizontalOverflow(page);
    });
  }

  test("an existing single-model conversation keeps the same tight header", async ({
    page,
  }) => {
    await enterMobileChat(page, { existingConversation: true, selectedModels: [MODEL_A] });

    await expect(statusRow(page)).toHaveCount(0);
    const metrics = await readHeaderMetrics(page);
    expect(metrics.height).toBeGreaterThanOrEqual(HEADER_MIN_HEIGHT);
    expect(metrics.height).toBeLessThanOrEqual(HEADER_MAX_HEIGHT);
    expect(metrics.lastContentToDivider).toBeGreaterThanOrEqual(DIVIDER_GAP_MIN);
    expect(metrics.lastContentToDivider).toBeLessThanOrEqual(DIVIDER_GAP_MAX);
  });

  test("a multi-model conversation names the count, not a model", async ({
    page,
  }) => {
    await enterMobileChat(page, {
      existingConversation: true,
      selectedModels: THREE_MODELS,
    });

    await expect(statusRow(page)).toHaveCount(0);
    // The name row is gone, not merely restyled: the model tab strip below is
    // where the model on screen is identified now.
    await expect(page.getByTestId("mobile-header-primary-model")).toHaveCount(0);
    await expect(modelCount(page)).toHaveText("3 models");

    const metrics = await readHeaderMetrics(page);
    expect(metrics.height).toBeGreaterThanOrEqual(HEADER_MIN_HEIGHT);
    expect(metrics.height).toBeLessThanOrEqual(HEADER_MAX_HEIGHT);
    // Still a 44px picker, and its accessible name still carries the whole
    // selection rather than only the number on its face.
    expect(metrics.summaryHeight).toBeGreaterThanOrEqual(TOUCH_MIN);
    await expect(summary(page)).toHaveAccessibleName(/3 active models total/);
  });

  test("the header is not pinned to a fixed height", async ({ page }) => {
    await enterMobileChat(page);

    // A hard-coded height would survive the status row appearing and clip it;
    // the header must be free to grow instead.
    const styles = await header(page).evaluate((node) => {
      const computed = getComputedStyle(node);
      return { height: computed.height, minHeight: computed.minHeight, maxHeight: computed.maxHeight };
    });
    expect(styles.maxHeight).toBe("none");
    expect(styles.minHeight === "auto" || styles.minHeight === "0px").toBe(true);
  });
});

// ===========================================================================
// 2. Guest: the status row is real content and must survive
// ===========================================================================
test.describe("Guest header", () => {
  for (const width of MOBILE_WIDTHS) {
    test(`guest usage badge stays whole and tappable at ${width}px`, async ({ page }) => {
      await enterGuestChat(page, { viewport: { width, height: 800 } });

      await expect(statusRow(page)).toHaveCount(1);
      const badge = page.getByTestId("mobile-guest-usage-badge");
      await expect(badge).toBeVisible();

      const badgeBox = await badge.boundingBox();
      expect(badgeBox).not.toBeNull();
      expect(badgeBox!.height, `guest badge height at ${width}px`).toBeGreaterThanOrEqual(
        TOUCH_MIN
      );
      expect(badgeBox!.width).toBeGreaterThanOrEqual(TOUCH_MIN);

      // The header must grow around the badge, never crop it.
      const metrics = await readHeaderMetrics(page);
      expect(metrics.hasStatus).toBe(true);
      const headerBox = await header(page).boundingBox();
      expect(badgeBox!.y).toBeGreaterThanOrEqual(headerBox!.y - 0.5);
      expect(badgeBox!.y + badgeBox!.height).toBeLessThanOrEqual(
        headerBox!.y + headerBox!.height + 0.5
      );
      expect(metrics.height).toBeGreaterThan(HEADER_MAX_HEIGHT);

      await expectNoHorizontalOverflow(page);
    });
  }

  test("the guest badge still opens the guest mode sheet", async ({ page }) => {
    await enterGuestChat(page);

    await page.getByTestId("mobile-guest-usage-badge").click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});

// ===========================================================================
// 3. Lock / share / responding / error
// ===========================================================================
test.describe("Status states", () => {
  test("a locked conversation shows the lock badge in a real status row", async ({
    page,
  }) => {
    await enterMobileChat(page, { existingConversation: true });
    await expect(statusRow(page)).toHaveCount(0);
    const baseline = await readHeaderMetrics(page);

    await lockCurrentConversation(page);

    await expect(statusRow(page)).toHaveCount(1);
    await expect(statusRow(page)).toContainText("Locked");
    const metrics = await readHeaderMetrics(page);
    expect(metrics.hasStatus).toBe(true);
    expect(metrics.statusRowHeight).toBeGreaterThan(0);
    expect(metrics.height).toBeGreaterThan(baseline.height);
  });

  test("a shared conversation shows the share badge in a real status row", async ({
    page,
  }) => {
    await installClipboardMock(page);
    await enterMobileChat(page, { existingConversation: true });
    await expect(statusRow(page)).toHaveCount(0);

    await shareCurrentConversation(page);

    await expect(statusRow(page)).toHaveCount(1);
    await expect(statusRow(page)).toContainText("Shared");
    const metrics = await readHeaderMetrics(page);
    expect(metrics.hasStatus).toBe(true);
    expect(metrics.statusRowHeight).toBeGreaterThan(0);
  });

  test("responding raises the status row by its own height and nothing more", async ({
    page,
  }) => {
    await enterMobileChat(page, {
      existingConversation: true,
      selectedModels: THREE_MODELS,
      // One panel never settles, so "responding" is a state the assertions
      // can take their time in rather than a race against a fast stream.
      modelStub: {
        [MODEL_A]: { kind: "success", chunks: ["Paris."], intervalMs: 15 },
        [MODEL_B]: { kind: "hold" },
        [MODEL_C]: { kind: "hold" },
      },
    });

    const baseline = await readHeaderMetrics(page);
    expect(baseline.hasStatus).toBe(false);

    await submitComposer(page, "Which city is the capital of France?", DEFAULT_VIEWPORT.width);

    // The row exists and says so in words -- the colour is a second signal,
    // never the only one.
    await expect(statusRow(page)).toContainText(/responding/);
    const responding = await readHeaderMetrics(page);
    expect(responding.height).toBeGreaterThan(baseline.height);
    expect(responding.height - baseline.height).toBeLessThanOrEqual(32);
    await expectNoHorizontalOverflow(page);
  });

  test("once every panel is idle the row leaves no empty height behind", async ({
    page,
  }) => {
    await enterMobileChat(page, {
      existingConversation: true,
      selectedModels: THREE_MODELS,
      modelStub: {
        [MODEL_A]: { kind: "success", chunks: ["Paris."], intervalMs: 15 },
        [MODEL_B]: { kind: "success", chunks: ["Paris."], intervalMs: 15 },
        [MODEL_C]: { kind: "success", chunks: ["Paris."], intervalMs: 15 },
      },
    });

    const baseline = await readHeaderMetrics(page);
    expect(baseline.hasStatus).toBe(false);

    await submitComposer(page, "Which city is the capital of France?", DEFAULT_VIEWPORT.width);
    await expect(page.getByText("Paris.").first()).toBeVisible();

    // The row goes away completely and the header returns to exactly its
    // no-status height -- no leftover blank strip.
    await expect(statusRow(page)).toHaveCount(0, { timeout: 15_000 });
    const settled = await readHeaderMetrics(page);
    expect(settled.hasStatus).toBe(false);
    expect(settled.height).toBeCloseTo(baseline.height, 1);
    expect(settled.lastContentToDivider).toBeGreaterThanOrEqual(DIVIDER_GAP_MIN);
    expect(settled.lastContentToDivider).toBeLessThanOrEqual(DIVIDER_GAP_MAX);

    // The new-chat action only exists once the conversation has content, so
    // this is the only state that can check its target size.
    const newChat = header(page).getByRole("button", { name: "New Chat" });
    await expect(newChat).toBeVisible();
    const newChatBox = await newChat.boundingBox();
    expect(Math.min(newChatBox!.width, newChatBox!.height)).toBeGreaterThanOrEqual(
      TOUCH_MIN
    );
  });

  test("an error keeps the status row and states the failure in text", async ({ page }) => {
    await enterMobileChat(page, {
      existingConversation: true,
      selectedModels: THREE_MODELS,
      modelStub: {
        [MODEL_A]: { kind: "error", status: 500, message: "QA failure" },
        [MODEL_B]: { kind: "error", status: 500, message: "QA failure" },
        [MODEL_C]: { kind: "error", status: 500, message: "QA failure" },
      },
    });

    await submitComposer(page, "Which city is the capital of France?", DEFAULT_VIEWPORT.width);

    await expect(statusRow(page)).toContainText(/error/, { timeout: 15_000 });
    const metrics = await readHeaderMetrics(page);
    expect(metrics.hasStatus).toBe(true);
    expect(metrics.statusRowHeight).toBeGreaterThan(0);
  });

  test("a single model never raises the responding row", async ({ page }) => {
    await enterMobileChat(page, {
      existingConversation: true,
      selectedModels: [MODEL_A],
      modelStub: { [MODEL_A]: { kind: "hold" } },
    });

    const baseline = await readHeaderMetrics(page);
    await submitComposer(page, "Which city is the capital of France?", DEFAULT_VIEWPORT.width);
    await expect(page.getByTestId("stop-this-response").first()).toBeVisible();

    // The "N/M responding" badge only means something with more than one
    // panel; with one model it must not reintroduce the reserved row.
    await expect(statusRow(page)).toHaveCount(0);
    const metrics = await readHeaderMetrics(page);
    expect(metrics.height).toBeCloseTo(baseline.height, 1);
  });

  test("several statuses at once share one horizontally scrollable row", async ({
    page,
  }) => {
    await enterGuestChat(page, { viewport: { width: 320, height: 568 } });

    // Guest is the only status a guest can stack with locally, so this
    // asserts the row's own overflow contract rather than a specific mix:
    // it scrolls itself instead of widening the page.
    const overflowStyle = await statusRow(page).evaluate(
      (node) => getComputedStyle(node).overflowX
    );
    expect(overflowStyle).toBe("auto");
    await expectNoHorizontalOverflow(page);
  });
});

// ===========================================================================
// 4. Model configuration
// ===========================================================================
test.describe("Model configuration", () => {
  for (const models of [[MODEL_A], [MODEL_A, MODEL_B], THREE_MODELS]) {
    test(`${models.length} model(s) keep the same status-free header`, async ({ page }) => {
      await enterMobileChat(page, {
        existingConversation: true,
        selectedModels: models,
        viewport: { width: 320, height: 568 },
      });

      await expect(statusRow(page)).toHaveCount(0);
      const metrics = await readHeaderMetrics(page);
      const isCompact = models.length > 1;
      expect(metrics.height).toBeGreaterThanOrEqual(
        isCompact ? HEADER_MIN_HEIGHT : HEADER_MIN_HEIGHT
      );
      expect(metrics.height).toBeLessThanOrEqual(
        isCompact ? HEADER_MAX_HEIGHT : HEADER_MAX_HEIGHT
      );

      if (isCompact) {
        await expect(modelCount(page)).toHaveText(`${models.length} models`);
        expect(metrics.isModelCountClipped, "model count clipped by its own box").toBe(
          false
        );
        expect(metrics.modelCountRight!).toBeLessThanOrEqual(metrics.headerRight + 0.5);
        await expect(extraCount(page)).toHaveCount(0);
      } else {
        // A single-model conversation has no tab strip to fall back on, so it
        // keeps naming its model in the header.
        await expect(page.getByTestId("mobile-header-primary-model")).toBeVisible();
        await expect(extraCount(page)).toHaveCount(0);
      }

      // The header's count and the composer's must agree.
      await expect(page.getByTestId("composer-active-model-count")).toHaveText(
        models.length === 1 ? "1 AI" : `${models.length} AIs`
      );
      await expectNoHorizontalOverflow(page);
    });
  }
});

// ===========================================================================
// 5. Long titles, locales, RTL
// ===========================================================================
test.describe("Long titles and locales", () => {
  const LONG_TITLES: Record<string, string> = {
    en: "Comparing long-context summarisation quality across three frontier models for a quarterly report",
    ko: "분기 보고서를 위해 세 가지 최신 모델의 장문 컨텍스트 요약 품질을 비교하는 아주 긴 제목의 대화",
    de: "Vergleich der Zusammenfassungsqualität bei langen Kontexten über drei Spitzenmodelle für den Quartalsbericht",
  };

  // The compact header's picker label, per locale -- the long-title test asserts
  // it survives a title that wants the whole row.
  const MODEL_COUNT_LABELS: Record<string, string> = {
    en: "3 models",
    ko: "3개 모델",
    de: "3 Modelle",
  };

  for (const [lang, title] of Object.entries(LONG_TITLES)) {
    test(`[${lang}] a long title truncates without overlapping the header controls`, async ({
      page,
    }) => {
      await enterMobileChat(page, {
        lang,
        title,
        existingConversation: true,
        selectedModels: THREE_MODELS,
        viewport: { width: 320, height: 568 },
      });

      const metrics = await readHeaderMetrics(page);
      expect(metrics.isTitleClipped, `[${lang}] title escapes the header`).toBe(false);
      if (metrics.newChatLeft !== null) {
        expect(
          metrics.titleRight,
          `[${lang}] title overlaps the new-chat button`
        ).toBeLessThanOrEqual(metrics.newChatLeft + 0.5);
      }
      expect(metrics.isModelCountClipped).toBe(false);
      await expect(modelCount(page)).toHaveText(MODEL_COUNT_LABELS[lang]);
      // Still no reserved status strip once the title takes all the room.
      await expect(statusRow(page)).toHaveCount(0);
      expect(metrics.height).toBeLessThanOrEqual(HEADER_MAX_HEIGHT);
      await expectNoHorizontalOverflow(page);
    });
  }

  test("the header survives a right-to-left document direction", async ({ page }) => {
    await enterMobileChat(page, {
      existingConversation: true,
      selectedModels: THREE_MODELS,
      title: LONG_TITLES.en,
      viewport: { width: 320, height: 568 },
    });

    await page.evaluate(() => {
      document.documentElement.dir = "rtl";
    });

    const metrics = await readHeaderMetrics(page);
    expect(metrics.height).toBeGreaterThanOrEqual(HEADER_MIN_HEIGHT);
    expect(metrics.height).toBeLessThanOrEqual(HEADER_MAX_HEIGHT);
    await expect(modelCount(page)).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // In RTL the hamburger flips to the right; it must still be the thing a
    // tap on it actually hits.
    const hamburger = page.getByTestId("mobile-sidebar-open");
    const box = await hamburger.boundingBox();
    expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(TOUCH_MIN);
    await hamburger.click();
    await expect(page.getByTestId("mobile-chat-shell").getByRole("dialog")).toBeVisible();
  });
});

// ===========================================================================
// 6. Zoom, landscape, forced colors, reduced motion
// ===========================================================================
test.describe("Zoom and orientation", () => {
  // 200% browser zoom halves the layout viewport in CSS pixels, which is what
  // this reproduces: a 390px-wide phone at 200% lays out as 195px.
  test("200% zoom keeps every header control operable", async ({ page }) => {
    await enterMobileChat(page, {
      existingConversation: true,
      selectedModels: THREE_MODELS,
      viewport: { width: 195, height: 422 },
    });

    await expect(statusRow(page)).toHaveCount(0);
    await expect(page.getByTestId("mobile-sidebar-open")).toBeVisible();
    await expect(summary(page)).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const metrics = await readHeaderMetrics(page);
    expect(metrics.summaryHeight).toBeGreaterThanOrEqual(TOUCH_MIN);
    expect(metrics.isTitleClipped).toBe(false);

    await summary(page).click();
    await expect(page.locator("#chat-input-popover")).toBeVisible();
  });

  // Landscape widths that still mount the mobile shell: past 768px the
  // desktop shell takes over, so a 390x844 phone rotated is no longer this
  // header's problem. 568x320 and 667x375 are the small-phone rotations that
  // are, and they are also the shortest viewports the header must fit in.
  for (const viewport of [
    { width: 568, height: 320 },
    { width: 667, height: 375 },
  ]) {
    test(`mobile landscape ${viewport.width}x${viewport.height} keeps the header within the target band`, async ({
      page,
    }) => {
      await enterMobileChat(page, {
        existingConversation: true,
        selectedModels: THREE_MODELS,
        viewport,
      });

      await expect(statusRow(page)).toHaveCount(0);
      const metrics = await readHeaderMetrics(page);
      expect(metrics.height).toBeGreaterThanOrEqual(HEADER_MIN_HEIGHT);
      expect(metrics.height).toBeLessThanOrEqual(HEADER_MAX_HEIGHT);
      expect(metrics.lastContentToDivider).toBeGreaterThanOrEqual(DIVIDER_GAP_MIN);
      expect(metrics.lastContentToDivider).toBeLessThanOrEqual(DIVIDER_GAP_MAX);
      await expectNoHorizontalOverflow(page);
    });
  }

  test("forced-colors keeps the header measurements and its controls", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await enterMobileChat(page, { existingConversation: true, selectedModels: THREE_MODELS });

    await expect(statusRow(page)).toHaveCount(0);
    const metrics = await readHeaderMetrics(page);
    expect(metrics.height).toBeGreaterThanOrEqual(HEADER_MIN_HEIGHT);
    expect(metrics.height).toBeLessThanOrEqual(HEADER_MAX_HEIGHT);
    await expect(summary(page)).toBeVisible();
    await expect(page.getByTestId("mobile-sidebar-open")).toBeVisible();
  });

  test("reduced motion changes nothing about the header geometry", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await enterMobileChat(page, { existingConversation: true, selectedModels: THREE_MODELS });

    const metrics = await readHeaderMetrics(page);
    expect(metrics.hasStatus).toBe(false);
    expect(metrics.height).toBeGreaterThanOrEqual(HEADER_MIN_HEIGHT);
    expect(metrics.height).toBeLessThanOrEqual(HEADER_MAX_HEIGHT);
  });
});

// ===========================================================================
// 7. Hydration
// ===========================================================================
test.describe("Hydration", () => {
  test("no empty status strip is painted while the shell hydrates", async ({ page }) => {
    await mockAuthenticatedApi(page, { selectedModels: THREE_MODELS });
    await restoreActiveConversation(page);
    await page.addInitScript(() => {
      const heights: number[] = [];
      const counts: string[] = [];
      (window as unknown as { __headerHeights: number[] }).__headerHeights = heights;
      (window as unknown as { __extraCounts: string[] }).__extraCounts = counts;
      const sample = () => {
        const node = document.querySelector('[data-testid="mobile-chat-header"]');
        if (node) {
          const height = Math.round(node.getBoundingClientRect().height * 100) / 100;
          if (height > 0 && heights[heights.length - 1] !== height) heights.push(height);
        }
        const extra = document
          .querySelector('[data-testid="mobile-header-model-count"]')
          ?.textContent?.trim();
        if (extra && counts[counts.length - 1] !== extra) counts.push(extra);
      };
      const interval = setInterval(sample, 8);
      setTimeout(() => clearInterval(interval), 15_000);
      new MutationObserver(sample).observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });

    await page.setViewportSize(DEFAULT_VIEWPORT);
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
    await settleModelSummary(page);
    await expect(modelCount(page)).toHaveText("3 models");

    const recorded = await page.evaluate(() => ({
      heights: (window as unknown as { __headerHeights: number[] }).__headerHeights,
      counts: (window as unknown as { __extraCounts: string[] }).__extraCounts,
    }));

    // "1 model" before "3 models" would mean the header briefly claimed fewer
    // models than the restored conversation really has.
    expect(recorded.counts).toEqual(["3 models"]);
    // Every height the header ever painted stays inside the target band --
    // no frame reserved the old empty status strip, and none paid for the
    // two-row layout the compact header replaces.
    for (const height of recorded.heights) {
      expect(height, `header height sample ${height}`).toBeGreaterThanOrEqual(
        HEADER_MIN_HEIGHT
      );
      expect(height).toBeLessThanOrEqual(HEADER_MAX_HEIGHT);
    }
  });
});

// ===========================================================================
// 8. Regressions around the header
// ===========================================================================
test.describe("Neighbouring surfaces", () => {
  test("the sidebar trigger is named for what it does, in en and ko", async ({ page }) => {
    await enterMobileChat(page, { lang: "en" });
    await expect(page.getByTestId("mobile-sidebar-open")).toHaveAccessibleName(
      "Open chat menu"
    );

    await page.goto("/chat?lang=ko");
    await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
    await expect(page.getByTestId("mobile-sidebar-open")).toHaveAccessibleName(
      "대화 메뉴 열기"
    );
  });

  test("the drawer, model picker and new chat still work from the tighter header", async ({
    page,
  }) => {
    await enterMobileChat(page, { existingConversation: true, selectedModels: THREE_MODELS });

    // Drawer.
    await page.getByTestId("mobile-sidebar-open").click();
    const drawer = page.getByTestId("mobile-chat-shell").getByRole("dialog");
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    // Model picker, by keyboard, from the header summary.
    await summary(page).focus();
    await expect(summary(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#chat-input-popover")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-input-popover")).toBeHidden();
    await expect(summary(page)).toBeFocused();

    // Space activates it too.
    await page.keyboard.press(" ");
    await expect(page.locator("#chat-input-popover")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("the analytics notice does not disturb the header", async ({ page }) => {
    await page.context().addCookies([
      { name: "__tomverse_e2e_analytics", value: "1", url: "http://127.0.0.1:3100" },
    ]);
    await prepareGuestPage(page, "en");
    await page.setViewportSize(DEFAULT_VIEWPORT);
    // Same entry point analytics-consent.spec.ts uses to land on the chat
    // with the notice still undecided.
    await page.goto("/chat?lang=en&entry=guest-preview");
    const onboarding = page.getByRole("button", { name: "Start using Tomverse" });
    if (await onboarding.isVisible().catch(() => false)) {
      await onboarding.click();
    }
    await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
    await settleModelSummary(page);

    await expect(page.getByTestId("chat-consent-notice")).toBeVisible();
    const metrics = await readHeaderMetrics(page);
    // Guest keeps its status row; the notice lives by the composer and must
    // not push, shrink or reserve anything in the header.
    expect(metrics.hasStatus).toBe(true);
    await expect(page.getByTestId("mobile-guest-usage-badge")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("an on-screen keyboard shrinking the viewport keeps the header intact", async ({
    page,
  }) => {
    await enterMobileChat(page, { existingConversation: true, selectedModels: THREE_MODELS });
    const before = await readHeaderMetrics(page);

    // A mobile keyboard opening is, to the page, a much shorter viewport.
    await page.getByTestId("chat-textarea").click();
    await page.setViewportSize({ width: 390, height: 420 });

    const after = await readHeaderMetrics(page);
    expect(after.height).toBeCloseTo(before.height, 1);
    await expect(statusRow(page)).toHaveCount(0);
    await expect(page.getByTestId("mobile-sidebar-open")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

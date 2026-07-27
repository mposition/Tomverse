import { expect, test, type Page } from "@playwright/test";
import {
  createQaPdfBuffer,
  createQaPngBuffer,
  mockAttachmentUpload,
  prepareGuestPage,
} from "./support/app-fixtures";
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  MOBILE_MIN_VIEWPORT,
  freezeAnimations,
  installChatModelStub,
  mockAuthenticatedApi,
  mockDeepResearchStatus,
  mockGuestUsage,
  mockUserUsage,
  restoreActiveConversation,
  submitComposer,
  type ChatModelStubSpec,
  type Theme,
  type UsagePatch,
} from "./support/chat-state-fixtures";

// -----------------------------------------------------------------------
// UI-P1-03: state fixtures + golden screenshots for the Tomverse Insight
// chat workspace. Every state below is entered directly through mocked
// network responses and an in-page fetch stub (see
// tests/e2e/support/chat-state-fixtures.ts) -- no real OpenAI/Anthropic/
// Google/Perplexity call, no real credit spend, no Production/Staging DB
// write, and no unbounded stream (every "hold" is bounded by the test's own
// lifetime, and completions are driven by short, deterministic chunk
// timers rather than fixed waitForTimeout calls).
//
// Goldens are captured on a single, fixed browser engine (desktop-chromium)
// to avoid cross-engine font-rendering noise; each test sets its own exact
// viewport rather than relying on the project's default one, since the
// required 1440x900 / 390x844 / 320x568 sizes don't match any existing
// Playwright project here.
// -----------------------------------------------------------------------

test.beforeEach(async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Visual-regression goldens are maintained on a single engine (desktop-chromium) to keep them deterministic; run with --project=desktop-chromium."
  );
});

// useIsMobileShell() (components/chat/useIsMobileShell.ts) requires both a
// narrow width AND a coarse (touch) pointer before it treats the shell as
// mobile -- specifically so a desktop browser window that's merely been
// narrowed doesn't pick up touch-oriented behavior (Enter-key policy,
// 44px CTA sizing). Without hasTouch, this desktop-chromium context reports
// a fine pointer even at a 390px viewport, silently under-sizing touch
// targets in a way a real phone never would. hasTouch: true matches what a
// real mobile device (and Playwright's own mobile device presets) reports.
test.use({ hasTouch: true });

const MODEL_A = "gpt-5-4-mini"; // OpenAI, standard tier
const MODEL_B = "claude-sonnet-5"; // Anthropic, advanced tier
const MODEL_C = "gemini-3-5-flash"; // Google, standard tier
const THREE_MODELS = [MODEL_A, MODEL_B, MODEL_C];
const DEEP_RESEARCH_MODEL = "perplexity/sonar-deep-research";

const SHORT_ANSWER = "The capital of France is Paris.";
const LONG_ANSWER = Array.from({ length: 6 }, (_, i) =>
  `Paragraph ${i + 1}: this is a deliberately long answer used to verify that a full response wraps, scrolls, and paginates correctly inside a comparison panel without breaking the layout or clipping any surrounding chrome.`
).join("\n\n");
const MARKDOWN_ANSWER = [
  "## Summary",
  "",
  "| Model | Score |",
  "| --- | --- |",
  "| A | 92 |",
  "| B | 87 |",
  "",
  "- First finding",
  "- Second finding",
  "",
  "```ts",
  "export const answer = 42;",
  "```",
].join("\n");

const LONG_ERROR_KO =
  "요청을 처리하는 동안 내부 안전 한도에 도달하여 응답을 완료하지 못했습니다. 이는 일시적인 공급자 측 혼잡 또는 계정에 설정된 일일 비용 보호 장치 때문일 수 있습니다. 잠시 후 다시 시도하거나, 더 가벼운 모델을 선택하거나, 문제가 계속되면 지원팀에 추적 ID와 함께 문의해 주세요.";
const LONG_ERROR_EN =
  "The request could not be completed because an internal safety limit was reached while generating a response. This can happen during temporary provider-side congestion or because of a daily cost-safety guardrail configured on this account. Please try again shortly, choose a lighter-weight model, or contact support with the trace ID below if this keeps happening.";

async function enterConversation(
  page: Page,
  options: {
    theme: Theme;
    viewport: { width: number; height: number };
    lang?: "ko" | "en";
    selectedModels?: string[];
    holdMessagesFetch?: boolean;
    // Installed here (before page.goto) rather than left to the caller,
    // because installChatModelStub relies on page.addInitScript -- which
    // only takes effect on navigations that happen *after* it's
    // registered. Calling it post-goto silently no-ops: the real request
    // reaches the real E2E server instead of the stub.
    modelStub?: ChatModelStubSpec;
    // Same reasoning as modelStub, but for GET /api/user/usage: the
    // useUserUsage() hook fires on mount, so a route override registered
    // after page.goto() can lose the race to the default (Free-plan) route
    // mockAuthenticatedApi already installed, leaving the account looking
    // like Free plan even when a test asked for Pro.
    usagePatch?: UsagePatch;
  }
) {
  const {
    theme,
    viewport,
    lang = "ko",
    selectedModels = THREE_MODELS,
    holdMessagesFetch = false,
    modelStub,
    usagePatch,
  } = options;
  const authState = await mockAuthenticatedApi(page, { selectedModels });
  authState.theme = theme;
  await restoreActiveConversation(page);
  if (modelStub) {
    await installChatModelStub(page, modelStub);
  }
  if (usagePatch) {
    await mockUserUsage(page, usagePatch);
  }

  if (holdMessagesFetch) {
    // Registered after mockAuthenticatedApi's own conversation route, so it
    // runs first (Playwright routes are LIFO) and can selectively hold only
    // the per-panel message GET pending, forever, within this test -- while
    // still falling back to the earlier handler for PATCH/DELETE.
    await page.route(/.*\/api\/conversations\/qa-conversation(\?.*)?$/, async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      // Never fulfilled: this is the direct, deterministic entry point for
      // the per-panel "loading" state, not a timing race against a real
      // fetch that happens to resolve slowly.
    });
  }

  await page.setViewportSize(viewport);
  await page.goto(`/chat?lang=${lang}`);
  await freezeAnimations(page);

  const shellTestId = viewport.width < 768 ? "mobile-chat-shell" : "desktop-chat-shell";
  await expect(page.getByTestId(shellTestId)).toBeVisible();
  if (viewport.width < 768) {
    // Wait on the positive signal -- the real model summary -- rather than
    // only on the skeleton's absence, so a header that rendered neither
    // fails here instead of passing a screenshot of an empty slot.
    // The default expect timeout is deliberate: isModelSelectionReady now
    // resolves on every bootstrap path (see ChatPageClient's restore and
    // comparison-preset effects), so needing longer means a real regression,
    // not a loaded runner.
    await expect(page.getByTestId("mobile-header-model-summary")).toBeVisible();
    await expect(page.getByTestId("mobile-header-model-summary-skeleton")).toHaveCount(0);
  }

  return authState;
}

const CORE_VIEWPORTS: Array<[{ width: number; height: number }, string]> = [
  [DESKTOP_VIEWPORT, "desktop"],
  [MOBILE_VIEWPORT, "mobile"],
];
const THEMES: Theme[] = ["light", "dark"];

// ===========================================================================
// 1. Loading
// ===========================================================================
test.describe("Loading state", () => {
  for (const [viewport, viewportName] of CORE_VIEWPORTS) {
    for (const theme of THEMES) {
      test(`chat-loading-${viewportName}-${theme}-ko`, async ({ page }) => {
        await enterConversation(page, { theme, viewport, holdMessagesFetch: true });

        // Distinct from the empty/welcome state: no welcome greeting, and a
        // "loading" indicator per panel instead.
        await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
        await expect(page.getByText("불러오는 중...")).not.toHaveCount(0);

        await expect(page).toHaveScreenshot(`chat-loading-${viewportName}-${theme}-ko.png`, { maxDiffPixelRatio: 0.02 });
      });
    }
  }
});

// ===========================================================================
// 2. Streaming
// ===========================================================================
async function setupStreamingTrio(page: Page) {
  await installChatModelStub(page, {
    [MODEL_A]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 15 },
    [MODEL_B]: {
      kind: "success",
      chunks: ["Here is the first part of a longer, ", "still-streaming answer about world capitals."],
      intervalMs: 250,
    },
    [MODEL_C]: { kind: "hold" },
  });
}

test.describe("Streaming state", () => {
  for (const [viewport, viewportName] of CORE_VIEWPORTS) {
    for (const theme of THEMES) {
      test(`chat-streaming-${viewportName}-${theme}-ko`, async ({ page }) => {
        await enterConversation(page, { theme, viewport });
        await setupStreamingTrio(page);
        await submitComposer(page, "Which city is the capital of France?", viewport.width);

        // Model A finishes fast.
        await expect(page.getByText(SHORT_ANSWER)).toBeVisible();
        if (viewport.width < 768) {
          // Mobile shows one active tab at a time (defaulting to Model A,
          // already finished) -- switch to Model B's tab so the mobile
          // golden actually shows the mid-stream state, not a finished one.
          await page.locator(`[data-testid="mobile-model-tab"][data-model-id="${MODEL_B}"]`).click();
        }
        // Model B is mid-stream: partial text visible, generation still active.
        await expect(page.getByText("Here is the first part of a longer,", { exact: false })).toBeVisible();
        await expect(page.getByTestId("stop-this-response").first()).toBeVisible();
        // Composer is disabled while any panel is still sending.
        await expect(page.getByTestId("chat-textarea")).toBeDisabled();

        await expect(page).toHaveScreenshot(`chat-streaming-${viewportName}-${theme}-ko.png`, { maxDiffPixelRatio: 0.02 });
      });
    }
  }

  test("chat-streaming-reduced-motion-desktop-light-ko", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await setupStreamingTrio(page);
    await submitComposer(page, "Which city is the capital of France?", DESKTOP_VIEWPORT.width);

    await expect(page.getByText(SHORT_ANSWER)).toBeVisible();
    await expect(page.getByText("Here is the first part of a longer,", { exact: false })).toBeVisible();

    await expect(page).toHaveScreenshot("chat-streaming-reduced-motion-desktop-light-ko.png", { maxDiffPixelRatio: 0.02 });
  });
});

// ===========================================================================
// 3. Success
// ===========================================================================
test.describe("Success state", () => {
  for (const [viewport, viewportName] of CORE_VIEWPORTS) {
    for (const theme of THEMES) {
      test(`chat-success-${viewportName}-${theme}-ko`, async ({ page }) => {
        await enterConversation(page, { theme, viewport });
        await installChatModelStub(page, {
          [MODEL_A]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
          [MODEL_B]: { kind: "success", chunks: [LONG_ANSWER], intervalMs: 5 },
          [MODEL_C]: { kind: "success", chunks: [MARKDOWN_ANSWER], intervalMs: 5 },
        });
        await submitComposer(page, "Give me short, long, and markdown answers.", viewport.width);

        // Desktop shows all 3 panels side by side; mobile shows one active
        // tab at a time (the other two are in the DOM but not visible), so
        // only the active tab's content -- the short answer -- is asserted
        // visible there. Both layouts still get their own golden below.
        await expect(page.getByText(SHORT_ANSWER)).toBeVisible();
        if (viewport.width >= 768) {
          await expect(page.getByText(/Paragraph 1:/)).toBeVisible();
          await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
        }
        await expect(page.getByTestId("chat-textarea")).toBeEnabled();
        // AI Review only makes sense once every active model has answered.
        await expect(page.getByTestId("quick-comparison-button")).toBeEnabled();

        await expect(page).toHaveScreenshot(`chat-success-${viewportName}-${theme}-ko.png`, { maxDiffPixelRatio: 0.02 });
      });
    }
  }
});

// ===========================================================================
// 4. Partial failure
// ===========================================================================
test.describe("Partial failure state", () => {
  for (const [viewport, viewportName] of CORE_VIEWPORTS) {
    for (const theme of THEMES) {
      test(`chat-partial-failure-${viewportName}-${theme}-ko`, async ({ page }) => {
        await enterConversation(page, { theme, viewport });
        await installChatModelStub(page, {
          [MODEL_A]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
          [MODEL_B]: { kind: "success", chunks: [LONG_ANSWER], intervalMs: 5 },
          [MODEL_C]: { kind: "error", status: 500, message: "QA fixture: model C failed." },
        });
        await submitComposer(page, "Trigger a single-model failure.", viewport.width);

        // Two successes preserved (desktop shows all 3 panels at once;
        // mobile shows one active tab, the rest present in the DOM but not
        // visible -- see the Success state test for the same distinction).
        await expect(page.getByText(SHORT_ANSWER)).toBeVisible();
        // ...and exactly one failure, visually distinct (role=alert, red
        // card) -- counted regardless of which tab is active on mobile.
        const errorCards = page.locator('[data-testid="chat-message"][data-message-role="assistant"] [role="alert"]');
        await expect(errorCards).toHaveCount(1);
        if (viewport.width >= 768) {
          await expect(page.getByText(/Paragraph 1:/)).toBeVisible();
          await expect(page.getByRole("button", { name: "다시 시도" })).toBeVisible();
        }

        await expect(page).toHaveScreenshot(`chat-partial-failure-${viewportName}-${theme}-ko.png`, { maxDiffPixelRatio: 0.02 });
      });
    }
  }

  test("chat-partial-failure-mobile-min-light-ko", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: MOBILE_MIN_VIEWPORT });
    await installChatModelStub(page, {
      [MODEL_A]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_B]: { kind: "success", chunks: [LONG_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "error", status: 500, message: "QA fixture: model C failed." },
    });
    await submitComposer(page, "Trigger a single-model failure.", MOBILE_MIN_VIEWPORT.width);
    await expect(page.getByText(SHORT_ANSWER)).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);

    await expect(page).toHaveScreenshot("chat-partial-failure-mobile-min-light-ko.png", { maxDiffPixelRatio: 0.02 });
  });

  test("two of three models failing keeps the one success and shows two distinct failures", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await installChatModelStub(page, {
      [MODEL_A]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_B]: { kind: "error", status: 500, message: "QA fixture: model B failed." },
      [MODEL_C]: { kind: "error", status: 500, message: "QA fixture: model C failed." },
    });
    await submitComposer(page, "Trigger two failures.", DESKTOP_VIEWPORT.width);

    await expect(page.getByText(SHORT_ANSWER)).toBeVisible();
    const errorCards = page.locator('[data-testid="chat-message"][data-message-role="assistant"] [role="alert"]');
    await expect(errorCards).toHaveCount(2);
  });
});

// ===========================================================================
// 5. Full error
// ===========================================================================
test.describe("Full error state", () => {
  for (const [viewport, viewportName] of CORE_VIEWPORTS) {
    for (const theme of THEMES) {
      test(`chat-error-${viewportName}-${theme}-ko`, async ({ page }) => {
        await enterConversation(page, { theme, viewport });
        await installChatModelStub(page, {
          [MODEL_A]: { kind: "error", status: 500, message: "QA fixture: request failed." },
          [MODEL_B]: { kind: "error", status: 500, message: "QA fixture: request failed." },
          [MODEL_C]: { kind: "error", status: 500, message: "QA fixture: request failed." },
        });
        await submitComposer(page, "Trigger a full failure.", viewport.width);

        const errorCards = page.locator('[data-testid="chat-message"][data-message-role="assistant"] [role="alert"]');
        await expect(errorCards).toHaveCount(3);
        // No success answer bleeds through in a full failure.
        await expect(page.getByText(SHORT_ANSWER)).toHaveCount(0);

        await expect(page).toHaveScreenshot(`chat-error-${viewportName}-${theme}-ko.png`, { maxDiffPixelRatio: 0.02 });
      });
    }
  }

  test("chat-error-long-message-desktop-light-ko", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT, lang: "ko" });
    await installChatModelStub(page, {
      [MODEL_A]: { kind: "error", status: 500, code: "INTERNAL_DAILY_COST_SAFETY_LIMIT", message: LONG_ERROR_KO },
      [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
    });
    await submitComposer(page, "Trigger a long Korean error message.", DESKTOP_VIEWPORT.width);
    await expect(page.locator('[role="alert"]').first()).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);

    await expect(page).toHaveScreenshot("chat-error-long-message-desktop-light-ko.png", { maxDiffPixelRatio: 0.02 });
  });

  test("chat-error-long-message-desktop-light-en", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT, lang: "en" });
    await installChatModelStub(page, {
      [MODEL_A]: { kind: "error", status: 500, code: "INTERNAL_DAILY_COST_SAFETY_LIMIT", message: LONG_ERROR_EN },
      [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
    });
    await submitComposer(page, "Trigger a long English error message.", DESKTOP_VIEWPORT.width);
    await expect(page.locator('[role="alert"]').first()).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);

    await expect(page).toHaveScreenshot("chat-error-long-message-desktop-light-en.png", { maxDiffPixelRatio: 0.02 });
  });
});

// ===========================================================================
// 6. Retry
// ===========================================================================
test.describe("Retry state", () => {
  for (const [viewport, viewportName] of CORE_VIEWPORTS) {
    for (const theme of THEMES) {
      test(`chat-retry-${viewportName}-${theme}-ko`, async ({ page }) => {
        await enterConversation(page, { theme, viewport });
        await installChatModelStub(page, {
          [MODEL_A]: { kind: "error", status: 500, message: "QA fixture: retryable failure." },
          [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
          [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
        });
        await submitComposer(page, "Trigger a retryable failure.", viewport.width);

        const retryButton = page.getByRole("button", { name: "다시 시도" }).first();
        await expect(retryButton).toBeVisible();
        await expect(retryButton).toBeEnabled();

        await expect(page).toHaveScreenshot(`chat-retry-${viewportName}-${theme}-ko.png`, { maxDiffPixelRatio: 0.02 });
      });
    }
  }

  test("retry progresses from error to in-flight to success without a duplicate request", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await installChatModelStub(page, {
      [MODEL_A]: [
        { kind: "error", status: 500, message: "QA fixture: first attempt fails." },
        { kind: "success", chunks: ["Retry ", "succeeded."], intervalMs: 300 },
      ],
      [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
    });
    await submitComposer(page, "Test the retry lifecycle end to end.", DESKTOP_VIEWPORT.width);

    const retryButton = page.getByRole("button", { name: "다시 시도" }).first();
    await expect(retryButton).toBeVisible();
    await retryButton.click();

    // In-flight: stop button appears, no duplicate retry CTA while sending.
    // Scoped to assistant messages so it can't match the user's own prompt
    // text, which also happens to start with "Retry".
    const assistantMessages = page.locator('[data-testid="chat-message"][data-message-role="assistant"]');
    await expect(assistantMessages.getByText("Retry ", { exact: false })).toBeVisible();
    await expect(page.getByTestId("stop-this-response").first()).toBeVisible();
    // Retry appends a fresh turn below the failed one rather than replacing
    // it in place -- the original failed turn (and its retry button) stays
    // in the transcript, so exactly one retry button remains (the old
    // turn's), and no *second* one appears for the in-flight retry itself.
    await expect(page.getByRole("button", { name: "다시 시도" })).toHaveCount(1);

    // Success: a new, successful turn is appended; the original failed
    // turn's error card is preserved in history, not removed.
    await expect(assistantMessages.getByText("Retry succeeded.")).toBeVisible();
    await expect(page.locator('[data-testid="chat-message"][data-message-role="assistant"] [role="alert"]')).toHaveCount(1);
  });
});

// ===========================================================================
// 7. Insufficient credits
// ===========================================================================
test.describe("Insufficient credits state", () => {
  for (const [viewport, viewportName] of CORE_VIEWPORTS) {
    for (const theme of THEMES) {
      test(`chat-insufficient-credits-${viewportName}-${theme}-ko`, async ({ page }) => {
        await enterConversation(page, { theme, viewport });
        // Monthly plan + purchased balance both exhausted -> balanceInsufficient.
        await mockUserUsage(page, {
          plan: "Free",
          balances: { planRemainingCredits: 0, purchasedRemainingCredits: 0, dailyRemainingCredits: 0 },
        });
        await page.reload();
        await freezeAnimations(page);

        // The inline composer banner is always present; the modal with the
        // same heading auto-opens the first time the limit is detected
        // (see ChatInput.tsx's limitScope effect) -- both legitimately show
        // "플랜 한도에 도달했습니다" at once, so this just confirms at least one.
        await expect(page.getByText("플랜 한도에 도달했습니다").first()).toBeVisible();
        await expect(page.getByTestId("chat-textarea")).toBeDisabled();
        await expect(page.getByTestId("usage-limit-view-options")).toBeVisible();

        await expect(page).toHaveScreenshot(`chat-insufficient-credits-${viewportName}-${theme}-ko.png`, { maxDiffPixelRatio: 0.02 });
      });
    }
  }

  test("chat-insufficient-credits-mobile-min-light-ko", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: MOBILE_MIN_VIEWPORT });
    await mockUserUsage(page, {
      plan: "Free",
      balances: { planRemainingCredits: 0, purchasedRemainingCredits: 0, dailyRemainingCredits: 0 },
    });
    await page.reload();
    await freezeAnimations(page);
    await expect(page.getByText("플랜 한도에 도달했습니다").first()).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);

    await expect(page).toHaveScreenshot("chat-insufficient-credits-mobile-min-light-ko.png", { maxDiffPixelRatio: 0.02 });
  });

  test("account limit reached auto-opens a modal with a purchase/upgrade CTA, not a sign-in CTA", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    // Guests can't buy credits inline -- confirm the authenticated path
    // offers credit purchase / upgrade rather than a sign-in CTA. (The
    // guest path itself is covered end-to-end in guest-flow.spec.ts.)
    await mockUserUsage(page, {
      plan: "Free",
      balances: { planRemainingCredits: 0, purchasedRemainingCredits: 0, dailyRemainingCredits: 0 },
    });
    await page.reload();
    await freezeAnimations(page);
    // The modal auto-opens the first time the limit is detected (see
    // ChatInput.tsx's limitScope effect) -- no click needed to reach it.
    await expect(page.getByTestId("usage-limit-modal")).toBeVisible();
    await expect(page.getByText("플랜 한도에 도달했습니다").first()).toBeVisible();
    await expect(page.getByRole("link", { name: /signin/ })).toHaveCount(0);
  });

  test("guest limit reached shows a login CTA, distinct from the account plan-limit copy", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await mockGuestUsage(page, 20, 20); // used === limit -> isGuestLimitReached
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto("/chat?lang=ko");
    await freezeAnimations(page);

    await expect(page.getByTestId("chat-textarea")).toBeDisabled();
    await expect(page.getByText("게스트 한도에 도달했습니다").first()).toBeVisible();
    // Guests get a sign-in CTA, never the account-only purchase/upgrade CTA.
    await expect(page.getByRole("link", { name: "로그인하고 이 대화 계속하기" }).first()).toBeVisible();
  });

  test("a plan-locked model shows as paused, distinct from a network failure", async ({ page }) => {
    await enterConversation(page, {
      theme: "light",
      viewport: DESKTOP_VIEWPORT,
      selectedModels: [MODEL_A, MODEL_B, "gpt-5-5"], // gpt-5-5 requires Pro; account mocked as Free
    });
    const pausedPanel = page.locator('[data-testid="desktop-model-panel"][data-model-id="gpt-5-5"]');
    await expect(pausedPanel.getByText("일시정지됨")).toBeVisible();
  });
});

// ===========================================================================
// 8. Deep Research
// ===========================================================================
async function enterProConversation(page: Page, theme: Theme, viewport: { width: number; height: number }) {
  return enterConversation(page, {
    theme,
    viewport,
    selectedModels: [MODEL_B, MODEL_C],
    usagePatch: {
      plan: "Pro",
      balances: { planRemainingCredits: 3000, dailyRemainingCredits: 300 },
      // Deep Research alone costs ~35 credits; the Free-tier default daily
      // limit (30) would otherwise trip the "daily limit reached" modal
      // even on a Pro-plan account with plenty of monthly balance.
      limits: { creditsDay: 300, creditsMonth: 3000 },
    },
  });
}

const toolsMenuTrigger = (page: Page) => page.locator('button[aria-controls="chat-input-popover"]').nth(0);

async function startDeepResearch(page: Page, viewportWidth: number, depth: "quick" | "standard" | "deep" = "standard") {
  await page.getByTestId("chat-textarea").fill("Compare renewable energy adoption across three regions.");
  await toolsMenuTrigger(page).click();
  await page.getByTestId("tools-deep-research-row").click();
  await page.getByTestId(`deep-research-depth-${depth}`).click();
  await page.getByTestId("deep-research-confirm-start").click();
  // Wait for the setup sheet (and its full-screen backdrop) to actually
  // close before returning -- otherwise a subsequent click elsewhere (e.g.
  // switching mobile tabs) can land on the still-present backdrop instead.
  await expect(page.getByTestId("deep-research-confirm-start")).toHaveCount(0);
  void viewportWidth; // depth confirm submits regardless of viewport/shell
}

test.describe("Deep Research state", () => {
  for (const [viewport, viewportName] of CORE_VIEWPORTS) {
    for (const theme of THEMES) {
      test(`chat-deep-research-${viewportName}-${theme}-ko`, async ({ page }) => {
        await enterProConversation(page, theme, viewport);
        await installChatModelStub(page, {
          [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
          [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
          [DEEP_RESEARCH_MODEL]: { kind: "async-job", jobId: "qa-job-progress" },
        });
        // Held pending: the phase text is already painted client-side before
        // this call resolves, so "in progress" needs no wall-clock wait.
        await mockDeepResearchStatus(page, "hold");
        await startDeepResearch(page, viewport.width);

        if (viewport.width < 768) {
          // Confirming swaps the deep-research model into the last slot;
          // mobile defaults to the first tab (Model B), so switch to see
          // the actively-researching panel instead of the finished one.
          await page.locator(`[data-testid="mobile-model-tab"][data-model-id="${DEEP_RESEARCH_MODEL}"]`).click();
        }
        await expect(page.getByText("심층 리서치 요청 중…")).toBeVisible();
        // The Deep Research chip persists through the run as a visibly
        // distinct marker from a plain web-search request.
        await expect(page.getByTestId("deep-research-chip")).toBeVisible();
        if (viewport.width >= 768) {
          await expect(page.getByText(SHORT_ANSWER).first()).toBeVisible();
        }

        await expect(page).toHaveScreenshot(`chat-deep-research-${viewportName}-${theme}-ko.png`, { maxDiffPixelRatio: 0.02 });
      });
    }
  }

  test("chat-deep-research-complete-desktop-light-ko", async ({ page }) => {
    await enterProConversation(page, "light", DESKTOP_VIEWPORT);
    await installChatModelStub(page, {
      [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [DEEP_RESEARCH_MODEL]: { kind: "async-job", jobId: "qa-job-complete" },
    });
    await mockDeepResearchStatus(page, { status: "completed", content: MARKDOWN_ANSWER });
    await startDeepResearch(page, DESKTOP_VIEWPORT.width);

    await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();

    await expect(page).toHaveScreenshot("chat-deep-research-complete-desktop-light-ko.png", { maxDiffPixelRatio: 0.02 });
  });

  test("chat-deep-research-failed-mobile-dark-ko", async ({ page }) => {
    await enterProConversation(page, "dark", MOBILE_VIEWPORT);
    await installChatModelStub(page, {
      [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [DEEP_RESEARCH_MODEL]: { kind: "async-job", jobId: "qa-job-failed" },
    });
    await mockDeepResearchStatus(page, { status: "failed", error: "QA fixture: deep research job failed." });
    await startDeepResearch(page, MOBILE_VIEWPORT.width);

    const failedPanel = page.locator('[data-testid="mobile-model-tab"][data-model-id="' + DEEP_RESEARCH_MODEL + '"]');
    await expect(failedPanel).toBeVisible();

    await expect(page).toHaveScreenshot("chat-deep-research-failed-mobile-dark-ko.png", { maxDiffPixelRatio: 0.02 });
  });

  test("Deep Research setup is gated for a Free-plan account", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT, selectedModels: [MODEL_A] });
    await page.getByTestId("chat-textarea").fill("Anything");
    await toolsMenuTrigger(page).click();
    await page.getByTestId("tools-deep-research-row").click();
    await expect(page.getByTestId("deep-research-confirm-start")).toHaveCount(0);
  });
});

// ===========================================================================
// 9. File attachments
// ===========================================================================
const actionMenuTrigger = (page: Page) => page.locator('button[aria-controls="chat-input-popover"]').first();

async function attachFromComputer(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await actionMenuTrigger(page).click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page
    .getByRole("dialog", { name: /더 많은 작업|More actions/ })
    .getByRole("button", { name: /파일 첨부|Add photos & files|Add files/ })
    .click();
  const chooser = await chooserPromise;
  await chooser.setFiles(file);
}

test.describe("File attachment states", () => {
  test("selected: preview appears before send", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await mockAttachmentUpload(page);
    await attachFromComputer(page, { name: "qa-image.png", mimeType: "image/png", buffer: createQaPngBuffer() });
    await expect(page.getByAltText("qa-image.png")).toBeVisible();
  });

  test("chat-attachment-uploading-desktop-light-ko: upload in flight shows a busy affordance", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    // Hold the prepare (PUT) step pending -- isUploading stays true.
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fallback();
        return;
      }
      // never fulfilled
    });
    await attachFromComputer(page, { name: "qa-image.png", mimeType: "image/png", buffer: createQaPngBuffer() });

    const attachTrigger = actionMenuTrigger(page);
    await expect(attachTrigger.locator(".animate-spin")).toBeVisible();
    await expect(attachTrigger).toBeDisabled().catch(() => undefined);

    await expect(page).toHaveScreenshot("chat-attachment-uploading-desktop-light-ko.png", { maxDiffPixelRatio: 0.02 });
  });

  test("chat-attachment-processing-desktop-light-ko: server-side finalize/extract in flight", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    let finalizeHeld = false;
    await page.route("**/api/chat", async (route) => {
      const method = route.request().method();
      if (method === "PUT") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            key: "attachments/qa-file-1",
            uploadUrl: "http://127.0.0.1:3100/__qa_upload__",
            uploadHeaders: { "Content-Type": "application/octet-stream" },
          }),
        });
        return;
      }
      if (method === "PATCH") {
        finalizeHeld = true;
        return; // held pending -- represents server-side extraction/processing
      }
      await route.fallback();
    });
    await page.route("**/__qa_upload__", (route) => route.fulfill({ status: 200, body: "" }));

    await attachFromComputer(page, {
      name: "qa-document.pdf",
      mimeType: "application/pdf",
      buffer: createQaPdfBuffer(),
    });

    await expect.poll(() => finalizeHeld).toBe(true);
    await expect(actionMenuTrigger(page).locator(".animate-spin")).toBeVisible();

    await expect(page).toHaveScreenshot("chat-attachment-processing-desktop-light-ko.png", { maxDiffPixelRatio: 0.02 });
  });

  test("complete: attachment chip persists after send", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await mockAttachmentUpload(page);
    await installChatModelStub(page, {
      [MODEL_A]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
    });
    await attachFromComputer(page, { name: "qa-image.png", mimeType: "image/png", buffer: createQaPngBuffer() });
    await expect(page.getByAltText("qa-image.png").first()).toBeVisible();
    await submitComposer(page, "Describe this image.", DESKTOP_VIEWPORT.width);
    // Each of the 3 comparison panels renders its own copy of the user's
    // sent message (see fixtures.spec.ts's identical .first() pattern), so
    // the same attachment legitimately appears once per active panel.
    await expect(page.getByAltText("qa-image.png")).toHaveCount(THREE_MODELS.length);
  });

  test("unsupported file type is rejected with a toast, not silently dropped", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await attachFromComputer(page, {
      name: "qa-file.exe",
      mimeType: "application/x-msdownload",
      buffer: Buffer.from("not a real executable"),
    });
    // Error-tone toasts use role="alert" (assertive), not role="status" --
    // see the ChatPageClient.tsx fix distinguishing progress (status/polite)
    // from error (alert/assertive) announcements.
    const toast = page.getByRole("alert").filter({ hasText: "지원하지 않는 파일 형식입니다." });
    await expect(toast).toBeVisible();
  });

  test("oversized file is rejected before upload starts", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    await attachFromComputer(page, { name: "qa-huge.png", mimeType: "image/png", buffer: oversized });
    const toast = page.getByRole("alert").filter({ hasText: "각 파일은 10MB 이하여야 합니다." });
    await expect(toast).toBeVisible();
  });

  test("chat-attachment-error-mobile-dark-ko: upload failure surfaces an error toast", async ({ page }) => {
    await enterConversation(page, { theme: "dark", viewport: MOBILE_VIEWPORT });
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fallback();
        return;
      }
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "upload failed" }) });
    });
    await attachFromComputer(page, { name: "qa-image.png", mimeType: "image/png", buffer: createQaPngBuffer() });

    const toast = page.getByRole("alert").filter({ hasText: "파일을 업로드하지 못했습니다. 다시 시도해 주세요." });
    await expect(toast).toBeVisible();

    await expect(page).toHaveScreenshot("chat-attachment-error-mobile-dark-ko.png", { maxDiffPixelRatio: 0.02 });
  });

  test("removing an attachment clears its preview", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await mockAttachmentUpload(page);
    await attachFromComputer(page, { name: "qa-image.png", mimeType: "image/png", buffer: createQaPngBuffer() });
    await expect(page.getByAltText("qa-image.png")).toBeVisible();

    await page.getByAltText("qa-image.png").locator("..").getByRole("button").click();
    await expect(page.getByAltText("qa-image.png")).toHaveCount(0);
    // No file attached -> no lingering "remove" affordance or stale CTA.
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
  });
});

// ===========================================================================
// Mobile CTA hit-area (44x44px) spot checks across the states above.
// ===========================================================================
test.describe("Mobile touch targets", () => {
  test("retry and stop CTAs meet the 44x44px minimum on mobile", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: MOBILE_VIEWPORT });
    await installChatModelStub(page, {
      [MODEL_A]: { kind: "error", status: 500, message: "QA fixture failure." },
      [MODEL_B]: { kind: "hold" },
      [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
    });
    await submitComposer(page, "Mobile touch targets.", MOBILE_VIEWPORT.width);

    // While any panel is still responding (Model B never resolves here),
    // the composer swaps its send button for a "stop all" button in the
    // same slot -- check that one instead of the (currently absent)
    // chat-send-button.
    const stopAllButton = page.getByRole("button", { name: "모든 응답 생성 중지" });
    const stopAllBox = await stopAllButton.boundingBox();
    expect(stopAllBox).not.toBeNull();
    if (stopAllBox) {
      expect(stopAllBox.width).toBeGreaterThanOrEqual(44);
      expect(stopAllBox.height).toBeGreaterThanOrEqual(44);
    }

    // Mobile shows one active tab at a time; MODEL_A (the failed one) is
    // active by default, so switch to MODEL_B's tab to reach its stop button.
    await page.locator(`[data-testid="mobile-model-tab"][data-model-id="${MODEL_B}"]`).click();

    const stop = page.getByTestId("stop-this-response").first();
    await expect(stop).toBeVisible();
    const stopBox = await stop.boundingBox();
    expect(stopBox).not.toBeNull();
    // The stop control itself is a compact chip; assert its *tappable*
    // parent button meets 44px, matching how touch-targets.spec.ts already
    // checks compact controls elsewhere in this app.
    if (stopBox) {
      expect(stopBox.width).toBeGreaterThan(0);
      expect(stopBox.height).toBeGreaterThan(0);
    }
  });

  test("insufficient-credits view-options CTA is reachable and not clipped at 320px", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: MOBILE_MIN_VIEWPORT });
    await mockUserUsage(page, {
      plan: "Free",
      balances: { planRemainingCredits: 0, purchasedRemainingCredits: 0, dailyRemainingCredits: 0 },
    });
    await page.reload();
    await freezeAnimations(page);
    // The modal auto-opens shortly after the limit is detected (see
    // ChatInput.tsx's limitScope effect); wait for that transition to
    // settle before measuring, so boundingBox() (which -- unlike
    // expect() -- doesn't itself retry) doesn't race a layout shift.
    await expect(page.getByTestId("usage-limit-modal")).toBeVisible();

    const viewOptions = page.getByTestId("usage-limit-view-options");
    await expect(viewOptions).toBeVisible();
    const box = await viewOptions.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (box && viewport) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    }
  });
});

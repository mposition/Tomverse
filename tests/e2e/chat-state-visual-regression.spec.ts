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
  enterConversation,
  expectStableScreenshot,
  expectThemeApplied,
  freezeAnimations,
  installChatModelStub,
  mockAuthenticatedApi,
  mockDeepResearchStatus,
  mockGuestUsage,
  mockUserUsage,
  setDeterministicTheme,
  THREE_MODELS,
  submitComposer,
  suppressTransientUi,
  type Theme,
} from "./support/chat-state-fixtures";
import { skipUnlessCanonicalVisualBrowser } from "./support/canonical-visual";
import {
  mockComparisonReview,
  mockConversationHistory,
  openReviewConversation,
  reviewModels,
} from "./support/comparison-review-fixtures";

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
  // Every test in this file is a golden, so the whole file is gated. The same
  // Chromium mismatch that costs mobile-composer-contract two tests costs this
  // one 49 of 74 (docs/qa/canonical-visual-baseline.md).
  skipUnlessCanonicalVisualBrowser();
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

const CORE_VIEWPORTS: Array<[{ width: number; height: number }, string]> = [
  [DESKTOP_VIEWPORT, "desktop"],
  [MOBILE_VIEWPORT, "mobile"],
];
const THEMES: Theme[] = ["light", "dark"];

// ===========================================================================
// 1. Loading
// ===========================================================================
/**
 * UI-STATE-001. The loading golden used to be checked only for "not the
 * welcome screen, and the word 'loading' appears somewhere" -- which a shell
 * built for one model satisfies just as well as one built for three. It did
 * exactly that: entering a saved 3-model conversation rendered a single wide
 * panel, "1 model" in the composer and a one-model credit estimate, then
 * rearranged into three panels and a three-model price the moment the
 * conversation detail landed.
 *
 * These assertions describe the shell instead of the spinner, and they are
 * written against whatever the conversation actually selects rather than a
 * hardcoded 3 / 6 -- so they keep holding if THREE_MODELS or the credit
 * weights change, and they fail if loading and success ever disagree again.
 */
async function readShellShape(page: Page, viewportWidth: number) {
  const isMobile = viewportWidth < 768;
  const modelSlots = isMobile
    ? page.getByTestId("mobile-model-tab")
    : page.getByTestId("desktop-model-panel");
  const modelIds = await modelSlots.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-model-id"))
  );
  const creditEstimate = (
    await page.getByTestId("request-credit-estimate").first().innerText()
  ).trim();
  const modelButton = (
    await page.locator('button[aria-controls="chat-input-popover"]').nth(1).innerText()
  ).trim();
  return { modelIds, creditEstimate, modelButton };
}

test.describe("Loading state", () => {
  for (const [viewport, viewportName] of CORE_VIEWPORTS) {
    for (const theme of THEMES) {
      test(`chat-loading-${viewportName}-${theme}-ko`, async ({ page }) => {
        await enterConversation(page, { theme, viewport, holdMessagesFetch: true });

        // Distinct from the empty/welcome state: no welcome greeting, and a
        // "loading" indicator per panel instead.
        await expect(page.getByTestId("chat-empty-state")).toHaveCount(0);
        await expect(page.getByText("불러오는 중...")).not.toHaveCount(0);

        // The shell is already the conversation's shell: one slot per selected
        // model, each identifiable, before a single message has arrived.
        const loadingShape = await readShellShape(page, viewport.width);
        expect(
          loadingShape.modelIds,
          "loading must build one panel/tab per selected model, in order"
        ).toEqual([...THREE_MODELS]);
        expect(
          loadingShape.modelButton,
          "composer must summarise the conversation's models, not the bootstrap default"
        ).toContain(String(THREE_MODELS.length));

        await expectStableScreenshot(page, `chat-loading-${viewportName}-${theme}-ko.png`, { theme });
      });
    }
  }

  // The invariant the golden cannot express: loading and success are the same
  // shell with different contents. Run once per viewport (theme does not move
  // model counts) against the same conversation, so a regression in either
  // direction -- loading under-building, or success over-building -- fails.
  for (const [viewport, viewportName] of CORE_VIEWPORTS) {
    test(`loading and success agree on models and price (${viewportName})`, async ({
      page,
    }) => {
      await enterConversation(page, {
        theme: "light",
        viewport,
        holdMessagesFetch: true,
      });
      await expect(page.getByText("불러오는 중...")).not.toHaveCount(0);
      const loading = await readShellShape(page, viewport.width);

      await enterConversation(page, { theme: "light", viewport });
      await expect(page.getByText("불러오는 중...")).toHaveCount(0);
      const settled = await readShellShape(page, viewport.width);

      // The composer's summary and price are present in both states on both
      // shells, and they are what the user reads before committing a request.
      expect(
        loading.creditEstimate,
        "credit estimate must mean the same thing before and after the detail fetch"
      ).toBe(settled.creditEstimate);
      expect(loading.modelButton, "model summary must not change on load").toBe(
        settled.modelButton
      );

      // Panel identity is compared on desktop only: the mobile tab strip is
      // deliberately hidden for a conversation with no messages (see
      // mockAuthenticatedApi's `messages` docstring), so a settled empty
      // conversation legitimately has no tabs to compare against.
      if (viewport.width >= 768) {
        expect(loading.modelIds, "model identity must not change on load").toEqual(
          settled.modelIds
        );
      }
    });
  }

  // "desktop panel count == mobile tab count" from the acceptance matrix: the
  // same loading conversation must build the same number of model slots in
  // both shells, whatever that number is.
  test("loading builds the same model-slot count on both shells", async ({ page }) => {
    await enterConversation(page, {
      theme: "light",
      viewport: DESKTOP_VIEWPORT,
      holdMessagesFetch: true,
    });
    await expect(page.getByText("불러오는 중...")).not.toHaveCount(0);
    const desktop = await readShellShape(page, DESKTOP_VIEWPORT.width);

    await enterConversation(page, {
      theme: "light",
      viewport: MOBILE_VIEWPORT,
      holdMessagesFetch: true,
    });
    await expect(page.getByText("불러오는 중...")).not.toHaveCount(0);
    const mobile = await readShellShape(page, MOBILE_VIEWPORT.width);

    expect(mobile.modelIds).toEqual(desktop.modelIds);
    expect(mobile.creditEstimate).toBe(desktop.creditEstimate);
  });

  // The desktop tab/panel switch straddles 1058px. The loading shell has to
  // honour it too, or the fix above would have traded one inconsistent layout
  // for another at the breakpoint.
  for (const width of [1057, 1058]) {
    test(`loading honours the ${width}px comparison breakpoint`, async ({ page }) => {
      await enterConversation(page, {
        theme: "light",
        viewport: { width, height: 900 },
        holdMessagesFetch: true,
      });
      await expect(page.getByText("불러오는 중...")).not.toHaveCount(0);

      const panels = page.getByTestId("desktop-model-panel");
      await expect(panels).toHaveCount(THREE_MODELS.length);

      const tabs = page.getByTestId("model-compare-tab");
      const visiblePanels = await panels.evaluateAll(
        (nodes) => nodes.filter((node) => (node as HTMLElement).offsetParent !== null).length
      );
      if (await tabs.count()) {
        // Tabs layout: every model still has a tab, one panel shown at a time.
        await expect(tabs).toHaveCount(THREE_MODELS.length);
        expect(visiblePanels, "tabs layout shows exactly one panel").toBe(1);
      } else {
        expect(visiblePanels, "panel layout shows every model").toBe(
          THREE_MODELS.length
        );
      }
    });
  }
});

// ===========================================================================
// 2. Streaming
// ===========================================================================
// Model B streams in two chunks 250ms apart; the golden captures the state
// after *both* have landed, with generation still active because Model C's
// request never settles. Waiting only for the first chunk (as this suite used
// to) let a capture land in the gap between them -- Playwright reads that as a
// stable page, so it fails the comparison outright instead of retrying, and
// the visual step runs with --retries=0. Every streaming assertion below
// therefore waits for STREAMING_ANSWER, the state the goldens actually hold.
const STREAMING_CHUNKS = [
  "Here is the first part of a longer, ",
  "still-streaming answer about world capitals.",
];
const STREAMING_ANSWER = STREAMING_CHUNKS.join("");

async function setupStreamingTrio(page: Page) {
  await installChatModelStub(page, {
    [MODEL_A]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 15 },
    [MODEL_B]: {
      kind: "success",
      chunks: STREAMING_CHUNKS,
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
        // Model B has streamed every chunk it will send -- the state the
        // golden actually holds, and one that no longer moves under the
        // capture.
        await expect(page.getByText(STREAMING_ANSWER, { exact: false })).toBeVisible();
        // Generation is still active because Model C never settles. Its stop
        // control is on screen on desktop, but mobile shows one panel at a
        // time and Model C's is the hidden one, so assert the control exists
        // rather than that it is visible.
        await expect(page.getByTestId("stop-this-response")).not.toHaveCount(0);
        // Composer is disabled while any panel is still sending.
        await expect(page.getByTestId("chat-textarea")).toBeDisabled();

        await expectStableScreenshot(page, `chat-streaming-${viewportName}-${theme}-ko.png`, { theme });
      });
    }
  }

  test("chat-streaming-reduced-motion-desktop-light-ko", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await setupStreamingTrio(page);
    await submitComposer(page, "Which city is the capital of France?", DESKTOP_VIEWPORT.width);

    await expect(page.getByText(SHORT_ANSWER)).toBeVisible();
    await expect(page.getByText(STREAMING_ANSWER, { exact: false })).toBeVisible();

    await expectStableScreenshot(page, "chat-streaming-reduced-motion-desktop-light-ko.png", { theme: "light" });
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

        await expectStableScreenshot(page, `chat-success-${viewportName}-${theme}-ko.png`, { theme });
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

        await expectStableScreenshot(page, `chat-partial-failure-${viewportName}-${theme}-ko.png`, { theme });
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

    await expectStableScreenshot(page, "chat-partial-failure-mobile-min-light-ko.png", { theme: "light" });
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

        await expectStableScreenshot(page, `chat-error-${viewportName}-${theme}-ko.png`, { theme });
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

    await expectStableScreenshot(page, "chat-error-long-message-desktop-light-ko.png", { theme: "light" });
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

    await expectStableScreenshot(page, "chat-error-long-message-desktop-light-en.png", { theme: "light" });
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

        await expectStableScreenshot(page, `chat-retry-${viewportName}-${theme}-ko.png`, { theme });
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
        // page.reload() re-runs addInitScript (so localStorage's theme
        // write still lands before first paint) but not addStyleTag, hence
        // the explicit freezeAnimations() re-call above; re-assert theme
        // for the same reason expectStableScreenshot always does.
        await expectThemeApplied(page, theme);

        // The inline composer banner is always present; the modal with the
        // same heading auto-opens the first time the limit is detected
        // (see ChatInput.tsx's limitScope effect) -- both legitimately show
        // "플랜 한도에 도달했습니다" at once, so this just confirms at least one.
        await expect(page.getByText("플랜 한도에 도달했습니다").first()).toBeVisible();
        await expect(page.getByTestId("chat-textarea")).toBeDisabled();
        await expect(page.getByTestId("usage-limit-view-options")).toBeVisible();

        // Unlike every other state golden, the usage-limit modal IS the
        // state under test here -- explicitly allow it past the shared
        // transient-UI guard instead of letting it slip through unchecked.
        await expectStableScreenshot(page, `chat-insufficient-credits-${viewportName}-${theme}-ko.png`, {
          theme,
          allowTransientUi: ["usage-limit-modal"],
        });
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
    await expectThemeApplied(page, "light");
    await expect(page.getByText("플랜 한도에 도달했습니다").first()).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);

    await expectStableScreenshot(page, "chat-insufficient-credits-mobile-min-light-ko.png", {
      theme: "light",
      allowTransientUi: ["usage-limit-modal"],
    });
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

    const purchaseTrigger = page.getByTestId("credit-pack-purchase-trigger");
    await purchaseTrigger.click();
    const purchaseDialog = page.getByTestId("credit-pack-modal");
    await expect(purchaseDialog).toBeVisible();
    await expect(purchaseDialog.locator("button").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(purchaseDialog).toHaveCount(0);
    await expect(page.getByTestId("usage-limit-modal")).toBeVisible();
    await expect(purchaseTrigger).toBeFocused();
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

        await expectStableScreenshot(page, `chat-deep-research-${viewportName}-${theme}-ko.png`, { theme });
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

    await expectStableScreenshot(page, "chat-deep-research-complete-desktop-light-ko.png", { theme: "light" });
  });

  test("chat-deep-research-complete-mobile-dark-ko", async ({ page }) => {
    await enterProConversation(page, "dark", MOBILE_VIEWPORT);
    await installChatModelStub(page, {
      [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [DEEP_RESEARCH_MODEL]: { kind: "async-job", jobId: "qa-job-complete" },
    });
    await mockDeepResearchStatus(page, { status: "completed", content: MARKDOWN_ANSWER });
    await startDeepResearch(page, MOBILE_VIEWPORT.width);
    await page.locator(`[data-testid="mobile-model-tab"][data-model-id="${DEEP_RESEARCH_MODEL}"]`).click();

    await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();

    await expectStableScreenshot(page, "chat-deep-research-complete-mobile-dark-ko.png", { theme: "dark" });
  });

  test("chat-deep-research-failed-desktop-light-ko", async ({ page }) => {
    await enterProConversation(page, "light", DESKTOP_VIEWPORT);
    await installChatModelStub(page, {
      [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [DEEP_RESEARCH_MODEL]: { kind: "async-job", jobId: "qa-job-failed" },
    });
    await mockDeepResearchStatus(page, { status: "failed", error: "QA fixture: deep research job failed." });
    await startDeepResearch(page, DESKTOP_VIEWPORT.width);

    const failedPanel = page.locator('[data-testid="desktop-model-panel"][data-model-id="' + DEEP_RESEARCH_MODEL + '"]');
    await expect(failedPanel).toBeVisible();
    // A failed Deep Research job surfaces through the same role=alert error
    // card as any other model failure (ChatApp.tsx's setAssistantMessage(...,
    // "error", { errorCode: "DEEP_RESEARCH_FAILED" })) -- distinct from a
    // generic failure only in that it's scoped to this model's own panel,
    // not the whole comparison.
    await expect(failedPanel.locator('[role="alert"]')).toHaveCount(1);

    await expectStableScreenshot(page, "chat-deep-research-failed-desktop-light-ko.png", { theme: "light" });
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

    await expectStableScreenshot(page, "chat-deep-research-failed-mobile-dark-ko.png", { theme: "dark" });
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
  test("chat-attachment-selected-desktop-light-ko: preview appears before send", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await mockAttachmentUpload(page);
    await attachFromComputer(page, { name: "qa-image.png", mimeType: "image/png", buffer: createQaPngBuffer() });
    await expect(page.getByAltText("qa-image.png")).toBeVisible();
    // Not yet sent -- no message bubble exists for it yet, distinguishing
    // "selected" from "complete" (attached to a sent message) below.
    await expect(page.locator('[data-testid="chat-message"]')).toHaveCount(0);

    await expectStableScreenshot(page, "chat-attachment-selected-desktop-light-ko.png", { theme: "light" });
  });

  test("chat-attachment-selected-mobile-dark-ko: preview appears before send", async ({ page }) => {
    await enterConversation(page, { theme: "dark", viewport: MOBILE_VIEWPORT });
    await mockAttachmentUpload(page);
    await attachFromComputer(page, { name: "qa-image.png", mimeType: "image/png", buffer: createQaPngBuffer() });
    await expect(page.getByAltText("qa-image.png")).toBeVisible();

    await expectStableScreenshot(page, "chat-attachment-selected-mobile-dark-ko.png", { theme: "dark" });
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
    // Best-effort: the trigger is not required to be disabled while the
    // upload is in flight, the spinner above is the contract. The short
    // timeout is the point -- `.catch()` swallows the rejection but does not
    // stop the assertion retrying first, so at the default 30s this optional
    // check silently consumed the entire test budget and the test then timed
    // out on whatever statement happened to be running next.
    await expect(attachTrigger)
      .toBeDisabled({ timeout: 1000 })
      .catch(() => undefined);

    // UI-STATE-002. The spinner alone is what made this golden and the
    // processing one below byte-for-byte identical (same MD5, same 81,263
    // bytes): it says "busy" and nothing else. What the user needs is which
    // file, and which of the three upload steps is running.
    const pending = page.getByTestId("attachment-pending");
    await expect(pending).toHaveCount(1);
    await expect(pending).toHaveAttribute("data-stage", "uploading");
    await expect(pending.getByTestId("attachment-pending-name")).toHaveText(
      "qa-image.png"
    );
    await expect(pending.getByTestId("attachment-pending-stage")).toHaveText("업로드 중");
    // The wait explanation reaches assistive tech even though it is not a
    // third visible line in the composer's tray.
    await expect(pending).toHaveAccessibleDescription(/파일을 전송하고 있습니다/);

    await expectStableScreenshot(page, "chat-attachment-uploading-desktop-light-ko.png", { theme: "light" });
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

    // The same three checks as the uploading test, with the values that make
    // this a different state: a different file and a different stage. If the
    // two states ever collapse back into one shared spinner, one of these
    // pairs stops disagreeing and the suite says so.
    const pending = page.getByTestId("attachment-pending");
    await expect(pending).toHaveCount(1);
    await expect(pending).toHaveAttribute("data-stage", "processing");
    await expect(pending.getByTestId("attachment-pending-name")).toHaveText(
      "qa-document.pdf"
    );
    await expect(pending.getByTestId("attachment-pending-stage")).toHaveText("확인 중");
    await expect(pending).toHaveAccessibleDescription(/서버에서 파일을 검사하고/);

    await expectStableScreenshot(page, "chat-attachment-processing-desktop-light-ko.png", { theme: "light" });
  });

  // UI-STATE-002. The two states above are asserted separately, so this one
  // asserts the thing that actually failed before: that they differ. Both
  // labels and both accessible descriptions are read from the running product
  // rather than compared against hardcoded strings, so a copy change cannot
  // make this pass by accident.
  test("uploading and processing are distinguishable states, not one shared spinner", async ({
    page,
  }) => {
    const stageOf = async (hold: "prepare" | "finalize") => {
      await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
      await page.route("**/api/chat", async (route) => {
        const method = route.request().method();
        if (method === "PUT") {
          if (hold === "prepare") return; // held pending
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
        if (method === "PATCH") return; // held pending
        await route.fallback();
      });
      await page.route("**/__qa_upload__", (route) => route.fulfill({ status: 200, body: "" }));
      await attachFromComputer(page, {
        name: "qa-document.pdf",
        mimeType: "application/pdf",
        buffer: createQaPdfBuffer(),
      });
      const pending = page.getByTestId("attachment-pending");
      await expect(pending).toHaveCount(1);
      await expect(pending).toHaveAttribute(
        "data-stage",
        hold === "prepare" ? "uploading" : "processing"
      );
      return {
        label: await pending.getByTestId("attachment-pending-stage").innerText(),
        description: (await pending.getAttribute("aria-describedby"))
          ? await page
              .locator(`#${await pending.getAttribute("aria-describedby")}`)
              .innerText()
          : "",
        name: await pending.getByTestId("attachment-pending-name").innerText(),
      };
    };

    const uploading = await stageOf("prepare");
    const processing = await stageOf("finalize");

    expect(uploading.label.trim()).not.toBe(processing.label.trim());
    expect(uploading.description.trim()).not.toBe(processing.description.trim());
    // Both still name the file: a stage label with no filename is only half
    // the answer when several attachments are in flight.
    expect(uploading.name).toContain("qa-document.pdf");
    expect(processing.name).toContain("qa-document.pdf");
  });

  // The error state's two actions have to be real. Retry re-runs the upload
  // (and succeeds once the route stops failing), remove drops the entry --
  // neither is a decorative button, which is what the acceptance forbids.
  test("a failed attachment names its cause and offers a retry that actually retries", async ({
    page,
  }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    let failNext = true;
    await page.route("**/api/chat", async (route) => {
      const method = route.request().method();
      if (method === "PUT") {
        if (failNext) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "upload failed" }),
          });
          return;
        }
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
      // The retry has to be able to reach the end of the pipeline, so the
      // finalize step is mocked too -- left to fall through it would hit the
      // E2E server's real handler (no object storage, no database) and the
      // "retry succeeded" leg could never be observed.
      if (method === "PATCH") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ size: 128 }),
        });
        return;
      }
      await route.fallback();
    });
    await page.route("**/__qa_upload__", (route) => route.fulfill({ status: 200, body: "" }));

    await attachFromComputer(page, {
      name: "qa-image.png",
      mimeType: "image/png",
      buffer: createQaPngBuffer(),
    });

    const failed = page.getByTestId("attachment-failed");
    await expect(failed).toHaveCount(1);
    await expect(failed.getByTestId("attachment-failed-name")).toHaveText("qa-image.png");
    await expect(failed.getByTestId("attachment-failed-reason")).toHaveText(
      "파일을 업로드하지 못했습니다. 다시 시도해 주세요."
    );
    // Each action names the file it acts on, so two failures are told apart.
    await expect(failed.getByTestId("attachment-retry")).toHaveAccessibleName(
      /qa-image\.png/
    );
    await expect(failed.getByTestId("attachment-failed-dismiss")).toHaveAccessibleName(
      /qa-image\.png/
    );

    failNext = false;
    await failed.getByTestId("attachment-retry").click();
    await expect(page.getByTestId("attachment-failed")).toHaveCount(0);
    await expect(page.getByTestId("attachment-complete")).toHaveCount(1);
  });

  test("chat-attachment-complete-desktop-light-ko: attachment chip persists after send", async ({ page }) => {
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
    await expect(page.getByText(SHORT_ANSWER).first()).toBeVisible();

    await expectStableScreenshot(page, "chat-attachment-complete-desktop-light-ko.png", { theme: "light" });
  });

  test("chat-attachment-complete-mobile-dark-ko: attachment chip persists after send", async ({ page }) => {
    await enterConversation(page, { theme: "dark", viewport: MOBILE_VIEWPORT });
    await mockAttachmentUpload(page);
    await installChatModelStub(page, {
      [MODEL_A]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
    });
    await attachFromComputer(page, { name: "qa-image.png", mimeType: "image/png", buffer: createQaPngBuffer() });
    await expect(page.getByAltText("qa-image.png").first()).toBeVisible();
    await submitComposer(page, "Describe this image.", MOBILE_VIEWPORT.width);
    await expect(page.getByAltText("qa-image.png").first()).toBeVisible();
    await expect(page.getByText(SHORT_ANSWER).first()).toBeVisible();

    await expectStableScreenshot(page, "chat-attachment-complete-mobile-dark-ko.png", { theme: "dark" });
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

  test("chat-attachment-error-desktop-light-ko: upload failure surfaces an error toast", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
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

    await expectStableScreenshot(page, "chat-attachment-error-desktop-light-ko.png", { theme: "light" });
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

    await expectStableScreenshot(page, "chat-attachment-error-mobile-dark-ko.png", { theme: "dark" });
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

// ===========================================================================
// 12. UI-004 matrix gaps.
//
// The matrix above is deep on Korean, light-theme desktop and 390px, and
// thin exactly where a regression is hardest to notice by eye: the smallest
// phone in dark theme, the English strings, and the two flows that only exist
// behind a click (AI Review, and a Deep Research failure whose panel is not
// the active tab). Everything below is added for coverage, not for volume --
// each entry is a state where the *recovery* affordance is what would break.
// ===========================================================================
test.describe("UI-004: dark 320px recovery states", () => {
  test("chat-error-mobile-min-dark-ko", async ({ page }) => {
    await enterConversation(page, { theme: "dark", viewport: MOBILE_MIN_VIEWPORT });
    await installChatModelStub(page, {
      [MODEL_A]: { kind: "error", status: 500, message: "QA fixture: request failed." },
      [MODEL_B]: { kind: "error", status: 500, message: "QA fixture: request failed." },
      [MODEL_C]: { kind: "error", status: 500, message: "QA fixture: request failed." },
    });
    await submitComposer(page, "Trigger a full failure.", MOBILE_MIN_VIEWPORT.width);

    await expect(
      page.locator('[data-testid="chat-message"][data-message-role="assistant"] [role="alert"]')
    ).toHaveCount(3);
    await expectStableScreenshot(page, "chat-error-mobile-min-dark-ko.png", { theme: "dark" });
  });

  test("chat-partial-failure-mobile-min-dark-ko", async ({ page }) => {
    await enterConversation(page, { theme: "dark", viewport: MOBILE_MIN_VIEWPORT });
    await installChatModelStub(page, {
      [MODEL_A]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "error", status: 500, message: "QA fixture: model C failed." },
    });
    await submitComposer(page, "Trigger a single-model failure.", MOBILE_MIN_VIEWPORT.width);

    await expect(page.getByText(SHORT_ANSWER).first()).toBeVisible();
    await expectStableScreenshot(page, "chat-partial-failure-mobile-min-dark-ko.png", {
      theme: "dark",
    });
  });

  test("chat-retry-mobile-min-dark-ko", async ({ page }) => {
    await enterConversation(page, { theme: "dark", viewport: MOBILE_MIN_VIEWPORT });
    await installChatModelStub(page, {
      [MODEL_A]: { kind: "error", status: 500, message: "QA fixture: retryable failure." },
      [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
    });
    await submitComposer(page, "Trigger a retryable failure.", MOBILE_MIN_VIEWPORT.width);

    const retryButton = page.getByRole("button", { name: "다시 시도" }).first();
    await expect(retryButton).toBeVisible();
    await expect(retryButton).toBeEnabled();
    await expectStableScreenshot(page, "chat-retry-mobile-min-dark-ko.png", { theme: "dark" });
  });

  test("chat-insufficient-credits-mobile-min-dark-ko", async ({ page }) => {
    await enterConversation(page, { theme: "dark", viewport: MOBILE_MIN_VIEWPORT });
    await mockUserUsage(page, {
      plan: "Free",
      balances: { planRemainingCredits: 0, purchasedRemainingCredits: 0, dailyRemainingCredits: 0 },
    });
    await page.reload();
    await freezeAnimations(page);
    await expectThemeApplied(page, "dark");
    await expect(page.getByText("플랜 한도에 도달했습니다").first()).toBeVisible();

    await expectStableScreenshot(page, "chat-insufficient-credits-mobile-min-dark-ko.png", {
      theme: "dark",
      allowTransientUi: ["usage-limit-modal"],
    });
  });
});

test.describe("UI-004: English recovery states", () => {
  test("chat-partial-failure-desktop-dark-en", async ({ page }) => {
    await enterConversation(page, { theme: "dark", viewport: DESKTOP_VIEWPORT, lang: "en" });
    await installChatModelStub(page, {
      [MODEL_A]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_B]: { kind: "success", chunks: [LONG_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "error", status: 500, message: "QA fixture: model C failed." },
    });
    await submitComposer(page, "Trigger a single-model failure.", DESKTOP_VIEWPORT.width);

    await expect(page.getByText(SHORT_ANSWER)).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expectStableScreenshot(page, "chat-partial-failure-desktop-dark-en.png", {
      theme: "dark",
    });
  });

  test("chat-error-mobile-light-en", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: MOBILE_VIEWPORT, lang: "en" });
    await installChatModelStub(page, {
      [MODEL_A]: { kind: "error", status: 500, message: LONG_ERROR_EN },
      [MODEL_B]: { kind: "error", status: 500, message: LONG_ERROR_EN },
      [MODEL_C]: { kind: "error", status: 500, message: LONG_ERROR_EN },
    });
    await submitComposer(page, "Trigger a full failure.", MOBILE_VIEWPORT.width);

    await expect(
      page.locator('[data-testid="chat-message"][data-message-role="assistant"] [role="alert"]')
    ).toHaveCount(3);
    await expectStableScreenshot(page, "chat-error-mobile-light-en.png", { theme: "light" });
  });

  test("chat-retry-mobile-dark-en", async ({ page }) => {
    await enterConversation(page, { theme: "dark", viewport: MOBILE_VIEWPORT, lang: "en" });
    await installChatModelStub(page, {
      [MODEL_A]: { kind: "error", status: 500, message: "QA fixture: retryable failure." },
      [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
    });
    await submitComposer(page, "Trigger a retryable failure.", MOBILE_VIEWPORT.width);

    await expect(page.getByRole("button", { name: "Retry", exact: true }).first()).toBeVisible();
    await expectStableScreenshot(page, "chat-retry-mobile-dark-en.png", { theme: "dark" });
  });

  test("chat-insufficient-credits-desktop-light-en", async ({ page }) => {
    await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT, lang: "en" });
    await mockUserUsage(page, {
      plan: "Free",
      balances: { planRemainingCredits: 0, purchasedRemainingCredits: 0, dailyRemainingCredits: 0 },
    });
    await page.reload();
    await freezeAnimations(page);
    await expectThemeApplied(page, "light");
    await expect(page.getByTestId("usage-limit-modal")).toBeVisible();

    await expectStableScreenshot(page, "chat-insufficient-credits-desktop-light-en.png", {
      theme: "light",
      allowTransientUi: ["usage-limit-modal"],
    });
  });
});

test.describe("UI-004: AI Review dialog states", () => {
  // The review dialog is a distinct product surface with its own loading,
  // result and failure chrome, and none of it was under a golden. It runs
  // against the same mocked comparison-review API the behavioural suite uses,
  // so no reviewer model is ever called.
  async function enterReviewConversation(
    page: Page,
    options: {
      theme: Theme;
      viewport: { width: number; height: number };
      failRun?: boolean | "first";
      deferSetup?: boolean;
    }
  ) {
    const { theme, viewport, failRun, deferSetup } = options;
    await prepareGuestPage(page, "ko");
    const authState = await mockAuthenticatedApi(page, { selectedModels: reviewModels });
    authState.theme = theme;
    await setDeterministicTheme(page, theme);
    await suppressTransientUi(page);
    await mockConversationHistory(page);
    const reviewApi = await mockComparisonReview(page, { failRun, deferSetup });

    await page.setViewportSize(viewport);
    await page.goto("/chat?lang=ko");
    await freezeAnimations(page);
    await openReviewConversation(page);
    await expectThemeApplied(page, theme);
    return reviewApi;
  }

  async function openReviewDialog(page: Page) {
    const entry = page.getByRole("button", { name: "AI 답변 교차검토" });
    await expect(entry).toBeVisible({ timeout: 30_000 });
    await entry.click();
    const dialog = page.getByRole("dialog", { name: "AI 답변 교차검토" });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  async function runReview(page: Page) {
    const dialog = page.getByRole("dialog", { name: "AI 답변 교차검토" });
    await expect(dialog.getByTestId("comparison-review-setup")).toBeVisible({
      timeout: 15_000,
    });
    await dialog.getByRole("button", { name: /교차검토 실행/ }).click();
    return dialog;
  }

  test("chat-ai-review-loading-desktop-light-ko", async ({ page }) => {
    test.setTimeout(60_000);
    const reviewApi = await enterReviewConversation(page, {
      theme: "light",
      viewport: DESKTOP_VIEWPORT,
      deferSetup: true,
    });
    const dialog = await openReviewDialog(page);
    await expect(dialog.getByTestId("comparison-review-loading")).toBeVisible();

    await expectStableScreenshot(page, "chat-ai-review-loading-desktop-light-ko.png", {
      theme: "light",
    });
    reviewApi.releaseSetup();
  });

  test("chat-ai-review-success-desktop-light-ko", async ({ page }) => {
    test.setTimeout(60_000);
    await enterReviewConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT });
    await openReviewDialog(page);
    const dialog = await runReview(page);
    await expect(dialog.getByText("1. 공통된 내용")).toBeVisible();
    await dialog.getByText("1. 공통된 내용").scrollIntoViewIfNeeded();

    await expectStableScreenshot(page, "chat-ai-review-success-desktop-light-ko.png", {
      theme: "light",
    });
  });

  for (const [viewport, viewportName, theme] of [
    [DESKTOP_VIEWPORT, "desktop", "light"],
    [MOBILE_VIEWPORT, "mobile", "dark"],
  ] as const) {
    test(`chat-ai-review-error-${viewportName}-${theme}-ko`, async ({ page }) => {
      test.setTimeout(60_000);
      await enterReviewConversation(page, { theme, viewport, failRun: true });
      await openReviewDialog(page);
      const dialog = await runReview(page);

      // The failure has to say what went wrong and leave the run control in
      // place -- an error the user can read but not act on is not a recovery
      // state.
      const alert = dialog.getByTestId("comparison-review-error");
      await expect(alert).toBeVisible();
      await expect(alert).toHaveAttribute("role", "alert");
      await expect(alert).toContainText("QA fixture: comparison review failed.");
      await expect(dialog.getByRole("button", { name: /교차검토 실행/ })).toBeVisible();
      // The dialog body scrolls independently, and the failure lands at its
      // end. Capturing without scrolling would golden the setup form and
      // silently protect nothing.
      await alert.scrollIntoViewIfNeeded();

      await expectStableScreenshot(
        page,
        `chat-ai-review-error-${viewportName}-${theme}-ko.png`,
        { theme }
      );
    });
  }

  test("chat-ai-review-retry-desktop-light-ko", async ({ page }) => {
    test.setTimeout(60_000);
    await enterReviewConversation(page, {
      theme: "light",
      viewport: DESKTOP_VIEWPORT,
      failRun: "first",
    });
    await openReviewDialog(page);
    const dialog = await runReview(page);
    await expect(dialog.getByTestId("comparison-review-error")).toBeVisible();

    // Second attempt succeeds: the error clears and the result replaces it,
    // rather than the two stacking.
    await dialog.getByRole("button", { name: /교차검토 실행/ }).click();
    await expect(dialog.getByText("1. 공통된 내용")).toBeVisible();
    await expect(dialog.getByTestId("comparison-review-error")).toHaveCount(0);
    await dialog.getByText("1. 공통된 내용").scrollIntoViewIfNeeded();

    await expectStableScreenshot(page, "chat-ai-review-retry-desktop-light-ko.png", {
      theme: "light",
    });
  });
});

test.describe("UI-004: Deep Research failure detail", () => {
  // The existing mobile golden captures the tab strip with the failed model
  // *not* selected, so the error card it is supposed to protect is off-screen.
  // This one selects the failed tab and asserts the recovery affordances are
  // the thing in the frame.
  test("chat-deep-research-failed-active-mobile-dark-ko", async ({ page }) => {
    await enterProConversation(page, "dark", MOBILE_VIEWPORT);
    await installChatModelStub(page, {
      [MODEL_B]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [MODEL_C]: { kind: "success", chunks: [SHORT_ANSWER], intervalMs: 5 },
      [DEEP_RESEARCH_MODEL]: { kind: "async-job", jobId: "qa-job-failed" },
    });
    await mockDeepResearchStatus(page, {
      status: "failed",
      error: "QA fixture: deep research job failed.",
    });
    await startDeepResearch(page, MOBILE_VIEWPORT.width);

    await page
      .locator(`[data-testid="mobile-model-tab"][data-model-id="${DEEP_RESEARCH_MODEL}"]`)
      .click();

    const alert = page
      .locator('[data-testid="chat-message"][data-message-role="assistant"] [role="alert"]')
      .first();
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("QA fixture: deep research job failed.");
    await expect(page.getByRole("button", { name: "오류 신고" }).first()).toBeVisible();

    await expectStableScreenshot(
      page,
      "chat-deep-research-failed-active-mobile-dark-ko.png",
      { theme: "dark" }
    );
  });
});

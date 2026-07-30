import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockChatStream,
  prepareGuestPage,
} from "./support/app-fixtures";
import {
  freezeAnimations,
  mockGuestUsage,
  suppressTransientUi,
} from "./support/chat-state-fixtures";

/**
 * The whole guest journey the homepage promises, driven in a browser:
 *
 *   start without an account → attach a supported local file → ask three
 *   models → read the quick difference summary → run a real AI Review →
 *   see the source grounding → be told, precisely, what happens next.
 *
 * Every other spec in this area covers one state. This one covers the path
 * between them, because that is where the promise was broken: each piece
 * worked, and a guest could still not get from the first step to the last.
 *
 * Everything below the network is mocked; nothing here reaches a provider or
 * spends a credit. What is real is the client: the same components, the same
 * capability decisions, the same endpoints.
 */

const GUEST_MODELS = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"];

type ReviewFixtureOptions = {
  /** The month's trial has already been used. */
  trialExhausted?: boolean;
  /** Fail the run once, so the retry path is exercised. */
  failFirstRun?: boolean;
};

const singleReviewResult = (confidence: "medium" | "high") => ({
  consensus: [
    {
      text: "Both answers agree the migration should be staged.",
      citations: [
        { responseId: "A", quote: "stage the migration", verified: true },
        { responseId: "B", quote: "do it in stages", verified: true },
      ],
      verified: true,
    },
  ],
  differences: [
    {
      issue: "Rollback strategy",
      positions: [
        {
          responseId: "A",
          position: "Keep a full snapshot.",
          quote: "keep a full snapshot",
          verified: true,
        },
        {
          responseId: "B",
          position: "Rely on forward fixes.",
          quote: "roll forward instead",
          verified: false,
        },
      ],
    },
  ],
  contradictions: [],
  missingPoints: ["Neither answer costs the downtime."],
  verificationNeeded: ["The vendor's published SLA needs external checking."],
  modelAssessments: [
    { responseId: "A", strengths: ["Concrete steps."], cautions: ["No costs."] },
    { responseId: "B", strengths: ["Short."], cautions: ["Thin on evidence."] },
  ],
  synthesis: "",
  confidence,
  limitations: ["This review compares the supplied answers only."],
  groundingStats: { totalCitations: 4, verifiedCitations: 3 },
});

/**
 * The guest review endpoints, answering with the shape the real ones return --
 * including the two fields that keep the result screen honest:
 * `persisted: false` and `webVerificationAvailable: false`.
 */
async function mockGuestReview(page: Page, options: ReviewFixtureOptions = {}) {
  const state = { previews: 0, runs: 0, idempotencyKeys: [] as string[] };

  await page.route("**/api/chat/comparison-review/preview", async (route) => {
    state.previews += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        guest: true,
        responses: GUEST_MODELS.map((modelId, index) => ({
          messageId: `m${index}`,
          modelId,
          modelName: modelId,
        })),
        estimatedCredits: 8,
        dualReview: true,
        reviewerClass: "Advanced",
        reviewModes: ["balanced", "evidence", "action"],
        guestTrial: options.trialExhausted
          ? { limit: 1, used: 1, remaining: 0 }
          : { limit: 1, used: 0, remaining: 1 },
        creditsAvailable: 20,
        webVerificationAvailable: false,
        persisted: false,
        disclaimer:
          "AI cross-review compares the supplied answers. It does not externally verify facts or search the web.",
      }),
    });
  });

  await page.route("**/api/chat/comparison-review", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as { idempotencyKey?: string };
    state.runs += 1;
    if (body?.idempotencyKey) state.idempotencyKeys.push(body.idempotencyKey);

    if (options.trialExhausted) {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          code: "GUEST_COMPARISON_REVIEW_MONTHLY_LIMIT",
          error: "Guests can run 1 AI review per month.",
        }),
      });
      return;
    }
    if (options.failFirstRun && state.runs === 1) {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          code: "COMPARISON_REVIEW_FAILED",
          error: "The AI review could not be completed. Reserved credits were refunded.",
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        guest: true,
        persisted: false,
        result: {
          primary: {
            reviewerModelId: "mistral-medium-3-1",
            result: singleReviewResult("medium"),
          },
          secondary: {
            reviewerModelId: "claude-sonnet-5",
            result: singleReviewResult("high"),
          },
          agreement: {
            confidenceMatches: false,
            primaryConfidence: "medium",
            secondaryConfidence: "high",
            sharedVerifiedQuoteCount: 2,
          },
        },
        responseMap: GUEST_MODELS.map((modelId, index) => ({
          responseId: ["A", "B", "C"][index],
          messageId: `m${index}`,
          modelId,
          modelName: modelId,
        })),
        reviewerModelId: "mistral-medium-3-1",
        usageCredits: 8,
        cached: false,
        webVerificationAvailable: false,
        disclaimer: "This AI review compares supplied answers and is not external fact verification.",
      }),
    });
  });

  return state;
}

async function mockGuestUpload(page: Page) {
  const uploads: Array<{ name: string; mediaType: string }> = [];
  await page.route("**/api/chat/guest-attachment**", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    const url = new URL(route.request().url());
    const name = url.searchParams.get("name") || "file.txt";
    const mediaType = url.searchParams.get("mediaType") || "text/plain";
    uploads.push({ name, mediaType });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        objectKey: `guest-attachments/${"c".repeat(32)}/${"d".repeat(40)}`,
        name,
        mediaType,
        size: 96,
        kind: "text",
        ephemeral: true,
        expiresInMinutes: 60,
      }),
    });
  });
  return uploads;
}

async function mockGuestQuickSummary(page: Page) {
  await page.route("**/api/chat/compare-summary", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        result: {
          commonConclusions: [
            { text: "All answers agree on staging the migration.", citations: [], verified: false },
          ],
          importantDifferences: [],
          modelKeyClaims: [],
          verificationNeeded: [],
        },
        responseMap: GUEST_MODELS.map((modelId, index) => ({
          responseId: ["A", "B", "C"][index],
          messageId: `m${index}`,
          modelId,
          modelName: modelId,
        })),
        reviewerModelId: "gpt-5-4-mini",
        usageCredits: 1,
      }),
    });
  });
}

type JourneyOptions = {
  viewport: { width: number; height: number };
  lang?: "en" | "ko";
  review?: ReviewFixtureOptions;
  textScalePercent?: number;
  /** The server's view of this guest's credits and AI Review trial. */
  guestUsage?: {
    creditsAvailable?: number;
    aiReviewTrial?: { limit: number; used: number; remaining: number };
  };
};

/** Everything the browser complained about while the journey ran. */
type ConsoleWatch = { errors: string[]; hydration: string[] };

function watchConsole(page: Page): ConsoleWatch {
  const watch: ConsoleWatch = { errors: [], hydration: [] };
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const text = message.text();
    // The E2E server runs without a database on purpose; its own reachability
    // noise is not what this journey is about.
    if (/Can't reach database server|guest_conversation_title_failed/.test(text)) {
      return;
    }
    if (/hydrat|did not match|server HTML/i.test(text)) watch.hydration.push(text);
    else if (message.type() === "error") watch.errors.push(text);
  });
  page.on("pageerror", (error) => watch.errors.push(String(error)));
  return watch;
}

async function startGuestJourney(page: Page, options: JourneyOptions) {
  const { viewport, lang = "en" } = options;
  await prepareGuestPage(page, "en");
  await suppressTransientUi(page);
  await mockGuestUsage(page, 0, 20, options.guestUsage ?? {});
  await mockChatStream(page, "Stage the migration and keep a full snapshot.");
  await mockGuestQuickSummary(page);
  const uploads = await mockGuestUpload(page);
  const review = await mockGuestReview(page, options.review);
  const watch = watchConsole(page);

  await page.setViewportSize(viewport);
  await page.goto(`/chat?lang=${lang}`);
  await expect(page.getByTestId("chat-textarea")).toBeVisible();
  if (options.textScalePercent) {
    await page.addStyleTag({
      content: `html { font-size: ${(16 * options.textScalePercent) / 100}px !important; }`,
    });
  }
  await freezeAnimations(page);
  return { uploads, review, watch };
}

/** Pastes a supported local file, so no OS file chooser is involved. */
async function attachGuestFile(page: Page, name = "migration-plan.txt") {
  const bytes = Array.from(
    Buffer.from("Stage the migration. Keep a full snapshot.", "utf8")
  );
  await page.getByTestId("chat-textarea").focus();
  await page.getByTestId("chat-textarea").evaluate(
    (textarea, picked) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(
        new File([new Uint8Array(picked.bytes)], picked.name, {
          type: "text/plain",
        })
      );
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        })
      );
    },
    { bytes, name }
  );
  await expect(page.getByText(name).first()).toBeVisible();
}

async function askThreeModels(page: Page, isMobile: boolean) {
  await page.getByTestId("chat-textarea").fill("How should we run this migration?");
  if (isMobile) await page.getByTestId("chat-send-button").click();
  else await page.getByTestId("chat-textarea").press("Enter");
  // The rail only exists once at least two panels have finished.
  await expect(page.getByTestId("comparison-action-rail")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("comparison-action-rail")).toHaveAttribute(
    "data-state",
    "ready"
  );
}

const runGuestReview = async (page: Page) => {
  await page.getByTestId("ai-review-button").click();
  await expect(page.getByTestId("comparison-review-setup")).toBeVisible();
  // Server-computed, never taken from the client.
  await expect(page.getByTestId("ai-review-estimated-credits")).toContainText("8");
  await page.getByRole("button", { name: /Run cross-review|교차 검토 실행/ }).click();
};

const SHELLS = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, isMobile: false },
  { name: "mobile-390", viewport: { width: 390, height: 780 }, isMobile: true },
  { name: "mobile-320", viewport: { width: 320, height: 640 }, isMobile: true },
] as const;

test.describe("guest journey: attach a file, compare, review", () => {
  test.use({ hasTouch: true });

  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Driven at explicit viewports on one engine; run with --project=desktop-chromium."
    );
  });

  for (const shell of SHELLS) {
    test(`${shell.name}: a guest attaches a file and gets a real AI Review`, async ({
      page,
    }) => {
      const { uploads, review, watch } = await startGuestJourney(page, {
        viewport: shell.viewport,
      });

      // 1. A local file, actually attached -- no account, no lock.
      await attachGuestFile(page);
      expect(uploads).toHaveLength(1);
      expect(uploads[0].mediaType).toBe("text/plain");
      await expectNoHorizontalOverflow(page);

      // 2. The question goes to three models.
      await askThreeModels(page, shell.isMobile);

      // 3. The quick summary a guest already had still works.
      await page.getByTestId("quick-comparison-button").click();
      await expect(page.getByTestId("quick-comparison-dialog")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("quick-summary-consensus")).toBeVisible();
      // Close it so the rail is clickable again for the review below.
      await page
        .getByTestId("quick-comparison-dialog")
        .getByRole("button", { name: /Cancel|취소|Close|닫기/ })
        .first()
        .click();
      await expect(page.getByTestId("quick-comparison-dialog")).toHaveCount(0);

      // 4. The AI Review runs for real.
      await runGuestReview(page);
      await expect(page.getByTestId("ai-review-result")).toBeVisible({
        timeout: 15_000,
      });
      expect(review.runs).toBe(1);
      // One idempotency key per user-initiated run, so a retry cannot double-charge.
      expect(review.idempotencyKeys[0]).toBeTruthy();

      // 5. Source grounding is on the guest result, not just the account one.
      await expect(page.getByTestId("ai-review-source-grounding")).toBeVisible();
      // Both independent reviewers came back, with their agreement.
      await expect(
        page.getByRole("tab", { name: /Reviewer 2|검토자 2/ })
      ).toBeVisible();

      // 6. And the result does not pretend to be something it is not.
      await expect(page.getByTestId("ai-review-guest-not-saved")).toBeVisible();
      await expect(page.getByTestId("ai-review-verify-guest-locked")).toBeVisible();

      await expectNoHorizontalOverflow(page);
      expect(watch.hydration, "hydration warnings").toEqual([]);
      expect(watch.errors, "console errors").toEqual([]);
    });
  }

  test("desktop: a used-up trial explains itself and offers the way forward", async ({
    page,
  }) => {
    // The trial is spent before this session starts, which is the state a
    // returning guest actually arrives in.
    const { watch } = await startGuestJourney(page, {
      viewport: { width: 1440, height: 900 },
      guestUsage: { aiReviewTrial: { limit: 1, used: 1, remaining: 0 } },
    });
    await askThreeModels(page, false);

    const button = page.getByTestId("ai-review-button");
    await expect(button).toHaveAttribute("data-access", "guestTrialExhausted");
    await expect(button).toHaveAttribute("aria-disabled", "true");
    // Visible, not hidden behind a tooltip or a title attribute.
    await expect(page.getByTestId("comparison-action-rail-status")).toContainText(
      "trial"
    );
    // The quick summary is a different action with a different allowance, and
    // must not be blocked alongside it.
    await expect(page.getByTestId("quick-comparison-button")).toHaveAttribute(
      "aria-disabled",
      "false"
    );
    // ...and the blocked action leads somewhere: the sign-in prompt, not a
    // dead tap.
    // `aria-disabled`, not `disabled`: the control stays focusable and
    // clickable precisely so this way out exists, which is why the click is
    // forced past Playwright's enabled-ness heuristic rather than skipped.
    await button.click({ force: true });
    await expect(page.locator("#guest-compare-signin-title")).toBeVisible();

    expect(watch.hydration).toEqual([]);
    expect(watch.errors).toEqual([]);
  });

  test("desktop: a failed run can be retried, with a new idempotency key", async ({
    page,
  }) => {
    const { review } = await startGuestJourney(page, {
      viewport: { width: 1440, height: 900 },
      review: { failFirstRun: true },
    });
    await askThreeModels(page, false);
    await runGuestReview(page);

    // The failure is announced, not buried.
    await expect(page.getByTestId("comparison-review-error")).toBeVisible();
    await expect(page.getByTestId("comparison-review-error")).toContainText(
      /refunded/i
    );

    // Retrying is a real second attempt, under a different key -- a repeated
    // key would be refused as a duplicate rather than run.
    await page.getByRole("button", { name: /Run cross-review|교차 검토 실행/ }).click();
    await expect(page.getByTestId("ai-review-result")).toBeVisible({
      timeout: 15_000,
    });
    expect(review.runs).toBe(2);
    expect(review.idempotencyKeys[0]).not.toBe(review.idempotencyKeys[1]);
  });

  test("mobile 320px at 200% text scaling keeps the whole flow usable", async ({
    page,
  }) => {
    const { watch } = await startGuestJourney(page, {
      viewport: { width: 320, height: 640 },
      lang: "ko",
      textScalePercent: 200,
    });

    await attachGuestFile(page, "매우-긴-한국어-파일이름-분기별-실적-보고서-최종.txt");
    await expectNoHorizontalOverflow(page);

    // The composer's own contract, at the hardest combination the product
    // supports: narrowest viewport, largest text, longest filename.
    const geometry = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>(
        '[data-testid="chat-input"]'
      )!;
      const textarea = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="chat-textarea"]'
      )!;
      const composerRect = composer.getBoundingClientRect();
      const textareaRect = textarea.getBoundingClientRect();
      const style = getComputedStyle(composer);
      const innerWidth =
        composerRect.width -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      return {
        widthRatio: textareaRect.width / innerWidth,
        overflow: composer.scrollWidth - composer.clientWidth,
      };
    });
    expect(geometry.widthRatio).toBeGreaterThanOrEqual(0.9);
    expect(geometry.overflow).toBeLessThanOrEqual(1);

    expect(watch.hydration).toEqual([]);
    expect(watch.errors).toEqual([]);
  });
});

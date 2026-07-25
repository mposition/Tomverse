import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
  type QaLanguage,
} from "./support/app-fixtures";

// STG-F007: the reviewer's exact-quote-match rate used to be labelled
// "Confidence" / "신뢰도", which reads as "how sure the model is that this is
// true". These tests pin the corrected framing: a scoped, explained grounding
// metric that never claims fact-checking, source quality, or model certainty.

const reviewModels = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"];

const responseMap = [
  {
    responseId: "A",
    messageId: "21111111-1111-4111-8111-111111111111",
    modelId: reviewModels[0],
    modelName: "GPT-5.4 mini",
  },
  {
    responseId: "B",
    messageId: "31111111-1111-4111-8111-111111111111",
    modelId: reviewModels[1],
    modelName: "Claude Haiku 4.5",
  },
  {
    responseId: "C",
    messageId: "41111111-1111-4111-8111-111111111111",
    modelId: reviewModels[2],
    modelName: "Gemini 3.1 Flash-Lite",
  },
];

type GroundingOptions = {
  confidence?: "low" | "medium" | "high";
  groundingStats?: { totalCitations: number; verifiedCitations: number };
  citationVerified?: boolean;
};

function singleReviewResult({
  confidence = "medium",
  groundingStats = { totalCitations: 5, verifiedCitations: 4 },
  citationVerified = true,
}: GroundingOptions) {
  return {
    consensus:
      groundingStats.totalCitations > 0
        ? [
            {
              text: "세 답변 모두 단계적 검토가 필요하다는 데 동의합니다.",
              citations: [
                {
                  responseId: "A",
                  quote: "단계적으로 접근해야 합니다.",
                  verified: citationVerified,
                },
              ],
              verified: citationVerified,
            },
          ]
        : [
            {
              // A claim the reviewer made without quoting anything: nothing to
              // match, so there is no rate to report.
              text: "인용 없이 제시된 요약입니다.",
              citations: [],
              verified: false,
            },
          ],
    differences: [],
    contradictions: [],
    missingPoints: [],
    verificationNeeded: ["공급자별 가격은 외부 확인이 필요합니다."],
    modelAssessments: responseMap.map((response) => ({
      responseId: response.responseId,
      strengths: [],
      cautions: [],
    })),
    synthesis: "",
    confidence,
    limitations: ["이 검토는 외부 사실 검증이 아닙니다."],
    groundingStats,
  };
}

async function mockComparisonReview(page: Page, options: GroundingOptions = {}) {
  await page.route(
    "**/api/conversations/qa-conversation/comparison-reviews",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            promptMessageId: "11111111-1111-4111-8111-111111111111",
            assistantMessageIds: responseMap.map((item) => item.messageId),
            responses: responseMap.map((item) => ({
              messageId: item.messageId,
              modelId: item.modelId,
              modelName: item.modelName,
            })),
            estimatedCredits: 4,
            reviewerClass: "Advanced",
            freeMonthlyReviews: 3,
            disclaimer:
              "This compares only supplied answers and does not externally verify facts.",
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "review-1",
          result: {
            primary: {
              reviewerModelId: "mistral-medium-3-1",
              result: singleReviewResult(options),
            },
            secondary: null,
            agreement: null,
          },
          responseMap,
          reviewerModelId: "mistral-medium-3-1",
          usageCredits: 4,
          cached: false,
          disclaimer: "This review is not external fact verification.",
        }),
      });
    }
  );
}

async function mockQuickComparison(page: Page) {
  await page.route(
    "**/api/conversations/qa-conversation/compare-summary",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            title: "QA conversation",
            responseCount: 3,
            estimatedCredits: 1,
            cached: false,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "quick-review-1",
          title: "QA conversation",
          result: {
            commonConclusions: [
              {
                text: "All answers recommend a staged rollout.",
                citations: [
                  {
                    responseId: "A",
                    quote: "we recommend a staged rollout",
                    verified: true,
                  },
                ],
                verified: true,
              },
            ],
            importantDifferences: [],
            modelKeyClaims: [
              {
                responseId: "B",
                claims: [
                  {
                    claim: "Validate usability before launch.",
                    quote: "validate usability first",
                    verified: true,
                  },
                ],
              },
            ],
            verificationNeeded: [],
            confidence: "high",
            groundingStats: { totalCitations: 2, verifiedCitations: 2 },
          },
          responseMap,
          reviewerModelId: "gpt-5-4-mini",
          usageCredits: 1,
          cached: false,
        }),
      });
    }
  );
}

async function mockConversationHistory(page: Page) {
  const assistantMessageByModel: Record<string, { id: string; content: string }> =
    Object.fromEntries(
      responseMap.map((item) => [
        item.modelId,
        { id: item.messageId, content: `${item.modelName} answer` },
      ])
    );
  await page.route(
    /.*\/api\/conversations\/qa-conversation(\?.*)?$/,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const modelId = new URL(route.request().url()).searchParams.get("modelId");
      const assistantMessage = modelId ? assistantMessageByModel[modelId] : undefined;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "qa-conversation",
          title: "QA conversation",
          selectedModels: reviewModels,
          disabledPanels: [],
          messages: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              role: "user",
              content: "Compare these approaches",
              modelId: null,
            },
            ...(assistantMessage
              ? [
                  {
                    id: assistantMessage.id,
                    role: "assistant",
                    content: assistantMessage.content,
                    modelId,
                    status: "normal",
                  },
                ]
              : []),
          ],
          messagePage: { hasMore: false, nextCursor: null },
        }),
      });
    }
  );
}

async function openReviewConversation(page: Page) {
  await page.getByTestId("recent-conversation-card").click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
}

// The authenticated fixture pins the account language to Korean, so the UI
// checks below run in Korean; the per-locale wording is pinned in
// tests/sourceGroundingCopy.test.mjs instead.
async function openReviewResult(page: Page, options: GroundingOptions = {}) {
  const language: QaLanguage = "ko";
  const grounding = options;
  await prepareGuestPage(page, language);
  await mockAuthenticatedApi(page, { selectedModels: reviewModels });
  await mockConversationHistory(page);
  await mockComparisonReview(page, grounding);
  await page.goto("/chat");
  await openReviewConversation(page);

  await page
    .getByRole("button", {
      name: language === "ko" ? "AI 답변 교차검토" : "AI answer cross-review",
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: language === "ko" ? "AI 답변 교차검토" : "AI answer cross-review",
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: language === "ko" ? /교차검토 실행/ : /Run cross-review/ })
    .click();
  await expect(dialog.getByTestId("ai-review-source-grounding")).toBeVisible();
  return dialog;
}

/** The description is wired to the value by id, wherever it lives in the DOM. */
async function describedByText(page: Page, value: Locator) {
  const describedBy = await value.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  return page.locator(`[id="${describedBy}"]`);
}

test("the review metric is labelled as source grounding, never as confidence", async ({
  page,
}) => {
  const dialog = await openReviewResult(page);

  const value = dialog.getByTestId("ai-review-source-grounding-value");
  await expect(value).toContainText("전체 출처 일치도");
  await expect(value).toContainText("80%");
  await expect(value).toContainText("인용구 4/5 일치");

  // The old label and its translation are gone from the whole surface.
  await expect(dialog.getByText("신뢰도")).toHaveCount(0);
  await expect(dialog.getByText(/confidence/i)).toHaveCount(0);
  // A bare percentage with no label would invite the same misreading.
  await expect(value).not.toHaveText(/^\s*80%\s*$/);
});

test("the metric is scoped to the whole review rather than to one section", async ({
  page,
}) => {
  const dialog = await openReviewResult(page);

  const value = dialog.getByTestId("ai-review-source-grounding-value");
  await expect(value).toContainText("전체");

  const description = await describedByText(
    page,
    dialog.getByTestId("ai-review-source-grounding-value")
  );
  await expect(description).toContainText("모든 인용구를 합산한 값");
});

test("the explanation opens on hover and rules out the three misreadings", async ({
  page,
}) => {
  const dialog = await openReviewResult(page);
  const badge = dialog.getByTestId("ai-review-source-grounding");

  await expect(page.getByTestId("ai-review-source-grounding-popover")).toHaveCount(0);
  await badge.hover();
  const popover = page.getByTestId("ai-review-source-grounding-popover");
  await expect(popover).toBeVisible();

  await expect(popover).toContainText("직접 일치하는 정도");
  await expect(popover).toContainText("사실 정확도");
  await expect(popover).toContainText("출처의 신뢰성");
  await expect(popover).toContainText("모델의 확신");
});

test("the explanation is reachable by keyboard and dismissed with Escape", async ({
  page,
}) => {
  const dialog = await openReviewResult(page);
  const info = dialog.getByTestId("ai-review-source-grounding-info");
  const popover = page.getByTestId("ai-review-source-grounding-popover");

  await info.focus();
  await expect(popover).toBeVisible();
  await expect(info).toHaveAttribute("aria-expanded", "true");

  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(info).toHaveAttribute("aria-expanded", "false");
  await expect(info).toBeFocused();
  // Escape closed the explanation only -- the review itself stays open.
  await expect(dialog).toBeVisible();

  // Focus stayed put, so the control can be reopened from the keyboard.
  await page.keyboard.press("Enter");
  await expect(popover).toBeVisible();

  // Moving focus away also closes it.
  await dialog.getByRole("button", { name: "닫기" }).focus();
  await expect(popover).toHaveCount(0);
});

test("a screen reader can reach the description from the value itself", async ({
  page,
}) => {
  const dialog = await openReviewResult(page);
  const value = dialog.getByTestId("ai-review-source-grounding-value");

  // Label and value are one string, so they are announced together.
  await expect(value).toHaveText(/전체 출처 일치도: .*80%/);

  // The description resolves whether or not the bubble is open.
  const description = await describedByText(page, value);
  await expect(description).toContainText("사실 정확도");
  await expect(description).toContainText("모델의 확신");

  const info = dialog.getByTestId("ai-review-source-grounding-info");
  await expect(info).toHaveAttribute("aria-label", "출처 일치도 설명 보기");
  const controls = await info.getAttribute("aria-controls");
  expect(controls).toBeTruthy();
});

test.describe("on the narrowest supported touch screen", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true });

  test("the info control keeps a 44px target and the bubble stays on screen", async ({
    page,
  }) => {
    const dialog = await openReviewResult(page);
    const info = dialog.getByTestId("ai-review-source-grounding-info");

    // The visible circle is badge-sized; the ::after box is the real target.
    const hitArea = await info.evaluate((element) => {
      const styles = getComputedStyle(element, "::after");
      return {
        width: Number.parseFloat(styles.width),
        height: Number.parseFloat(styles.height),
      };
    });
    expect(hitArea.width).toBeGreaterThanOrEqual(44);
    expect(hitArea.height).toBeGreaterThanOrEqual(44);

    await info.tap();
    const popover = page.getByTestId("ai-review-source-grounding-popover");
    await expect(popover).toBeVisible();

    const box = await popover.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(box!.y + box!.height).toBeLessThanOrEqual(640);
    await expectNoHorizontalOverflow(page);

    // Tapping again dismisses it, so the bubble cannot sit over the controls.
    await info.tap();
    await expect(popover).toHaveCount(0);
  });
});

test("an unquoted review reports no measurement instead of 0%", async ({ page }) => {
  const dialog = await openReviewResult(page, {
    confidence: "medium",
    groundingStats: { totalCitations: 0, verifiedCitations: 0 },
  });

  const value = dialog.getByTestId("ai-review-source-grounding-value");
  await expect(value).toHaveText("전체 출처 일치도: 측정 불가");
  await expect(value).not.toContainText("0%");
  await expect(value).not.toContainText("보통");
});

test("a fully matched review still promises nothing about accuracy", async ({
  page,
}) => {
  const dialog = await openReviewResult(page, {
    confidence: "high",
    groundingStats: { totalCitations: 3, verifiedCitations: 3 },
  });

  const badge = dialog.getByTestId("ai-review-source-grounding");
  const value = badge.getByTestId("ai-review-source-grounding-value");
  await expect(value).toContainText("100%");
  // A full match is still only a quote match: no verdict wording anywhere on
  // the metric itself.
  await expect(value).not.toContainText("검증됨");
  await expect(value).not.toContainText("정확");
  await expect(value).not.toContainText("신뢰할 수 있");

  // Neutral chrome: the metric never encodes success, warning or error in
  // colour, at any value.
  const badgeClass = (await badge.getAttribute("class")) || "";
  expect(badgeClass).not.toMatch(
    /(emerald|green|lime|red|rose|amber|orange|yellow)-\d/
  );
});

test("the quick summary reports the metric for the summary, not for one section", async ({
  page,
}) => {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: reviewModels });
  await mockConversationHistory(page);
  await mockQuickComparison(page);
  await page.goto("/chat");
  await openReviewConversation(page);

  await page.getByTestId("quick-comparison-button").click();
  const dialog = page.getByTestId("quick-comparison-dialog");
  await expect(dialog).toBeVisible();

  const value = dialog.getByTestId("quick-summary-source-grounding-value");
  await expect(value).toContainText("전체 출처 일치도");
  await expect(value).toContainText("100%");
  await expect(value).toContainText("인용구 2/2 일치");

  // It counts quotes from every section, so it no longer sits inside the
  // consensus card where it looked like a per-section score.
  await expect(
    dialog.getByTestId("quick-summary-consensus").getByTestId(
      "quick-summary-source-grounding"
    )
  ).toHaveCount(0);
  await expect(dialog.getByText("신뢰도")).toHaveCount(0);

  const description = await describedByText(page, value);
  await expect(description).toContainText("사실 정확도");
});

import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";
import {
  mockComparisonReview,
  mockConversationHistory,
  openReviewConversation,
  reviewModels,
} from "./support/comparison-review-fixtures";

async function mockQuickComparison(page: Page) {
  let requestMethod: string | null = null;
  await page.route(
    "**/api/conversations/qa-conversation/compare-summary",
    async (route) => {
      requestMethod = route.request().method();
      if (requestMethod === "GET") {
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
                  { responseId: "A", quote: "we recommend a staged rollout", verified: true },
                  { responseId: "B", quote: "a staged rollout is safest", verified: true },
                ],
                verified: true,
              },
            ],
            importantDifferences: [
              {
                text: "The answers prioritize security, usability, and cost differently.",
                citations: [
                  { responseId: "A", quote: "security should come first", verified: true },
                ],
                verified: true,
              },
              {
                text: "Only one answer defines a measurable success threshold.",
                citations: [
                  { responseId: "C", quote: "a measurable success threshold", verified: true },
                ],
                verified: true,
              },
            ],
            modelKeyClaims: [
              {
                responseId: "A",
                claims: [
                  { claim: "Start with a security review.", quote: "start with a security review", verified: true },
                ],
              },
              {
                responseId: "B",
                claims: [
                  { claim: "Validate usability before launch.", quote: "validate usability first", verified: true },
                ],
              },
              {
                responseId: "C",
                claims: [
                  { claim: "Track cost and latency together.", quote: "track cost and latency", verified: true },
                ],
              },
            ],
            verificationNeeded: [
              "Confirm current provider pricing in an external source.",
            ],
            confidence: "high",
            groundingStats: { totalCitations: 5, verifiedCitations: 5 },
          },
          responseMap: [
            {
              responseId: "A",
              messageId: "answer-a",
              modelId: reviewModels[0],
              modelName: "GPT-5.4 mini",
            },
            {
              responseId: "B",
              messageId: "answer-b",
              modelId: reviewModels[1],
              modelName: "Claude Haiku 4.5",
            },
            {
              responseId: "C",
              messageId: "answer-c",
              modelId: reviewModels[2],
              modelName: "Gemini 3.5 Flash-Lite",
            },
          ],
          reviewerModelId: "gpt-5-4-mini",
          usageCredits: 1,
          cached: false,
        }),
      });
    }
  );
  return { getRequestMethod: () => requestMethod };
}

test("AI comparison review does not flash an unavailable setup before loading", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: reviewModels });
  await mockConversationHistory(page);
  const reviewApi = await mockComparisonReview(page, { deferSetup: true });
  await page.goto("/chat");
  await openReviewConversation(page);

  const reviewButton = page.getByRole("button", { name: "AI 답변 교차검토" });
  await expect(reviewButton).toBeVisible({ timeout: 30_000 });
  // The entry badge is the rail's own approximate figure, and it says 8
  // because a review runs two reviewers. The dialog below quotes the server's
  // exact price for the chosen setup, which is why the two numbers are
  // asserted separately rather than shared.
  await expect(reviewButton.getByTestId("ai-review-entry-credit-cost")).toContainText("8");
  await expect(reviewButton.getByTestId("credit-coin-icon")).toBeVisible();
  await reviewButton.click();
  const dialog = page.getByRole("dialog", { name: "AI 답변 교차검토" });
  await expect(dialog.getByTestId("comparison-review-loading")).toBeVisible();
  await expect(dialog.getByTestId("comparison-review-setup")).toHaveCount(0);
  reviewApi.releaseSetup();
  await expect(dialog.getByTestId("comparison-review-setup")).toBeVisible({
    timeout: 15_000,
  });
  await expect(dialog.getByTestId("comparison-review-loading")).toHaveCount(0);
});

for (const viewport of [
  { name: "desktop", width: 1366, height: 720 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`AI comparison review is usable and scrollable on ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page, { selectedModels: reviewModels });
    await mockConversationHistory(page);
    const reviewApi = await mockComparisonReview(page);
    await page.goto("/chat");
    await openReviewConversation(page);

    const reviewEntryButton = page.getByRole("button", { name: "AI 답변 교차검토" });
    await expect(reviewEntryButton.getByTestId("ai-review-entry-credit-cost")).toContainText("8");
    await reviewEntryButton.click();
    const dialog = page.getByRole("dialog", { name: "AI 답변 교차검토" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("ai-review-estimated-credits")).toContainText("4");
    await expect(dialog.getByTestId("ai-review-estimated-credits").getByTestId("credit-coin-icon")).toBeVisible();
    await dialog.getByRole("button", { name: /근거 중심/ }).click();
    await dialog.getByText("신중한 종합안 포함").click();
    await dialog.getByRole("button", { name: /교차검토 실행/ }).click();

    await expect(dialog.getByText("1. 공통된 내용")).toBeVisible();
    await expect(dialog.getByText("2. 중요한 차이")).toBeVisible();
    await expect(dialog.getByText("GPT-5.4 mini").last()).toBeVisible();
    await expect(dialog.getByText("검토 한계")).toBeVisible();
    expect(reviewApi.getRequestBody()).toMatchObject({
      reviewMode: "evidence",
      includeSynthesis: true,
    });

    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThanOrEqual(viewport.height);
    await expectNoHorizontalOverflow(page);
  });
}

test("AI comparison review with two reviewers shows a tab switcher and agreement summary", { tag: ["@smoke", "@review-parity"] }, async ({
  page,
}) => {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: reviewModels });
  await mockConversationHistory(page);
  await mockComparisonReview(page, { withSecondary: true });
  await page.goto("/chat");
  await openReviewConversation(page);

  await page.getByRole("button", { name: "AI 답변 교차검토" }).click();
  const dialog = page.getByRole("dialog", { name: "AI 답변 교차검토" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /교차검토 실행/ }).click();

  const primaryTab = dialog.getByRole("tab", { name: /검토자 1/ });
  const secondaryTab = dialog.getByRole("tab", { name: /검토자 2/ });
  await expect(primaryTab).toBeVisible();
  await expect(secondaryTab).toBeVisible();
  await expect(primaryTab).toHaveAttribute("aria-selected", "true");
  // The reviewers are compared on source grounding -- the share of their
  // quotes that matched the answers -- not on any self-reported confidence.
  await expect(
    dialog.getByText("두 검토자의 출처 일치도가 다릅니다 (보통 vs 높음)")
  ).toBeVisible();

  // Primary tab shows the first reviewer's content (from the base mock).
  await expect(dialog.getByText("1. 공통된 내용")).toBeVisible();

  await secondaryTab.click();
  await expect(secondaryTab).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByText("두 검토자 모두 단계적 접근에 동의합니다.")).toBeVisible();
  await expect(dialog.getByText("보안 정책 문서는 별도 확인이 필요합니다.")).toBeVisible();
});

test("a verificationNeeded item can be checked with a separate, per-item web search", async ({
  page,
}) => {
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: reviewModels });
  await mockConversationHistory(page);
  await mockComparisonReview(page);
  let verifyRequestBody: Record<string, unknown> | null = null;
  await page.route(
    "**/api/conversations/qa-conversation/comparison-reviews/verify-item",
    async (route) => {
      verifyRequestBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "unsupported",
          summary: "최근 공급자 발표에 따르면 가격이 인상되었습니다.",
          reviewerModelId: "perplexity/sonar",
          usageCredits: 1,
          disclaimer: "This is a best-effort web check, not a guarantee.",
        }),
      });
    }
  );
  await page.goto("/chat");
  await openReviewConversation(page);

  await page.getByRole("button", { name: "AI 답변 교차검토" }).click();
  const dialog = page.getByRole("dialog", { name: "AI 답변 교차검토" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /교차검토 실행/ }).click();

  await expect(dialog.getByText("공급자별 가격은 외부 확인이 필요합니다.")).toBeVisible();
  await dialog.getByRole("button", { name: "웹으로 확인" }).click();

  await expect(dialog.getByText("반박됨:")).toBeVisible();
  await expect(dialog.getByText("최근 공급자 발표에 따르면 가격이 인상되었습니다.")).toBeVisible();
  expect(verifyRequestBody).toMatchObject({
    item: "공급자별 가격은 외부 확인이 필요합니다.",
  });
});

test("quick comparison performs a structured AI analysis on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: reviewModels });
  await mockConversationHistory(page);
  const quickApi = await mockQuickComparison(page);
  await page.goto("/chat");
  await openReviewConversation(page);

  const quickButton = page.getByTestId("quick-comparison-button");
  await expect(quickButton.getByTestId("quick-comparison-credit-cost")).toContainText("1");
  await expect(quickButton.getByTestId("credit-coin-icon")).toBeVisible();
  await quickButton.click();
  await expect(page.getByTestId("quick-comparison-setup")).toHaveCount(0);
  const dialog = page.getByTestId("quick-comparison-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("quick-summary-consensus")).toContainText(
    "staged rollout"
  );
  await expect(dialog.getByTestId("quick-summary-differences")).toContainText(
    "success threshold"
  );
  await expect(dialog.getByTestId("quick-summary-model-claims")).toContainText(
    "Claude Haiku 4.5"
  );
  await expect(dialog.getByTestId("quick-summary-verification")).toContainText(
    "provider pricing"
  );
  expect(quickApi.getRequestMethod()).toBe("POST");

  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThanOrEqual(844);
  await expectNoHorizontalOverflow(page);
});

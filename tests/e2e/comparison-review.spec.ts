import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";

const reviewModels = [
  "gpt-5-4-mini",
  "claude-haiku-4-5",
  "gemini-2-5-flash",
];

async function mockComparisonReview(
  page: Page,
  options: { deferSetup?: boolean } = {}
) {
  let requestBody: Record<string, unknown> | null = null;
  let releaseSetup = () => {};
  const setupGate = options.deferSetup
    ? new Promise<void>((resolve) => {
        releaseSetup = resolve;
      })
    : Promise.resolve();
  await page.route(
    "**/api/conversations/qa-conversation/comparison-reviews",
    async (route) => {
      if (route.request().method() === "GET") {
        await setupGate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            available: true,
            promptMessageId: "11111111-1111-4111-8111-111111111111",
            assistantMessageIds: [
              "21111111-1111-4111-8111-111111111111",
              "31111111-1111-4111-8111-111111111111",
              "41111111-1111-4111-8111-111111111111",
            ],
            responses: [
              {
                messageId: "21111111-1111-4111-8111-111111111111",
                modelId: reviewModels[0],
                modelName: "GPT-5.4 mini",
              },
              {
                messageId: "31111111-1111-4111-8111-111111111111",
                modelId: reviewModels[1],
                modelName: "Claude Haiku 4.5",
              },
              {
                messageId: "41111111-1111-4111-8111-111111111111",
                modelId: reviewModels[2],
                modelName: "Gemini 3.1 Flash-Lite",
              },
            ],
            estimatedCredits: 4,
            reviewerClass: "Advanced",
            freeMonthlyReviews: 3,
            disclaimer:
              "This compares only supplied answers and does not externally verify facts.",
          }),
        });
        return;
      }

      requestBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "review-1",
          result: {
            consensus: ["세 답변 모두 단계적 검토가 필요하다는 데 동의합니다."],
            differences: [
              {
                issue: "우선순위",
                positions: [
                  { responseId: "A", position: "보안을 먼저 점검합니다." },
                  { responseId: "B", position: "사용성을 먼저 확인합니다." },
                  { responseId: "C", position: "비용과 속도를 함께 봅니다." },
                ],
              },
            ],
            contradictions: ["배포 순서에 대한 권고가 서로 다릅니다."],
            missingPoints: ["실제 운영 지표가 제공되지 않았습니다."],
            verificationNeeded: ["공급자별 가격은 외부 확인이 필요합니다."],
            modelAssessments: [
              {
                responseId: "A",
                strengths: ["구조가 명확합니다."],
                cautions: ["근거 링크가 없습니다."],
              },
              {
                responseId: "B",
                strengths: ["실행 단계가 구체적입니다."],
                cautions: ["비용 설명이 부족합니다."],
              },
              {
                responseId: "C",
                strengths: ["장단점을 함께 다룹니다."],
                cautions: ["일부 가정이 있습니다."],
              },
            ],
            synthesis: "공통된 안전 조치를 먼저 적용한 뒤 운영 지표로 우선순위를 조정합니다.",
            confidence: "medium",
            limitations: ["이 검토는 외부 사실 검증이 아닙니다."],
          },
          responseMap: [
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
          ],
          reviewerModelId: "mistral-medium-3-1",
          usageCredits: 4,
          cached: false,
          disclaimer: "This review is not external fact verification.",
        }),
      });
    }
  );
  return {
    getRequestBody: () => requestBody,
    releaseSetup,
  };
}

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
            commonConclusions: ["All answers recommend a staged rollout."],
            importantDifferences: [
              "The answers prioritize security, usability, and cost differently.",
              "Only one answer defines a measurable success threshold.",
            ],
            modelKeyClaims: [
              { responseId: "A", claims: ["Start with a security review."] },
              { responseId: "B", claims: ["Validate usability before launch."] },
              { responseId: "C", claims: ["Track cost and latency together."] },
            ],
            verificationNeeded: [
              "Confirm current provider pricing in an external source.",
            ],
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
              modelName: "Gemini 3.1 Flash-Lite",
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
  const reviewApi = await mockComparisonReview(page, { deferSetup: true });
  await page.goto("/chat");

  const reviewButton = page.getByRole("button", { name: "AI 답변 교차검토" });
  await expect(reviewButton).toBeVisible({ timeout: 30_000 });
  await expect(reviewButton.getByTestId("ai-review-entry-credit-cost")).toContainText("4");
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
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`AI comparison review is usable and scrollable on ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await prepareGuestPage(page, "ko");
    await mockAuthenticatedApi(page, { selectedModels: reviewModels });
    const reviewApi = await mockComparisonReview(page);
    await page.goto("/chat");

    const reviewEntryButton = page.getByRole("button", { name: "AI 답변 교차검토" });
    await expect(reviewEntryButton.getByTestId("ai-review-entry-credit-cost")).toContainText("4");
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

test("quick comparison performs a structured AI analysis on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareGuestPage(page, "ko");
  await mockAuthenticatedApi(page, { selectedModels: reviewModels });
  const quickApi = await mockQuickComparison(page);
  await page.goto("/chat");

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

import { expect, type Page } from "@playwright/test";
import { openRecentConversation } from "./app-fixtures";
import {
  comparisonReviewItems,
  type ComparisonReviewItemSource,
} from "@/lib/comparisonReviewItemFeedback";

/**
 * Fixtures for the AI comparison review dialog, shared by the behavioural
 * suite (comparison-review.spec.ts) and the golden suite so both drive the
 * real ComparisonReviewDialog through the real API surface, with no provider
 * call, credit spend or database write.
 */

export const reviewModels = [
  "gpt-5-4-mini",
  "claude-haiku-4-5",
  // The stable Tomverse catalog id is intentionally preserved even though the
  // provider-facing API model has advanced to Gemini 3.5 Flash-Lite.
  "gemini-2-5-flash",
];

export async function mockComparisonReview(
  page: Page,
  options: {
    deferSetup?: boolean;
    withSecondary?: boolean;
    /**
     * Makes the review request itself fail. The setup step still succeeds, so
     * the dialog reaches the state a user actually hits: they chose a mode,
     * spent the click, and the run came back with an error they have to
     * recover from.
     */
    failRun?: boolean | "first";
  } = {}
) {
  let requestBody: Record<string, unknown> | null = null;
  let runCount = 0;
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
                modelName: "Gemini 3.5 Flash-Lite",
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
      runCount += 1;
      if (options.failRun === true || (options.failRun === "first" && runCount === 1)) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "QA fixture: comparison review failed." }),
        });
        return;
      }
      const result = {
            primary: {
              reviewerModelId: "mistral-medium-3-1",
              result: {
                consensus: [
                  {
                    text: "세 답변 모두 단계적 검토가 필요하다는 데 동의합니다.",
                    citations: [
                      { responseId: "A", quote: "단계적으로 접근해야 합니다.", verified: true },
                      { responseId: "B", quote: "단계별 검토가 필요합니다.", verified: true },
                    ],
                    verified: true,
                  },
                ],
                differences: [
                  {
                    issue: "우선순위",
                    positions: [
                      {
                        responseId: "A",
                        position: "보안을 먼저 점검합니다.",
                        quote: "보안 점검을 최우선으로 합니다.",
                        verified: true,
                      },
                      {
                        responseId: "B",
                        position: "사용성을 먼저 확인합니다.",
                        quote: "사용성을 먼저 확인해야 합니다.",
                        verified: true,
                      },
                      {
                        responseId: "C",
                        position: "비용과 속도를 함께 봅니다.",
                        quote: "비용과 속도를 함께 고려합니다.",
                        verified: false,
                      },
                    ],
                  },
                ],
                contradictions: [
                  {
                    text: "배포 순서에 대한 권고가 서로 다릅니다.",
                    citations: [
                      { responseId: "A", quote: "먼저 배포부터 진행합니다.", verified: true },
                    ],
                    verified: true,
                  },
                ],
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
                groundingStats: { totalCitations: 5, verifiedCitations: 4 },
              },
            },
            secondary: options.withSecondary
              ? {
                  reviewerModelId: "claude-sonnet-5",
                  result: {
                    consensus: [
                      {
                        text: "두 검토자 모두 단계적 접근에 동의합니다.",
                        citations: [
                          { responseId: "A", quote: "단계적으로 접근해야 합니다.", verified: true },
                        ],
                        verified: true,
                      },
                    ],
                    differences: [],
                    contradictions: [],
                    missingPoints: [],
                    verificationNeeded: ["보안 정책 문서는 별도 확인이 필요합니다."],
                    modelAssessments: [
                      { responseId: "A", strengths: ["명확합니다."], cautions: [] },
                      { responseId: "B", strengths: [], cautions: ["근거가 부족합니다."] },
                      { responseId: "C", strengths: [], cautions: [] },
                    ],
                    synthesis: "",
                    confidence: "high",
                    limitations: ["이 검토는 외부 사실 검증이 아닙니다."],
                    groundingStats: { totalCitations: 1, verifiedCitations: 1 },
                  },
                }
              : null,
            agreement: options.withSecondary
              ? {
                  confidenceMatches: false,
                  primaryConfidence: "medium",
                  secondaryConfidence: "high",
                  sharedVerifiedQuoteCount: 1,
                }
              : null,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "review-1",
          result,
          // Derived by the same function the route uses, so the fixture cannot
          // drift from the real ids: a hard-coded digest here would keep
          // passing after the derivation changed.
          reviewItems: [
            ...comparisonReviewItems(
              result.primary.result as ComparisonReviewItemSource,
              "primary"
            ),
            ...(result.secondary
              ? comparisonReviewItems(
                  result.secondary.result as ComparisonReviewItemSource,
                  "secondary"
                )
              : []),
          ].map((item) => ({
            id: item.id,
            reviewer: item.reviewer,
            section: item.section,
            ordinal: item.ordinal,
          })),
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
              modelName: "Gemini 3.5 Flash-Lite",
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

export async function mockConversationHistory(page: Page) {
  // The generic qa-conversation fixture returns an empty message list, but
  // the AI Review / quick-comparison entry points only render once the
  // conversation has responses -- so these tests need to seed one user
  // message plus a per-model assistant answer to match.
  const assistantMessageByModel: Record<string, { id: string; content: string }> = {
    [reviewModels[0]]: { id: "21111111-1111-4111-8111-111111111111", content: "GPT-5.4 mini answer" },
    [reviewModels[1]]: { id: "31111111-1111-4111-8111-111111111111", content: "Claude Haiku 4.5 answer" },
    [reviewModels[2]]: { id: "41111111-1111-4111-8111-111111111111", content: "Gemini 3.5 Flash-Lite answer" },
  };
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

export async function openReviewConversation(page: Page) {
  // The welcome screen's "recent conversations" card is the one
  // unambiguous way to open the mocked conversation on every viewport --
  // the sidebar (always-visible on desktop, a drawer on mobile) shows the
  // same conversation title and would otherwise be a second match.
  await openRecentConversation(page);
  await expect(page.getByTestId("chat-input")).toBeVisible();
}

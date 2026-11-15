import type { ReviewChatSource } from "../../lib/reviewToChat";

export function makeReviewReportFixture(): Extract<ReviewChatSource, { kind: "review" }> {
  const claim = { text: "승인 전에는 배포하지 않습니다.", citations: [{ responseId: "A" as const, quote: "Do not deploy before approval.", verified: true }], verified: true };
  const result = { consensus: [claim], contradictions: [], differences: [{ issue: "검토 순서", positions: [
    { responseId: "A" as const, position: "승인 후 배포", quote: "Do not deploy before approval.", verified: true },
    { responseId: "B" as const, position: "날짜 확인 필요", quote: "Unconfirmed quote", verified: false },
  ] }], missingPoints: ["비용 정보 누락"], verificationNeeded: ["날짜를 별도로 확인하세요."], modelAssessments: [
    { responseId: "A" as const, strengths: ["승인 조건 명시"], cautions: ["실제 승인 여부 미확인"] },
    { responseId: "B" as const, strengths: [], cautions: ["인용문 미확인"] },
  ], synthesis: "", confidence: "medium" as const, limitations: ["외부 사실 검증이 아닙니다."], groundingStats: { totalCitations: 3, verifiedCitations: 2 } };
  return { kind: "review", conversationId: "qa-conversation", mode: "balanced", includeSynthesis: false, reviewer: "primary",
    setup: { available: true, promptMessageId: "prompt-1", source: { question: "승인 전에 배포해도 될까요?", responses: [
      { messageId: "answer-a", content: "Do not deploy before approval. PRIVATE_FULL_ANSWER_A" },
      { messageId: "answer-b", content: "Check dates first. PRIVATE_FULL_ANSWER_B" },
    ] } },
    review: { id: "review-1", reviewerModelId: "reviewer-a", result: { primary: { reviewerModelId: "reviewer-a", result },
      secondary: { reviewerModelId: "reviewer-b", result: { ...result, consensus: [{ ...claim, text: "두 번째 검토자의 별도 견해" }] } }, agreement: null },
      responseMap: [ { responseId: "A", messageId: "answer-a", modelId: "gpt-6-luna", modelName: "Model A" },
        { responseId: "B", messageId: "answer-b", modelId: "claude-haiku-4-5", modelName: "Model B" } ],
      usageCredits: 0, cached: true, disclaimer: "Not external fact verification.", persisted: true },
  };
}

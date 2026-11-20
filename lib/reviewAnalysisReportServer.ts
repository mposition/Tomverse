import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { latestComparableConversationTurn } from "@/lib/comparisonReviewTurn";
import { comparisonReviewModeSchema, createComparisonReviewHash, createQuickComparisonSummaryHash, dualComparisonReviewResultSchema, verifiedQuickComparisonSummaryResultSchema, validateComparisonReviewInputSize } from "@/lib/comparisonReview";
import { buildReviewAnalysisReport, reviewReportFingerprintInput, reviewReportLabels } from "@/lib/reviewAnalysisReport";
import type { ReviewChatSource } from "@/lib/reviewToChat";
import { SUPPORTED_LANGUAGES } from "@/lib/language";
import { en } from "@/locales/en";
import { ko } from "@/locales/ko";
import { de } from "@/locales/de";
import { fr } from "@/locales/fr";
import { es } from "@/locales/es";
import { pt } from "@/locales/pt";
import { zh } from "@/locales/zh";
import { zhHant } from "@/locales/zhHant";

export const reviewReportSelectionSchema = z.object({
  kind: z.enum(["review", "quick"]), reviewId: z.string().min(1).max(100),
  reviewMode: comparisonReviewModeSchema, includeSynthesis: z.boolean(),
  reviewer: z.enum(["primary", "secondary"]), fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  language: z.enum(SUPPORTED_LANGUAGES),
}).strict();
export class ReviewReportSourceChanged extends Error {
  constructor() { super("The saved analysis changed. Reopen the current result and try again."); }
}

/** Caller owns authentication, owner/unlock checks and the appropriate entitlement. */
export async function loadReviewAnalysisReport(userId: string, conversationId: string, selection: z.infer<typeof reviewReportSelectionSchema>) {
  const turn = await latestComparableConversationTurn(conversationId);
  if (!turn) throw new ReviewReportSourceChanged();
  validateComparisonReviewInputSize(turn.prompt.content, turn.responses);
  const inputHash = selection.kind === "quick" ? createQuickComparisonSummaryHash({ promptMessageId: turn.prompt.id, question: turn.prompt.content, responses: turn.responses })
    : createComparisonReviewHash({ promptMessageId: turn.prompt.id, question: turn.prompt.content, responses: turn.responses, reviewMode: selection.reviewMode, includeSynthesis: selection.includeSynthesis });
  const stored = await prisma.comparisonReview.findFirst({ where: { id: selection.reviewId, userId, conversationId, inputHash, isStale: false } });
  if (!stored) throw new ReviewReportSourceChanged();
  const ids = z.array(z.string()).min(2).max(3).safeParse(stored.assistantMessageIds);
  if (!ids.success) throw new ReviewReportSourceChanged();
  const responseMap = ids.data.map((messageId, index) => {
    const response = turn.responses.find(item => item.messageId === messageId);
    if (!response) throw new ReviewReportSourceChanged();
    return { responseId: (["A", "B", "C"] as const)[index], messageId, modelId: response.modelId, modelName: response.modelName };
  });
  const setup = { available: true, source: { question: turn.prompt.content, responses: turn.responses.map(({ messageId, content }) => ({ messageId, content })) } };
  let source: ReviewChatSource;
  if (selection.kind === "quick") {
    const parsed = verifiedQuickComparisonSummaryResultSchema.safeParse(stored.result);
    if (!parsed.success || selection.reviewer !== "primary") throw new ReviewReportSourceChanged();
    source = { kind: "quick", conversationId, setup, review: { id: stored.id, reviewerModelId: stored.reviewerModelId, responseMap, result: parsed.data } };
  } else {
    const parsed = dualComparisonReviewResultSchema.safeParse(stored.result);
    if (!parsed.success || !parsed.data[selection.reviewer]) throw new ReviewReportSourceChanged();
    source = { kind: "review", conversationId, setup, mode: selection.reviewMode, includeSynthesis: selection.includeSynthesis, reviewer: selection.reviewer,
      review: { id: stored.id, reviewerModelId: stored.reviewerModelId, responseMap, result: parsed.data, usageCredits: 0, cached: true, disclaimer: "" } };
  }
  if (createHash("sha256").update(reviewReportFingerprintInput(source)).digest("hex") !== selection.fingerprint) throw new ReviewReportSourceChanged();
  const dictionary = { en, ko, de, fr, es, pt, zh, "zh-Hant": zhHant }[selection.language];
  const labels = reviewReportLabels(key => {
    const [group, name] = key.split(".");
    return (dictionary as unknown as Record<string, Record<string, string>>)[group]?.[name] ?? key;
  });
  return { source, stored, prompt: turn.prompt, report: buildReviewAnalysisReport(source, labels) };
}

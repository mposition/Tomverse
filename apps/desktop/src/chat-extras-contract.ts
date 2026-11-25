import { z } from "zod";
import { FEEDBACK_MESSAGE_MAX_LENGTH, FEEDBACK_MESSAGE_MIN_LENGTH, type FeedbackSubmitFailure } from "../../../lib/feedbackPolicy";
import { COMPARISON_REVIEW_ITEM_VERDICTS } from "../../../lib/comparisonReviewItemFeedback";
import { SUPPORTED_LANGUAGES } from "../../../lib/language";
import { chatId } from "./chat-contract";

/**
 * Web-only Chat and Review features that Desktop reaches through the account session.
 * The renderer sends a typed action; the main process owns the route, method and body shape.
 */
const product = z.enum(["chat", "review"]);

export const answerFeedbackInput = z.object({
  action: z.literal("feedback"),
  product,
  messageId: chatId,
  message: z.string().trim().min(FEEDBACK_MESSAGE_MIN_LENGTH).max(FEEDBACK_MESSAGE_MAX_LENGTH),
  modelId: z.string().trim().min(1).max(120).optional(),
  emailUpdates: z.boolean().optional(),
}).strict();

export const compareEstimateInput = z.object({ action: z.literal("compareEstimate"), conversationId: chatId }).strict();
export const compareSummaryInput = z.object({ action: z.literal("compareSummary"), conversationId: chatId }).strict();
export const verifyItemInput = z.object({
  action: z.literal("verifyItem"), conversationId: chatId, item: z.string().trim().min(1).max(500),
}).strict();
/** `verdict: null` withdraws the user's earlier verdict on the same item. */
export const itemFeedbackInput = z.object({
  action: z.literal("itemFeedback"), conversationId: chatId,
  reviewId: z.string().min(1).max(64), reviewItemId: z.string().min(1).max(128),
  verdict: z.enum(COMPARISON_REVIEW_ITEM_VERDICTS).nullable(),
}).strict();

/** Answers a saved question with an image in the same conversation. Charged at once, so Desktop asks first. */
export const imageTurnInput = z.object({
  action: z.literal("imageTurn"), conversationId: chatId, sourceUserMessageId: chatId,
  assistantMessageId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  modelId: z.string().min(1).max(120),
  imageModelIds: z.array(z.string().min(1).max(120)).max(8),
  preset: z.enum(["draft", "standard", "final"]).nullable(),
  prompt: z.string().trim().min(1).max(4_000).optional(),
  routingDecisionId: z.string().regex(/^[a-z0-9]{20,40}$/).optional(),
}).strict();

export const chatExtrasInput = z.discriminatedUnion("action", [
  answerFeedbackInput, compareEstimateInput, compareSummaryInput, verifyItemInput, itemFeedbackInput, imageTurnInput,
]);

/** The saved AI Review the report is built from; the server re-derives everything else. */
export const reviewExportInput = z.object({
  conversationId: chatId,
  format: z.enum(["pdf", "docx", "txt", "md"]),
  analysis: z.object({
    kind: z.enum(["review", "quick"]), reviewId: z.string().min(1).max(100),
    reviewMode: z.enum(["balanced", "evidence", "action"]), includeSynthesis: z.boolean(),
    reviewer: z.enum(["primary", "secondary"]), fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    language: z.enum(SUPPORTED_LANGUAGES),
  }).strict(),
}).strict();
export type ReviewExportInput = z.infer<typeof reviewExportInput>;

const quoteCitation = z.object({ responseId: z.enum(["A", "B", "C"]), quote: z.string(), verified: z.boolean() });
const quickClaim = z.object({ text: z.string(), citations: z.array(quoteCitation), verified: z.boolean() });
export const quickSummary = z.object({
  id: z.string(),
  result: z.object({
    commonConclusions: z.array(quickClaim),
    importantDifferences: z.array(quickClaim),
    modelKeyClaims: z.array(z.object({
      responseId: z.enum(["A", "B", "C"]),
      claims: z.array(z.object({ claim: z.string(), quote: z.string(), verified: z.boolean() })),
    })),
    verificationNeeded: z.array(z.string()),
    confidence: z.enum(["low", "medium", "high"]),
    groundingStats: z.object({ totalCitations: z.number(), verifiedCitations: z.number() }),
  }),
  responseMap: z.array(z.object({ responseId: z.enum(["A", "B", "C"]), messageId: z.string(), modelId: z.string(), modelName: z.string() })),
  reviewerModelId: z.string(),
  usageCredits: z.number(),
  cached: z.boolean(),
});
export type QuickSummary = z.infer<typeof quickSummary>;

export type FeedbackOutcome =
  | { ok: true; reference: string | null; emailUpdatesEnabled: boolean }
  | { ok: false; failure: FeedbackSubmitFailure };
/** `code` is the server's own error code; the renderer maps it to a sentence from the web dictionary. */
export type CompareEstimateOutcome =
  | { ok: true; available: boolean; estimatedCredits: number; cached: boolean }
  | { ok: false; code: string | null };
export type CompareSummaryOutcome = { ok: true; summary: QuickSummary } | { ok: false; code: string | null };
export type VerifyItemOutcome =
  | { ok: true; status: "supported" | "unsupported" | "inconclusive"; summary: string; usageCredits: number }
  | { ok: false };
export type ItemFeedbackOutcome = { ok: boolean };
export type ImageTurnOutcome = { ok: true; groupId: string } | { ok: false; code: string | null };

/** What the server's own image judgement decided for a saved Auto question. Nothing is generated or charged yet. */
export type ChatImageOffer = {
  conversationId: string; sourceUserMessageId: string; assistantMessageId: string; modelId: string;
  request: { modelIds: string[]; preset: "draft" | "standard" | "final" | null; prompt?: string; edit?: true; routingDecisionId?: string };
};

export type ChatExtrasOutput = {
  feedback: FeedbackOutcome;
  compareEstimate: CompareEstimateOutcome;
  compareSummary: CompareSummaryOutcome;
  verifyItem: VerifyItemOutcome;
  itemFeedback: ItemFeedbackOutcome;
  imageTurn: ImageTurnOutcome;
};
export type ChatExtrasInput = z.infer<typeof chatExtrasInput>;
export type ChatExtrasAction = ChatExtrasInput["action"];

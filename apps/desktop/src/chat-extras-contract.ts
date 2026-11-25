import { z } from "zod";
import { FEEDBACK_MESSAGE_MAX_LENGTH, FEEDBACK_MESSAGE_MIN_LENGTH, type FeedbackSubmitFailure } from "../../../lib/feedbackPolicy";
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

export const chatExtrasInput = z.discriminatedUnion("action", [answerFeedbackInput]);

export type FeedbackOutcome =
  | { ok: true; reference: string | null; emailUpdatesEnabled: boolean }
  | { ok: false; failure: FeedbackSubmitFailure };

export type ChatExtrasOutput = {
  feedback: FeedbackOutcome;
};
export type ChatExtrasInput = z.infer<typeof chatExtrasInput>;
export type ChatExtrasAction = ChatExtrasInput["action"];

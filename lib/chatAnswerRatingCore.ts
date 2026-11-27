/**
 * Thumbs up or down on one assistant answer (ChatAnswerRating).
 *
 * Pure and framework-free: the API route parses with these lists, the
 * buttons render from them, and `npm run check:enum-constraints` compares
 * them with the table's CHECK constraints.
 *
 * One rating per person per answer. A second rating replaces the first, and
 * `rating: null` withdraws it. A reason is optional, only for "down", and a
 * closed list: prose belongs in the existing Feedback report.
 */

import { z } from "zod";

export const CHAT_ANSWER_RATINGS = ["up", "down"] as const;
export type ChatAnswerRatingValue = (typeof CHAT_ANSWER_RATINGS)[number];

export const CHAT_ANSWER_RATING_REASONS = [
    "inaccurate",
    "unhelpful",
    "incomplete",
    "ignored_instructions",
    "other",
] as const;
export type ChatAnswerRatingReason = (typeof CHAT_ANSWER_RATING_REASONS)[number];

const idSchema = z.string().trim().min(1).max(191);

/** The PUT body. `rating: null` withdraws the person's rating. */
export const chatAnswerRatingWriteSchema = z
    .object({
        messageId: idSchema,
        rating: z.enum(CHAT_ANSWER_RATINGS).nullable(),
        reason: z.enum(CHAT_ANSWER_RATING_REASONS).nullable().optional(),
    })
    .strict()
    .refine((body) => body.reason == null || body.rating === "down", {
        message: "A reason can only accompany a down rating.",
        path: ["reason"],
    });

export type ChatAnswerRatingWrite = z.infer<typeof chatAnswerRatingWriteSchema>;

/** What the client is told about one rating: no ids beyond the answer's own. */
export type PublicChatAnswerRating = {
    messageId: string;
    rating: ChatAnswerRatingValue;
    reason: ChatAnswerRatingReason | null;
};

export const isChatAnswerRatingValue = (value: unknown): value is ChatAnswerRatingValue =>
    typeof value === "string" && (CHAT_ANSWER_RATINGS as readonly string[]).includes(value);

export const isChatAnswerRatingReason = (value: unknown): value is ChatAnswerRatingReason =>
    typeof value === "string" && (CHAT_ANSWER_RATING_REASONS as readonly string[]).includes(value);

/** A stored row as the client sees it, or null when it does not parse. */
export const publicChatAnswerRating = (row: {
    messageId: string;
    rating: string;
    reason: string | null;
}): PublicChatAnswerRating | null =>
    isChatAnswerRatingValue(row.rating)
        ? {
              messageId: row.messageId,
              rating: row.rating,
              reason: row.rating === "down" && isChatAnswerRatingReason(row.reason) ? row.reason : null,
          }
        : null;

/**
 * Why a rating write is refused, before anything is written. The order is the
 * order of the checks: a missing or foreign answer is "not found" whatever
 * else is true of it, so nothing about another account's answer is revealed.
 */
export type ChatAnswerRatingRefusal =
    | "not_found"
    | "locked"
    | "not_an_answer"
    | "unsupported_conversation";

export function chatAnswerRatingRefusal(input: {
    message: {
        role: string;
        status: string;
        conversation: { userId: string; kind: string };
    } | null;
    userId: string;
    /** Whether the request holds the conversation's unlock grant (always true when it has no lock). */
    unlocked: boolean;
}): ChatAnswerRatingRefusal | null {
    const { message } = input;
    if (!message || message.conversation.userId !== input.userId) return "not_found";
    if (!input.unlocked) return "locked";
    if (message.conversation.kind !== "chat") return "unsupported_conversation";
    if (message.role !== "assistant" || message.status === "error") return "not_an_answer";
    return null;
}

/** The HTTP answer for each refusal. */
export const CHAT_ANSWER_RATING_REFUSAL_STATUS: Record<ChatAnswerRatingRefusal, number> = {
    not_found: 404,
    locked: 423,
    not_an_answer: 409,
    unsupported_conversation: 409,
};

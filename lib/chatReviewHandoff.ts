/**
 * "Compare in Review" from a Chat answer: the prepared Review draft it opens.
 *
 * Chat keeps one answer per question; Review lays several models' answers
 * side by side. Rewriting a Chat conversation into Review would re-attribute
 * one model's history to several panels, and the product switcher never
 * rewrites a stored product (docs/ui-contracts/chat-product-switcher.md §1).
 * So the Chat conversation stays as it is, and the question the user wants
 * compared opens as a new Review draft through the existing `/review?prompt=`
 * prefill. Nothing is sent or charged until the user presses send there.
 *
 * The draft is built deterministically -- no model call -- from the question
 * of the chosen answer plus up to two earlier questions, so a follow-up such
 * as "and the cheaper one?" still has its context. Earlier answers are not
 * copied: they belong to the model that wrote them.
 */

import { REVIEW_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";

/** The `/review?prompt=` reader keeps this many characters. */
export const REVIEW_PREFILL_MAX_CHARS = 1200;
const CONTEXT_QUESTIONS = 2;
const CONTEXT_QUESTION_MAX_CHARS = 200;

type SeedMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  imported?: unknown;
};

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The Review draft for one Chat answer, or `null` when the answer has no
 * question of its own before it (nothing to compare).
 */
export function reviewSeedFromChat(
  messages: readonly SeedMessage[],
  assistantMessageId: string,
  contextLabel: string
): string | null {
  const answerIndex = messages.findIndex(
    (message) => message.id === assistantMessageId && message.role === "assistant"
  );
  if (answerIndex < 0) return null;
  // Native turns only: an imported message is the original's, not a question
  // this conversation asked.
  const questions = messages
    .slice(0, answerIndex)
    .filter((message) => message.role === "user" && !message.imported && message.content.trim());
  const question = questions.at(-1);
  if (!question) return null;
  const questionText = question.content.trim().slice(0, REVIEW_PREFILL_MAX_CHARS);
  const earlier = questions
    .slice(0, -1)
    .slice(-CONTEXT_QUESTIONS)
    .map((message) => `- ${clip(message.content, CONTEXT_QUESTION_MAX_CHARS)}`);
  if (!earlier.length) return questionText;
  const context = `${contextLabel}\n${earlier.join("\n")}\n\n`;
  // The question always survives whole; the context gives way first.
  return context.length + questionText.length <= REVIEW_PREFILL_MAX_CHARS
    ? `${context}${questionText}`
    : questionText;
}

/** The Review workspace with the draft prefilled; models stay Review's own. */
export const reviewPrefillHref = (prompt: string): string =>
  `${REVIEW_WORKSPACE_PATH}?prompt=${encodeURIComponent(prompt.slice(0, REVIEW_PREFILL_MAX_CHARS))}`;

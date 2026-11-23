/**
 * "Compare in Review" from an ordinary Chat answer: its prepared Review draft.
 * Continuation answers use the server's reference handoff instead of this URL.
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

import { resolveChatAttachmentFormat, type ChatAttachmentCategory } from "@/lib/chatAttachmentFormats";
import { REVIEW_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";

/** The `/review?prompt=` reader keeps this many characters. */
export const REVIEW_PREFILL_MAX_CHARS = 1200;
const CONTEXT_QUESTIONS = 2;
const CONTEXT_QUESTION_MAX_CHARS = 200;

type SeedAttachment = {
  name?: string;
  mediaType?: string;
  unavailableAt?: string | null;
};

type SeedMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  imported?: unknown;
  attachments?: readonly SeedAttachment[];
};

const buildSeed = (questions: readonly SeedMessage[], contextLabel: string): string => {
  const question = questions.at(-1)!;
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
  if (!questions.length) return null;
  return buildSeed(questions, contextLabel);
}

/**
 * What the web Chat's "Compare in Review" opens for one answer.
 *
 * Unlike `reviewSeedFromChat`, the question is the answer's *own* user turn:
 * the nearest native user message before it. A turn that sent only a file has
 * no question to compare, and substituting an earlier text question would pair
 * that older question with a document it was never asked about -- so that
 * case is `no-question` and the caller explains instead of opening Review.
 *
 * `reattachFile` is true only when that same turn has text and exactly one
 * attachment, an available document the server reads (PDF, Office, legacy
 * Office/HWP/RTF by the shared format table). It is a prompt to
 * pick the file again in Review, never a claim about which file: files are
 * not carried across (docs/policy/user-attachment-persistence.md §8), and a
 * name or type says nothing about whether a file the user picks later is the
 * same document.
 */
export type ChatReviewHandoff =
  | { kind: "seed"; seed: string; reattachFile: boolean }
  | { kind: "no-question" };

/*
  Documents whose text the server reads. iWork is left out: it is passed
  through unread, so picking it again would compare nothing. Images, data,
  code and archives keep the plain text handoff.
*/
const REATTACHABLE_DOCUMENT_CATEGORIES: ReadonlySet<ChatAttachmentCategory> = new Set<ChatAttachmentCategory>(["pdf", "office", "legacy-office"]);

/** One available, readable document by the shared format table -- by name and type, never by content. */
export const isReattachableDocument = (attachment: SeedAttachment) => {
  if (attachment.unavailableAt) return false;
  const format = resolveChatAttachmentFormat({
    filename: attachment.name ?? "",
    declaredMediaType: attachment.mediaType,
  });
  return Boolean(format && REATTACHABLE_DOCUMENT_CATEGORIES.has(format.category));
};

export function chatReviewHandoffFor(
  messages: readonly SeedMessage[],
  assistantMessageId: string,
  contextLabel: string
): ChatReviewHandoff | null {
  const answerIndex = messages.findIndex(
    (message) => message.id === assistantMessageId && message.role === "assistant"
  );
  if (answerIndex < 0) return null;
  const native = messages
    .slice(0, answerIndex)
    .filter((message) => message.role === "user" && !message.imported);
  const own = native.at(-1);
  if (!own) return null;
  if (!own.content.trim()) return { kind: "no-question" };
  const questions = native.filter((message) => message.content.trim());
  const attachments = own.attachments ?? [];
  return {
    kind: "seed",
    seed: buildSeed(questions, contextLabel),
    reattachFile: attachments.length === 1 && isReattachableDocument(attachments[0]),
  };
}

/** The query key that pairs one file handoff with the Review it opens. */
export const REVIEW_FILE_HANDOFF_PARAM = "fileHandoff";

/** The Review workspace with the draft prefilled; models stay Review's own. */
export const reviewPrefillHref = (prompt: string, fileHandoff?: string): string =>
  `${REVIEW_WORKSPACE_PATH}?prompt=${encodeURIComponent(prompt.slice(0, REVIEW_PREFILL_MAX_CHARS))}${
    fileHandoff ? `&${REVIEW_FILE_HANDOFF_PARAM}=${encodeURIComponent(fileHandoff)}` : ""}`;

/*
  The one-shot "pick the file again" marker.

  Tab memory only: a random token in the URL and the account that clicked, in
  this module. A copied URL or another tab has no entry, so it opens the plain
  question; an account switch fails the identity check; the arrival takes the
  entry and every other one, so going back and forward cannot revive it. No
  file name, id or content is in either half.
*/
const pendingFileHandoffs = new Map<string, string | null>();

/** Registers a file handoff for this account; returns the URL token. */
export function beginReviewFileHandoff(identityKey: string | null): string {
  const token = crypto.randomUUID();
  pendingFileHandoffs.set(token, identityKey);
  return token;
}

/** A compare without a file supersedes any handoff still waiting. */
export function clearReviewFileHandoffs(): void {
  pendingFileHandoffs.clear();
}

/** Consumes the marker: true only for this tab's token and the same account. */
export function takeReviewFileHandoff(token: string | null, identityKey: string | null): boolean {
  const matched = Boolean(token) && pendingFileHandoffs.has(token!) &&
    pendingFileHandoffs.get(token!) === identityKey;
  pendingFileHandoffs.clear();
  return matched;
}

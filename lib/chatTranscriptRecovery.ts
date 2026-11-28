import type { ChatAttachment, Message } from "@/components/chat/types";
import { CHAT_CONCURRENCY_ERROR_CODES } from "@/lib/chatConcurrencyCore";

export type ChatRecoveryPrompt = {
  text: string;
  attachments: ChatAttachment[];
  targetChatId: string;
};

/** UI-only greeting; never part of a provider transcript. */
export const CHAT_WELCOME_MESSAGE_ID = "welcome";

/** Unknown paid Guest Auto work requires reconciliation, never prompt replay. */
export const CHAT_NON_RECOVERABLE_ERROR_CODES = new Set([
  "GUEST_AUTO_OUTCOME_UNKNOWN",
]);

/**
 * Keep UI failures in memory, but do not send their empty placeholders. A
 * concurrency refusal never reached a model, so its card is never sent either
 * -- in Review its content is the refusal sentence, not an answer.
 */
export function requestTranscriptForScope(
  messages: readonly Message[],
  userMessage: Message,
  scope: "model" | "conversation"
): Message[] {
  return [
    ...messages.filter((message) =>
      message.id !== CHAT_WELCOME_MESSAGE_ID && message.id !== userMessage.id &&
      !(scope === "conversation" && message.role === "assistant" &&
        !message.content.trim() && !message.attachments?.length) &&
      !(message.role === "assistant" && message.errorCode &&
        CHAT_CONCURRENCY_ERROR_CODES.has(message.errorCode))
    ),
    userMessage,
  ];
}

/** One pass, reset at imported boundaries, rather than a scan per visible row. */
export function recoveryPromptsForMessages(
  messages: readonly Message[],
  conversationId: string | null
): Map<string, ChatRecoveryPrompt> {
  const prompts = new Map<string, ChatRecoveryPrompt>();
  if (!conversationId) return prompts;
  const seen = new Set<string>();
  let question: Message | null = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.imported) question = null;
    else if (message.role === "user") {
      question = message.content.trim() || message.attachments?.length ? message : null;
    }
    // Match the old findIndex contract for duplicate ids, even if the first
    // occurrence was not restorable. Loaded history is normally deduplicated.
    const firstOccurrence = !seen.has(message.id);
    seen.add(message.id);
    if (!firstOccurrence || message.imported || !question) continue;
    // No reply after a pre-saved question is not proof of server failure.
    const unansweredQuestion = message.role === "user" && index === messages.length - 1;
    const failedReply = message.role === "assistant" &&
      (message.status === "error" || message.status === "cancelled");
    if (!unansweredQuestion && !failedReply) continue;
    if (failedReply && message.errorCode &&
        CHAT_NON_RECOVERABLE_ERROR_CODES.has(message.errorCode)) continue;
    prompts.set(message.id, {
      text: question.content,
      attachments: question.attachments?.map((attachment) => ({ ...attachment })) ?? [],
      targetChatId: conversationId,
    });
  }
  return prompts;
}

/** The question belonging to this failed reply, not the runtime's last send. */
export function recoveryPromptForMessage(
  messages: readonly Message[],
  assistantMessageId: string,
  conversationId: string | null
): ChatRecoveryPrompt | null {
  return recoveryPromptsForMessages(messages, conversationId).get(assistantMessageId) ?? null;
}

/** A routed header names the first model; a fallback signal supersedes it. */
export function answeringModelId(input: {
  requestedModelId: string;
  routedModelId?: string | null;
  retryingWithModelId?: string | null;
}): string {
  return input.retryingWithModelId ?? input.routedModelId ?? input.requestedModelId;
}

/** Keep history filtering shared between the loader and executable tests. */
export function transcriptMessagesForScope(
  messages: Message[],
  modelId: string,
  scope: "model" | "conversation"
): Message[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const included = message.role === "user"
      ? scope === "conversation" || !message.modelId || message.modelId === modelId
      : message.role === "assistant" &&
        (scope === "conversation" || message.modelId === modelId);
    if (!included || seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* What the model reads of an earlier answer                                   */
/* -------------------------------------------------------------------------- */

/** Stands in for an answer that failed: the UI's apology is not model context. */
export const CHAT_FAILED_ANSWER_MARKER = "[previous answer failed]";
/** Ends a partial answer, so it is not read as one the model finished. */
export const CHAT_INCOMPLETE_ANSWER_MARKER =
  "[This answer was interrupted and is incomplete.]";

/** Bounds on the source list a search answer carries into the next turn. */
export const CHAT_HISTORY_SOURCE_LIMITS = Object.freeze({
  maxSources: 8,
  maxUrlLength: 300,
  maxTotalLength: 2_000,
});

type ModelContextMessage = {
  role: string;
  content: string;
  status?: unknown;
  errorCode?: unknown;
  searchMetadata?: unknown;
};

const safeSourceUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (!url || url.length > CHAT_HISTORY_SOURCE_LIMITS.maxUrlLength) return null;
  // Whitespace or a control character would let a "source" break out of its
  // own line in the list below.
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

/**
 * The "Sources: [n] url" tail of an answer that searched the web.
 *
 * The answer text cites "[2]"; the URLs behind those numbers live in the
 * message's search metadata, which the request carries but a history line did
 * not. Without them the model sees "[2]" with nothing it points at, and a
 * follow-up that leans on a source cannot name it. URLs only -- a title is
 * free text from the web, and nothing beyond a short, validated address is
 * copied into the model's context. The metadata comes from the client, so it
 * is bounded and re-validated here rather than trusted.
 */
export function historySourcesTail(
  searchMetadata: unknown,
  content: string
): string {
  const citations = (searchMetadata as { citations?: unknown } | null | undefined)
    ?.citations;
  if (!Array.isArray(citations)) return "";
  const seen = new Set<string>();
  const lines: string[] = [];
  let total = 0;
  for (const [index, citation] of citations.entries()) {
    if (lines.length >= CHAT_HISTORY_SOURCE_LIMITS.maxSources) break;
    const url = safeSourceUrl((citation as { url?: unknown } | null)?.url);
    if (!url || seen.has(url) || content.includes(url)) continue;
    const reference = (citation as { referenceNumber?: unknown }).referenceNumber;
    const number =
      typeof reference === "number" && Number.isSafeInteger(reference) && reference > 0
        ? reference
        : index + 1;
    const line = `[${number}] ${url}`;
    if (total + line.length > CHAT_HISTORY_SOURCE_LIMITS.maxTotalLength) break;
    seen.add(url);
    lines.push(line);
    total += line.length + 1;
  }
  return lines.length > 0 ? `\n\nSources:\n${lines.join("\n")}` : "";
}

/**
 * Earlier assistant turns as the model should read them.
 *
 * The client keeps an answer's failure on screen as an assistant turn, and the
 * request carries it back like any other. Left as it came, a failed turn is the
 * model's own previous reply -- an apology it never wrote, or half an answer it
 * would happily continue as if it had finished. So a failed turn becomes one
 * fixed marker (it keeps its place, so roles still alternate), a stopped or
 * cut-off partial answer says it is incomplete, and an answer that searched the
 * web keeps the URLs its "[n]" citations point at.
 *
 * Only the content changes. The last message is the one being answered and is
 * never touched.
 */
export function modelContextTranscript<T extends ModelContextMessage>(
  messages: readonly T[]
): T[] {
  const last = messages.length - 1;
  return messages.map((message, index) => {
    if (index === last || message.role !== "assistant") return message;
    const failed =
      message.status === "error" ||
      (typeof message.errorCode === "string" && message.errorCode.length > 0);
    if (failed) return { ...message, content: CHAT_FAILED_ANSWER_MARKER };
    const content = typeof message.content === "string" ? message.content : "";
    if (message.status === "cancelled" || message.status === "incomplete") {
      return {
        ...message,
        content: `${content}${historySourcesTail(message.searchMetadata, content)}\n\n${CHAT_INCOMPLETE_ANSWER_MARKER}`,
      };
    }
    const sources = historySourcesTail(message.searchMetadata, content);
    return sources ? { ...message, content: `${content}${sources}` } : message;
  });
}

/* -------------------------------------------------------------------------- */
/* Refusals the panel says in the person's own language                        */
/* -------------------------------------------------------------------------- */

const CONVERSATION_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "ASSISTANT_MESSAGE_CONFLICT",
  "CHAT_ATTEMPT_ID_REUSED",
  "CHAT_ATTEMPT_REVISION_CONFLICT",
  "CHAT_ATTEMPT_SCOPE_NOT_FOUND",
]);

const STORAGE_QUOTA_CODES: ReadonlySet<string> = new Set([
  "CHAT_ATTEMPT_STORAGE_QUOTA_EXCEEDED",
  "MESSAGE_STORAGE_QUOTA_EXCEEDED",
  "CONVERSATION_STORAGE_QUOTA_EXCEEDED",
]);

/**
 * The `chat.` copy key for a send refusal whose server sentence is English (or,
 * once, a fixed Korean one) and so must not reach the panel raw; `null` for a
 * code with no sentence of its own, which keeps its existing handling.
 *
 * `GUEST_AUTO_OUTCOME_UNKNOWN` is excluded on purpose: the panel writes its own
 * terminal state for it and withholds every retry, and a generic "unavailable"
 * sentence there would read as an invitation to resend a paid turn.
 */
export const chatSendErrorCopyKey = (code: string | null | undefined): string | null => {
  if (!code) return null;
  if (CONVERSATION_CONFLICT_CODES.has(code)) return "chat.conversationConflict";
  if (STORAGE_QUOTA_CODES.has(code)) return "chat.storageQuotaFull";
  if (code === "PROJECT_ARCHIVED") return "chat.projectArchived";
  if (code === "AI_PROVIDER_ERROR") return "chat.responseError";
  if (code.startsWith("GUEST_AUTO_") && !CHAT_NON_RECOVERABLE_ERROR_CODES.has(code)) {
    return "chat.guestAutoUnavailable";
  }
  return null;
};

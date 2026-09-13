import type { ChatAttachment, Message } from "@/components/chat/types";

export type ChatRecoveryPrompt = {
  text: string;
  attachments: ChatAttachment[];
  targetChatId: string;
};

/** UI-only greeting; never part of a provider transcript. */
export const CHAT_WELCOME_MESSAGE_ID = "welcome";

/** Keep UI failures in memory, but do not send their empty placeholders. */
export function requestTranscriptForScope(
  messages: readonly Message[],
  userMessage: Message,
  scope: "model" | "conversation"
): Message[] {
  return [
    ...messages.filter((message) =>
      message.id !== CHAT_WELCOME_MESSAGE_ID && message.id !== userMessage.id &&
      !(scope === "conversation" && message.role === "assistant" &&
        !message.content.trim() && !message.attachments?.length)
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

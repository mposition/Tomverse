import type { ChatAttachment, Message } from "@/components/chat/types";

export type ChatRecoveryPrompt = {
  text: string;
  attachments: ChatAttachment[];
  targetChatId: string;
};

/** The question belonging to this failed reply, not the runtime's last send. */
export function recoveryPromptForMessage(
  messages: Message[],
  assistantMessageId: string,
  conversationId: string | null
): ChatRecoveryPrompt | null {
  if (!conversationId) return null;
  const index = messages.findIndex((message) => message.id === assistantMessageId);
  const reply = messages[index];
  if (!reply || reply.imported) return null;
  // A reload may find only the pre-saved question: absence of a reply does
  // not prove server failure, but the user can explicitly restore that text.
  const unansweredQuestion = reply.role === "user" && index === messages.length - 1;
  if (!unansweredQuestion && (reply.role !== "assistant" ||
      (reply.status !== "error" && reply.status !== "cancelled"))) return null;
  for (let cursor = unansweredQuestion ? index : index - 1; cursor >= 0; cursor -= 1) {
    const question = messages[cursor];
    if (question.imported) return null;
    if (question.role !== "user") continue;
    if (!question.content.trim() && !question.attachments?.length) return null;
    return {
      text: question.content,
      attachments: question.attachments?.map((attachment) => ({ ...attachment })) ?? [],
      targetChatId: conversationId,
    };
  }
  return null;
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

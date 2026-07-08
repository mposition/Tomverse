const modelNames: Record<string, string> = {
  "gpt-4o": "GPT-4o",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "gemini-1-5": "Gemini 1.5",
};

export function formatConversationAsText(conversation: any) {
  const lines: string[] = [];

  lines.push("Tomverse AI Export");
  lines.push(`Conversation: ${conversation.title}`);
  lines.push(`Created: ${conversation.createdAt?.toISOString?.() || ""}`);
  lines.push("");
  lines.push("==================================================");
  lines.push("");

  for (const message of conversation.messages) {
    if (message.role === "user") {
      lines.push("[User]");
    } else {
      lines.push(`[${modelNames[message.modelId || ""] || message.modelId || "Assistant"}]`);
    }

    lines.push(message.content);
    lines.push("");
    lines.push("--------------------------------------------------");
    lines.push("");
  }

  return lines.join("\n");
}
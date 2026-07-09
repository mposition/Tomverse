type ExportMessage = {
    role: string;
    content: string;
    modelId?: string | null;
    createdAt?: Date | string;
};

type ExportConversation = {
    title: string;
    createdAt?: Date | string;
    messages: ExportMessage[];
};

const modelNames: Record<string, string> = {
    "gpt-4o": "GPT-4o",
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "gemini-1-5": "Gemini 1.5",
};

function formatDate(value?: Date | string) {
    if (!value) return "";
    const date = typeof value === "string" ? new Date(value) : value;
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function formatConversationAsText(conversation: ExportConversation) {
    return [
        formatConversationHeader(conversation),
        ...conversation.messages.map(formatExportMessage),
    ].join("\n");
}

export function formatConversationHeader(
    conversation: Pick<ExportConversation, "title" | "createdAt">
) {
    return [
        "Tomverse AI Export",
        `Conversation: ${conversation.title}`,
        `Created: ${formatDate(conversation.createdAt)}`,
        "",
    ].join("\n");
}

export function formatExportMessage(message: ExportMessage) {
    const label =
        message.role === "user"
            ? "User"
            : modelNames[message.modelId || ""] ||
              message.modelId ||
              "Assistant";

    return [
        "==================================================",
        `[${label}]${
            message.createdAt ? ` ${formatDate(message.createdAt)}` : ""
        }`,
        "--------------------------------------------------",
        message.content,
        "",
    ].join("\n");
}

export function sanitizeFileName(name: string) {
    return name.replace(/[/\\?%*:|"<>]/g, "-").slice(0, 80) || "conversation";
}

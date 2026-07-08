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
    const lines: string[] = [];

    lines.push("Tomverse AI Export");
    lines.push(`Conversation: ${conversation.title}`);
    lines.push(`Created: ${formatDate(conversation.createdAt)}`);
    lines.push("");

    for (const message of conversation.messages) {
        const label =
            message.role === "user"
                ? "User"
                : modelNames[message.modelId || ""] || message.modelId || "Assistant";

        lines.push("==================================================");
        lines.push(`[${label}]${message.createdAt ? ` ${formatDate(message.createdAt)}` : ""}`);
        lines.push("--------------------------------------------------");
        lines.push(message.content);
        lines.push("");
    }

    return lines.join("\n");
}

export function sanitizeFileName(name: string) {
    return name.replace(/[/\\?%*:|"<>]/g, "-").slice(0, 80) || "conversation";
}

import { getModel } from "@/lib/models";

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

// Hand-maintained names for ids that predate the model registry and are no
// longer in the catalogue at all. Everything still in the catalogue -- including
// every RETIRED model, which is exactly why retirement never deletes an entry --
// resolves through getModel below, so an export of an old conversation prints
// "Llama 3.3" or "Grok 3 Mini" rather than a bare id.
const legacyModelNames: Record<string, string> = {
    "gpt-4o": "GPT-4o",
    "gemini-1-5": "Gemini 1.5",
};

const displayNameFor = (modelId: string) =>
    getModel(modelId)?.name || legacyModelNames[modelId] || modelId;

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
        "Tomverse Insight Export",
        `Conversation: ${conversation.title}`,
        `Created: ${formatDate(conversation.createdAt)}`,
        "",
    ].join("\n");
}

export function formatExportMessage(message: ExportMessage) {
    const label =
        message.role === "user"
            ? "User"
            : message.modelId
              ? displayNameFor(message.modelId)
              : "Assistant";

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

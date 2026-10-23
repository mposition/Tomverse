import {
    CHAT_IMAGE_INTENT_CLIENT_TIMEOUT_MS,
    readChatImageDecision,
    type ChatImageDecision,
} from "@/lib/chatImageIntentCore";

/**
 * Asks POST /api/chat/image-intent whether this composer text is a request to
 * create an image, and which image model and preset it needs. `{ image:
 * false }` on any failure, refusal or timeout: the send then goes to chat
 * exactly as it did before the feature existed.
 */
export async function askChatImageIntent(
    text: string,
    options: { conversationId?: string | null } = {},
    fetchImpl: typeof fetch = fetch
): Promise<ChatImageDecision> {
    try {
        const response = await fetchImpl("/api/chat/image-intent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
                options.conversationId ? { text, conversationId: options.conversationId } : { text }
            ),
            signal: AbortSignal.timeout(CHAT_IMAGE_INTENT_CLIENT_TIMEOUT_MS),
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return { image: false };
        }
        return readChatImageDecision(await response.json());
    } catch {
        return { image: false };
    }
}

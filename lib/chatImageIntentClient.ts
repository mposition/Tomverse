import { CHAT_IMAGE_INTENT_CLIENT_TIMEOUT_MS } from "@/lib/chatImageIntentCore";

/**
 * Asks POST /api/chat/image-intent whether this composer text is a request to
 * create an image. False on any failure, refusal or timeout: the send then
 * goes to chat exactly as it did before the feature existed.
 */
export async function askChatImageIntent(
    text: string,
    fetchImpl: typeof fetch = fetch
): Promise<boolean> {
    try {
        const response = await fetchImpl("/api/chat/image-intent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
            signal: AbortSignal.timeout(CHAT_IMAGE_INTENT_CLIENT_TIMEOUT_MS),
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return false;
        }
        const data: unknown = await response.json();
        return (
            typeof data === "object" &&
            data !== null &&
            (data as { image?: unknown }).image === true
        );
    } catch {
        return false;
    }
}

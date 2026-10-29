import {
    CHAT_IMAGE_INTENT_CLIENT_TIMEOUT_MS,
    readChatImageDecision,
    type ChatImageDecision,
} from "@/lib/chatImageIntentCore";
import type { ChatImageTurnRequest } from "@/lib/chatImageTurnCore";

/**
 * Asks POST /api/chat/image-intent whether this composer text is a request to
 * create an image, and which image model and preset it needs. `{ image:
 * false }` on any failure, refusal or timeout: the send then goes to chat
 * exactly as it did before the feature existed.
 */
export async function askChatImageIntent(
    text: string,
    /** `attachedPhoto`: the message carries a photo the user may want edited. */
    options: { conversationId?: string | null; attachedPhoto?: boolean } = {},
    fetchImpl: typeof fetch = fetch
): Promise<ChatImageDecision> {
    try {
        const response = await fetchImpl("/api/chat/image-intent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text,
                ...(options.conversationId ? { conversationId: options.conversationId } : {}),
                ...(options.attachedPhoto ? { attachedPhoto: true } : {}),
            }),
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

/**
 * The same question, answered as the send needs it: the image turn to make,
 * or `undefined` for an ordinary text answer. Never rejects, so a send can
 * start beside it and read it later.
 */
export async function askChatImageTurn(
    ...args: Parameters<typeof askChatImageIntent>
): Promise<ChatImageTurnRequest | undefined> {
    const decision = await askChatImageIntent(...args);
    if (!decision.image) return undefined;
    return {
        modelIds: decision.modelId ? [decision.modelId] : [],
        preset: decision.preset,
        ...(decision.prompt ? { prompt: decision.prompt } : {}),
        ...(decision.edit ? { edit: true as const } : {}),
    };
}

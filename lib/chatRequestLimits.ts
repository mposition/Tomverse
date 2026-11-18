/**
 * The client's way of staying inside the shape limits of one `/api/chat`
 * request.
 *
 * The client sends the conversation's whole visible transcript, and a
 * conversation has no length limit -- so once it grew past the server's
 * limits, every further turn was refused and the conversation could not be
 * continued at all. The first to break was the count: 100 messages is fifty
 * exchanges with one model, and fewer where each question carries every
 * model's reply. Trace 0f3b722e-fdca-459d-8a33-5cc9e541a38f, 2026-09-27:
 * "Invalid message count." on a conversation well inside its model's context
 * window.
 *
 * `fitChatRequestTranscript()` sends the newest part of the transcript that
 * fits, rather than all of it. What a model can actually hold is a different
 * question with its own, explicit refusal (`MODEL_CONTEXT_WINDOW_EXCEEDED`,
 * `CHAT_INPUT_TOKEN_LIMIT`); this only keeps a request from breaking the shape
 * limits on length alone.
 */

import {
    CHAT_REQUEST_ENVELOPE_BYTES,
    chatMaxMessageCharacters,
    chatRequestMaxBodyBytes,
} from "@/lib/chatInputLimits";
import { AVAILABLE_MODELS, type AiModel } from "@/lib/models";

const CONTEXT_WINDOWS = (AVAILABLE_MODELS as readonly AiModel[]).map(
    (model) => model.contextWindowTokens
);

/**
 * One message's longest text, and the largest body any route that carries a
 * message may read -- shared by the chat request, message saving, receipt
 * recovery, drafts and preflight, so a message the chat request accepts is
 * never refused by the route that stores it.
 */
export const CHAT_MAX_MESSAGE_CHARACTERS = chatMaxMessageCharacters(CONTEXT_WINDOWS);
export const CHAT_MAX_MESSAGE_BODY_BYTES = chatRequestMaxBodyBytes(CONTEXT_WINDOWS);

/**
 * The server's limits, as `validateChatPayload()` applies them.
 *
 * The source of truth is `CHAT_REQUEST_LIMITS` in `lib/chatSecurity.ts`, which
 * is server-only and so cannot be imported here. It is not moved into this
 * module either: `lib/chatSecurity.ts` sits inside the Prompt Refiner's sealed
 * runtime source closure (`PROMPT_REFINER_RUNTIME_SOURCE_PATHS`), where a new
 * import adds a file -- and its computed accesses -- to a reviewed snapshot.
 * So the two numbers are copied, and `tests/chatRequestLimits.test.mjs` fails
 * the moment they differ.
 *
 * There is no total-character limit any more (operator decision 2026-11-18):
 * what bounds the transcript is the request body size, which is sized from the
 * largest model context window (`chatRequestMaxBodyBytes`). The window keeps
 * its message text under the body limit less `CHAT_REQUEST_ENVELOPE_BYTES`,
 * the room left for everything else the request carries.
 */
export const CHAT_REQUEST_TRANSCRIPT_LIMITS = {
    maxMessages: 100,
    maxBodyBytes: CHAT_MAX_MESSAGE_BODY_BYTES,
} as const;

type TranscriptLimits = {
    readonly maxMessages: number;
    readonly maxBodyBytes: number;
};

const encoder = new TextEncoder();

/** What `content` adds to the JSON body: its encoded string, in UTF-8 bytes. */
const contentLength = (message: { content: unknown }) =>
    typeof message.content === "string"
        ? encoder.encode(JSON.stringify(message.content)).length
        : 0;

/**
 * The newest suffix of `messages` that the server will accept.
 *
 * Four rules:
 *
 *  * **A transcript that already fits is returned unchanged** -- the same
 *    array. Nothing about an ordinary request moves, including the digest the
 *    server takes of it for a durable response attempt.
 *  * **The last message is always kept**, even when it alone breaks a limit.
 *    It is this turn's question; dropping it would send a request about
 *    something else. The server then refuses it with its own code, which says
 *    what is actually wrong.
 *  * **Older messages are dropped whole, oldest first**, until both the count
 *    and the message bytes fit. A message is never cut in the middle.
 *  * **The window opens on a user message.** Cut mid-exchange, it would begin
 *    with a reply to a question the model can no longer see, and some
 *    providers refuse a transcript that does not open with a user turn.
 *
 * Deterministic: the same transcript always yields the same window, so a
 * resend presents the same request.
 */
export function fitChatRequestTranscript<
    T extends { role: string; content: unknown },
>(
    messages: readonly T[],
    limits: TranscriptLimits = CHAT_REQUEST_TRANSCRIPT_LIMITS
): readonly T[] {
    const maxContentBytes = Math.max(
        0,
        limits.maxBodyBytes - CHAT_REQUEST_ENVELOPE_BYTES
    );
    const total = messages.reduce(
        (sum, message) => sum + contentLength(message),
        0
    );
    if (messages.length <= limits.maxMessages && total <= maxContentBytes) {
        return messages;
    }

    const last = messages.length - 1;
    let start = last;
    let bytes = contentLength(messages[last]);
    for (let index = last - 1; index >= 0; index -= 1) {
        const next = bytes + contentLength(messages[index]);
        if (last - index + 1 > limits.maxMessages) break;
        if (next > maxContentBytes) break;
        bytes = next;
        start = index;
    }
    while (start < last && messages[start].role !== "user") start += 1;
    return messages.slice(start);
}

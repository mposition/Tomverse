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
 */
export const CHAT_REQUEST_TRANSCRIPT_LIMITS = {
    maxMessages: 100,
    maxTotalCharacters: 300_000,
} as const;

type TranscriptLimits = {
    readonly maxMessages: number;
    readonly maxTotalCharacters: number;
};

/** Counted as the server counts it: UTF-16 code units of `content`. */
const contentLength = (message: { content: unknown }) =>
    typeof message.content === "string" ? message.content.length : 0;

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
 *    and the character total fit. A message is never cut in the middle.
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
    const total = messages.reduce(
        (sum, message) => sum + contentLength(message),
        0
    );
    if (
        messages.length <= limits.maxMessages &&
        total <= limits.maxTotalCharacters
    ) {
        return messages;
    }

    const last = messages.length - 1;
    let start = last;
    let characters = contentLength(messages[last]);
    for (let index = last - 1; index >= 0; index -= 1) {
        const next = characters + contentLength(messages[index]);
        if (last - index + 1 > limits.maxMessages) break;
        if (next > limits.maxTotalCharacters) break;
        characters = next;
        start = index;
    }
    while (start < last && messages[start].role !== "user") start += 1;
    return messages.slice(start);
}

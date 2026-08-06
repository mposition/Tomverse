/**
 * The pure half of the chat context builder.
 *
 * `lib/chatMemoryContext.ts` is server-only — it reads settings, retrieves and
 * hashes. What lives here is the part with no database in it, so it can be
 * pinned by a unit test rather than only by a DB integration run.
 */

/**
 * The text retrieval is scored against: the newest user turn, raw.
 *
 * It has to be the *same string* the preparation step used. Preparation and
 * chat build the context independently and then compare fingerprints (§10), so
 * a difference of one character makes every send look stale — the request
 * would be refused for drift that never happened.
 *
 * Which is why this is the raw message content and not the message the chat
 * route assembles further down: that one has extracted attachment text folded
 * into it, and the preparation step, which sees only the composer's prompt,
 * has no way to reproduce it.
 */
export function latestUserPromptText(
    messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>
): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role === "user") return message.content;
    }
    // A history with no user turn cannot happen through the composer, and an
    // empty query is the honest input for it: retrieval then selects only the
    // always-relevant memories rather than matching on stray terms.
    return "";
}

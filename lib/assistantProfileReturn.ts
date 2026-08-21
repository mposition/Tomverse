/**
 * The chat → create-a-profile → chat round trip (Release C).
 *
 * docs/policy/external-conversation-import-and-memory.md §14.
 *
 * ## Why no return URL travels
 *
 * The obvious shape for "come back where you were" is a `returnTo` parameter,
 * and it is the shape that turns into an open redirect the first time somebody
 * forgets to validate it. Nothing here needs one: the chat surface is a single
 * route that already restores its own conversation from
 * `GUEST_ACTIVE_CHAT_STORAGE_KEY` on mount, so returning is a fixed push to
 * `/chat` and the conversation comes back by itself.
 *
 * So the only thing this module carries is a flag saying the visitor arrived
 * from the chat — a literal, compared to a literal — and, separately, the id
 * of a profile that was just created.
 *
 * ## Why the profile id is not authority
 *
 * The id is a *request*, not a grant. It is applied by the same handler a
 * hand-picked profile goes through, which sends the existing conversation
 * PATCH; the server resolves ownership, the active version and the flag there
 * and refuses with the same 403/404/409 it always did. A tampered value buys
 * nothing except a refusal, which is why storing it client-side is acceptable
 * and validating it server-side is not optional.
 *
 * The shape check below is therefore about hygiene rather than trust: an id is
 * an opaque token this product generates, and anything carrying a slash, a
 * colon or a space is not one — refusing it early keeps a malformed value from
 * reaching a request at all.
 */

export const ASSISTANT_PROFILE_RETURN_PARAM = "from";
export const ASSISTANT_PROFILE_RETURN_CHAT = "chat";

/** Where the round trip ends. A constant, never a value from the query. */
export const ASSISTANT_PROFILE_CHAT_PATH = "/chat";

/**
 * Set by the create screen, read once by the chat surface.
 *
 * `sessionStorage` rather than `localStorage`: the handoff is meaningful for
 * exactly one navigation in one tab, and a value that outlived the tab would
 * reapply a profile to whatever conversation happened to open next.
 */
export const PENDING_CHAT_PROFILE_STORAGE_KEY =
    "tomverse_pending_chat_assistant_profile";

/** Ids this product mints: opaque, bounded, no separators. */
const PROFILE_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

export const isPlausibleProfileId = (value: unknown): value is string =>
    typeof value === "string" && PROFILE_ID_SHAPE.test(value);

/**
 * Whether this screen was opened from the chat.
 *
 * Compared against one literal. An unknown value is not a different
 * destination, it is simply not the chat — there is no branch that reads the
 * parameter as somewhere to go.
 */
export const isChatReturnRequest = (search: string): boolean => {
    const params = new URLSearchParams(
        search.startsWith("?") ? search.slice(1) : search
    );
    return (
        params.get(ASSISTANT_PROFILE_RETURN_PARAM) ===
        ASSISTANT_PROFILE_RETURN_CHAT
    );
};

/** The create screen's own href, as the chat's CTA should write it. */
export const assistantProfileCreateHref = (options?: { fromChat?: boolean }) =>
    options?.fromChat
        ? `/settings/assistants/new?${ASSISTANT_PROFILE_RETURN_PARAM}=${ASSISTANT_PROFILE_RETURN_CHAT}`
        : "/settings/assistants/new";

export const stashPendingChatProfile = (profileId: string) => {
    if (typeof window === "undefined") return;
    if (!isPlausibleProfileId(profileId)) return;
    try {
        window.sessionStorage.setItem(
            PENDING_CHAT_PROFILE_STORAGE_KEY,
            profileId
        );
    } catch {
        // A tab with storage disabled still gets the profile and the return
        // trip; it just does not get the automatic apply. Losing the handoff
        // is not worth failing the create over.
    }
};

/**
 * Reads the pending profile and clears it in the same call.
 *
 * Consumed rather than read so a later mount — a refresh, a second tab
 * restoring the same conversation — cannot reapply a request that was already
 * served. Same reason `consumePendingAccountSettingsRequest` does it.
 */
export const consumePendingChatProfile = (): string | null => {
    if (typeof window === "undefined") return null;
    try {
        const value = window.sessionStorage.getItem(
            PENDING_CHAT_PROFILE_STORAGE_KEY
        );
        window.sessionStorage.removeItem(PENDING_CHAT_PROFILE_STORAGE_KEY);
        return isPlausibleProfileId(value) ? value : null;
    } catch {
        return null;
    }
};

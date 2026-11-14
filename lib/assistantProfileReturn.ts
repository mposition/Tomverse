/**
 * The product → create-a-profile → same product round trip (Release C).
 *
 * docs/policy/external-conversation-import-and-memory.md §14.
 *
 * ## Why no return URL travels
 *
 * The obvious shape for "come back where you were" is a `returnTo` parameter,
 * and it is the shape that turns into an open redirect the first time somebody
 * forgets to validate it. Nothing here needs one: each product is a single
 * route that already restores its own conversation from session storage on
 * mount, so returning is a fixed push to `/chat` or `/review` and the
 * conversation comes back by itself.
 *
 * Which of the two is the product the assistant was added in (owner decision
 * 2026-11-14): the composer's create link names its product as one of two
 * literals, and the settings editor uses the product whose settings panel the
 * visitor opened (`useSettingsReturnProduct`). Unknown is Review, as before.
 * Chat answers on one model, so a profile naming several starts in Review.
 *
 * The picker returns to the current conversation. The settings editor and
 * knowledge guide request a new conversation with the saved assistant.
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

import type { ConversationProductKey } from "@/lib/conversationProduct";
import {
    CHAT_WORKSPACE_PATH,
    REVIEW_WORKSPACE_PATH,
} from "@/lib/productSurfaceRoutes";

export const ASSISTANT_PROFILE_RETURN_PARAM = "from";
export const ASSISTANT_PROFILE_RETURN_CHAT = "chat";
export const ASSISTANT_PROFILE_RETURN_REVIEW = "review";

/** The Review end of the round trip. A constant, never a value from the query. */
export const ASSISTANT_PROFILE_REVIEW_PATH = REVIEW_WORKSPACE_PATH;

/**
 * Set by the create or edit screen, read once by the chat surface.
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
 * Which product's conversation opened this screen, or null for none.
 *
 * Compared against two literals. An unknown value is not a different
 * destination, it is simply no product — there is no branch that reads the
 * parameter as somewhere to go.
 */
export const assistantProfileReturnProduct = (
    search: string | URLSearchParams
): ConversationProductKey | null => {
    const params =
        typeof search === "string"
            ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
            : search;
    const value = params.get(ASSISTANT_PROFILE_RETURN_PARAM);
    if (value === ASSISTANT_PROFILE_RETURN_CHAT) return "chat";
    if (value === ASSISTANT_PROFILE_RETURN_REVIEW) return "review";
    return null;
};

/** The create screen's own href, as a composer's CTA should write it. */
export const assistantProfileCreateHref = (options?: {
    from?: ConversationProductKey;
}) =>
    options?.from
        ? `/settings/assistants/new?${ASSISTANT_PROFILE_RETURN_PARAM}=${
              options.from === "chat"
                  ? ASSISTANT_PROFILE_RETURN_CHAT
                  : ASSISTANT_PROFILE_RETURN_REVIEW
          }`
        : "/settings/assistants/new";

/** A product's own route. Never built from a query value. */
export const assistantProfileProductPath = (product: ConversationProductKey) =>
    product === "chat" ? CHAT_WORKSPACE_PATH : REVIEW_WORKSPACE_PATH;

/**
 * Where "start with this assistant" goes: the product it was added in, except
 * that Chat answers on exactly one model, so a profile naming several starts
 * in Review rather than being refused with CHAT_PROFILE_SINGLE_MODEL_REQUIRED.
 * A profile naming none follows the account default, which Chat clamps to one.
 */
export const assistantProfileStartPath = (
    product: ConversationProductKey,
    profileModelCount: number
) =>
    assistantProfileProductPath(
        product === "chat" && profileModelCount > 1 ? "review" : product
    );

/** The model ceiling a create from this product may pick. */
export const assistantProfileCreateModelLimit = (
    product: ConversationProductKey,
    profileLimit: number
) => (product === "chat" ? 1 : profileLimit);

type ProfileEntry = "chat" | "settings" | "guide";

export const stashPendingChatProfile = (profileId: string, entry: ProfileEntry = "chat") => {
    if (typeof window === "undefined" || !isPlausibleProfileId(profileId)) return false;
    try {
        window.sessionStorage.setItem(
            PENDING_CHAT_PROFILE_STORAGE_KEY,
            entry === "chat" ? profileId : `${entry}:${profileId}`
        );
        return true;
    } catch {
        // A tab with storage disabled still gets the profile and the return
        // trip; the editor can keep a failed chat launch on screen.
        return false;
    }
};

/**
 * Reads the pending profile and clears it in the same call.
 *
 * Consumed rather than read so a later mount — a refresh, a second tab
 * restoring the same conversation — cannot reapply a request that was already
 * served. Same reason `consumePendingAccountSettingsRequest` does it.
 */
export const consumePendingChatProfile = (): { profileId: string; entry: ProfileEntry } | null => {
    if (typeof window === "undefined") return null;
    try {
        const value = window.sessionStorage.getItem(
            PENDING_CHAT_PROFILE_STORAGE_KEY
        );
        window.sessionStorage.removeItem(PENDING_CHAT_PROFILE_STORAGE_KEY);
        if (!value) return null;
        const separator = value.indexOf(":");
        // Older tabs and the create-and-return flow store a plain profile ID.
        if (separator < 0) return isPlausibleProfileId(value) ? { profileId: value, entry: "chat" } : null;
        const entry = value.slice(0, separator);
        const profileId = value.slice(separator + 1);
        if ((entry !== "settings" && entry !== "guide") || !isPlausibleProfileId(profileId)) return null;
        return { profileId, entry };
    } catch {
        return null;
    }
};

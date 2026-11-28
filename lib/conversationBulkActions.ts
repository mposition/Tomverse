/**
 * Acting on several conversations at once: the sidebar's selection mode, and
 * the one-row "Archive" item, which is the same request with one id.
 *
 * Pure and shared: POST /api/conversations/bulk validates against these
 * constants, and the sidebar uses the same ones to stop a selection at the
 * limit before the server has to refuse it.
 */

export const CONVERSATION_SELECTION_ACTIONS = ["delete", "archive", "unarchive"] as const;
export type ConversationSelectionAction = (typeof CONVERSATION_SELECTION_ACTIONS)[number];

/**
 * The most conversations one request may name. A delete runs every cleanup
 * the single delete runs, in one transaction, so this bounds that transaction
 * the way delete-all's own limit bounds its request count.
 */
export const CONVERSATION_SELECTION_LIMIT = 50;

/** Why a named conversation was left as it was. */
export type ConversationSelectionSkipReason =
    /** Locked, and this browser holds no unlock for it: never deleted unseen. */
    | "locked"
    /** Gone already (deleted in another tab), or not a conversation this applies to. */
    | "not_found";

export type ConversationSelectionResult = {
    /** The ids the action was applied to. */
    done: string[];
    skipped: Array<{ id: string; reason: ConversationSelectionSkipReason }>;
};

/**
 * Said by the sidebar after it changed the list without the page's help, so the
 * page refetches and, for deleted ids, drops what it holds about them (drafts,
 * the open conversation).
 */
export const CONVERSATIONS_CHANGED_EVENT = "tomverse:conversations-changed";

export type ConversationsChangedDetail = { deletedIds?: string[] };

export const announceConversationsChanged = (detail: ConversationsChangedDetail = {}) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent<ConversationsChangedDetail>(CONVERSATIONS_CHANGED_EVENT, { detail }));
};

/** Ids in first-seen order, without repeats. */
export const uniqueConversationIds = (ids: readonly string[]): string[] => [...new Set(ids)];

export type ConversationSelectionResponse =
    | { ok: true; result: ConversationSelectionResult }
    | { ok: false; status: number; code: string | null };

/** The browser's side of POST /api/conversations/bulk. */
export async function requestConversationSelection(
    action: ConversationSelectionAction,
    conversationIds: readonly string[],
    fetcher: typeof fetch = fetch
): Promise<ConversationSelectionResponse> {
    let response: Response;
    try {
        response = await fetcher("/api/conversations/bulk", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({ action, conversationIds: uniqueConversationIds(conversationIds) }),
        });
    } catch {
        return { ok: false, status: 0, code: null };
    }
    const body = (await response.json().catch(() => null)) as
        | (Partial<ConversationSelectionResult> & { code?: unknown })
        | null;
    if (!response.ok || !Array.isArray(body?.done) || !Array.isArray(body?.skipped)) {
        return {
            ok: false,
            status: response.status,
            code: typeof body?.code === "string" ? body.code : null,
        };
    }
    return { ok: true, result: { done: body.done, skipped: body.skipped } };
}

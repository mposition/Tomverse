/**
 * What submitting the rename dialog does.
 *
 * Policy: docs/policy/external-conversation-continuation.md §3.
 *
 * The dialog opens with the title the list shows, and for a continuation
 * nobody has named that title is not stored anywhere: it is the imported
 * conversation's own name, or a fallback, resolved for display
 * (lib/continuationDisplayTitle.ts). Confirming the dialog without changing
 * it used to save that displayed text onto `Conversation.title`, so a click
 * that meant "never mind" copied the source's words into a table the
 * source's deletion does not reach.
 *
 * So a submit only saves what the owner actually changed. Clearing and
 * retyping the same name, adding spaces, or editing and reverting are all
 * "unchanged", because the server trims and would store the same string.
 * Keeping a displayed name on purpose is a separate, explicitly labelled
 * action (`saveDisplayedTitle`), not a side effect of pressing OK.
 *
 * This does not forbid a title that happens to equal the source's: a name
 * the owner typed is theirs whatever it says.
 */

/**
 * The longest title the rename API stores. One number for the route's schema
 * and for the dialog, which hides "save the shown name" for a displayed title
 * the server would refuse.
 */
export const CONVERSATION_TITLE_MAX_LENGTH = 120;

export type RenameDecision =
    | { action: "save"; title: string }
    | { action: "none" }
    | { action: "invalid" };

export function renameDecision({
    initialValue,
    nextValue,
}: {
    /** What the dialog opened with -- the title as shown. */
    initialValue: string;
    /** What the field holds on submit. */
    nextValue: string;
}): RenameDecision {
    const next = nextValue.trim();
    if (!next) return { action: "invalid" };
    if (next === initialValue.trim()) return { action: "none" };
    return { action: "save", title: next };
}

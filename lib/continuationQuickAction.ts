/**
 * Which trailing action a row of the imported-conversation list shows.
 *
 * Policy: docs/policy/external-conversation-continuation.md §6, §7, §8.
 *
 * A pure function rather than a chain of ternaries inside the component,
 * because the ordering below is the whole decision and it is the kind of thing
 * that gets reordered by accident:
 *
 *   1. The flag comes first. With continuation off there is no action at all —
 *      not a disabled one, not a locked one. §7 says the rollout switch closes
 *      creation, and a greyed button on every row would advertise a feature
 *      the account cannot reach while telling it nothing it can act on. The
 *      list, the detail view, deletion and export are untouched.
 *   2. Locked comes before counting. A locked snapshot's continuations are not
 *      a secret — the owner made them — but the action a locked row offers is
 *      the password, and offering "open" beside a source they cannot read
 *      would be answering a different question. The remedy lives on the
 *      source's own page and never in the list.
 *   3. Then the count decides, and only then.
 *
 * `hasLatest` is separate from `continuationCount > 0` on purpose. They come
 * from the same query and should agree, but a row that claims one continuation
 * and carries no id to open would render a button with nowhere to go; falling
 * back to "create" is wrong there too, so the resolver refuses to be in that
 * state and reports `create` only when there is genuinely nothing to open.
 */

export type ContinuationQuickActionState =
    /** No continuation yet: the button starts one. */
    | "create"
    /** Exactly one: the button opens it, and creates nothing. */
    | "open_existing"
    /** More than one: a menu of existing conversations to open. */
    | "choose_existing"
    /** Locked source: route to the source's page for the password. */
    | "locked"
    /** Flag off: nothing renders. */
    | "hidden";

export function continuationQuickActionState({
    continuationEnabled = true,
    locked,
    continuationCount,
    hasLatest,
}: {
    continuationEnabled?: boolean;
    locked: boolean;
    continuationCount: number;
    hasLatest: boolean;
}): ContinuationQuickActionState {
    if (!continuationEnabled) return "hidden";
    if (locked) return "locked";
    if (continuationCount > 1) return "choose_existing";
    if (continuationCount === 1 && hasLatest) return "open_existing";
    return "create";
}

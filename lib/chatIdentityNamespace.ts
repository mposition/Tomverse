/**
 * Which identity a conversation id belongs to.
 *
 * A chat tab is always in exactly one identity namespace: the guest browser,
 * or one signed-in account. Guest conversations live only in this browser's
 * localStorage under `guest_*` ids; an account's conversations are rows in the
 * database with server-issued ids. Nothing legitimately holds an id from one
 * namespace while operating in the other.
 *
 * Carrying one across the boundary is what produced the reported
 * `CONVERSATION_FORBIDDEN`: signing in left `guest_1754...` selected, and the
 * account APIs -- conversation detail, model-settings sync, message history in
 * each of the three comparison panels -- were then called with an id no
 * account can own, so the server correctly answered 403 over and over.
 *
 * **This is a state invariant, not a security boundary.** Ownership is decided
 * on the server, by looking the row up and comparing its `userId`; that check
 * is unchanged and must stay the only thing standing between a user and
 * someone else's conversation. What this module does is stop the client from
 * *making* requests it already knows are wrong, and give it a defined way to
 * recover when it discovers one anyway. A string prefix would be a hopeless
 * access control, and it is not used as one.
 */

export const GUEST_CONVERSATION_ID_PREFIX = "guest_";

export type IdentityNamespace =
    /** The session has not resolved yet -- no id may be sent anywhere. */
    | { kind: "unresolved" }
    | { kind: "guest" }
    | { kind: "account"; userId: string };

export const guestNamespace = (): IdentityNamespace => ({ kind: "guest" });

export const accountNamespace = (userId: string): IdentityNamespace => ({
    kind: "account",
    userId,
});

export const resolveIdentityNamespace = (
    status: "loading" | "authenticated" | "unauthenticated" | string,
    userId: string | null | undefined
): IdentityNamespace => {
    if (userId) return accountNamespace(userId);
    if (status === "loading") return { kind: "unresolved" };
    return guestNamespace();
};

/** Stable string form, for comparing "did the identity change?". */
export const identityNamespaceKey = (namespace: IdentityNamespace) =>
    namespace.kind === "account" ? `account:${namespace.userId}` : namespace.kind;

export const isGuestConversationId = (id: string | null | undefined) =>
    typeof id === "string" && id.startsWith(GUEST_CONVERSATION_ID_PREFIX);

export const conversationIdBelongsToIdentity = (
    id: string | null | undefined,
    namespace: IdentityNamespace
) => {
    if (!id) return false;
    if (namespace.kind === "unresolved") return false;
    if (namespace.kind === "guest") return isGuestConversationId(id);
    return !isGuestConversationId(id);
};

export type IdentityTransition = {
    changed: boolean;
    /** True the first time the identity resolves -- nothing to carry over. */
    initial: boolean;
    from: IdentityNamespace | null;
    to: IdentityNamespace;
    /** True when a guest browser just became a signed-in account. */
    guestToAccount: boolean;
    /** True when one account was replaced by a different account. */
    accountSwitch: boolean;
};

export const describeIdentityTransition = (
    previous: IdentityNamespace | null,
    next: IdentityNamespace
): IdentityTransition => {
    const changed =
        previous === null ||
        identityNamespaceKey(previous) !== identityNamespaceKey(next);
    return {
        changed,
        initial: previous === null,
        from: previous,
        to: next,
        guestToAccount:
            previous?.kind === "guest" && next.kind === "account",
        accountSwitch:
            previous?.kind === "account" &&
            next.kind === "account" &&
            previous.userId !== next.userId,
    };
};

/**
 * The selection to keep after an identity change.
 *
 * A guest id was minted by this browser's own guest namespace and by nothing
 * else, so it survives a change that lands back in that namespace (signing
 * out). An account id names a row owned by *some* account, and which one is
 * not knowable from the string -- so it is released on every identity change,
 * including a switch from one account to another. Guessing here would put
 * account A's conversation id on account B's API, which is the mirror image of
 * the guest_* leak and would produce the same 403.
 *
 * Nothing is deleted: this returns only what stays *selected*.
 */
export const selectionAfterIdentityTransition = (
    currentId: string | null,
    transition: IdentityTransition
) => {
    if (!transition.changed) return currentId;
    if (transition.to.kind === "guest") {
        return isGuestConversationId(currentId) ? currentId : null;
    }
    return null;
};

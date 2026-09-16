/**
 * Hands a search hit's target message from the sidebar to the workspace.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8.2.
 *
 * The sidebar opens the conversation through the one selection handler every
 * other entry uses -- which decides the surface, navigates, and checks the
 * lock -- and leaves the message it wants shown here. The workspace reads it
 * once the conversation it names is the one on screen. In memory rather than
 * in the URL: a hit is a click, not an address, so a reload or a shared link
 * opens the conversation at its end as it always has, and there is no query
 * parameter to clean up afterwards.
 *
 * It holds an id and a counter, never text, and nothing here is evidence of
 * access: the server resolves the id only inside a snapshot the viewer can
 * already read.
 */

export type ContinuationFocusHandoff = {
    conversationId: string;
    externalMessageId: string;
    nonce: number;
    /** `Date.now()` when requested; a request that never arrives expires. */
    requestedAt: number;
    /** Whether the workspace has shown the conversation it names. */
    arrived: boolean;
};

/**
 * How long a request may wait for its conversation to open. Long enough for a
 * route change and a lock prompt; short enough that a click which went nowhere
 * does not move a conversation opened much later.
 */
export const CONTINUATION_FOCUS_ARRIVAL_MS = 30_000;

let pending: ContinuationFocusHandoff | null = null;
let counter = 0;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const notify = () => {
    for (const listener of listeners) listener();
};

export function requestContinuationFocus(
    conversationId: string,
    externalMessageId: string,
    options: { alreadyOpen?: boolean } = {}
) {
    counter += 1;
    const nonce = counter;
    pending = {
        conversationId,
        externalMessageId,
        nonce,
        requestedAt: Date.now(),
        arrived: options.alreadyOpen === true,
    };
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    // Expired by the clock, not by the next render: a request that has not
    // arrived by then is dropped even if nothing else happens, so a click that
    // went nowhere cannot move a conversation opened much later.
    expiryTimer = setTimeout(() => {
        expiryTimer = null;
        if (pending?.nonce === nonce && !pending.arrived) clearContinuationFocus();
    }, CONTINUATION_FOCUS_ARRIVAL_MS);
    notify();
}

/** Drops the request, e.g. once the workspace has moved to another conversation. */
export function clearContinuationFocus() {
    if (expiryTimer !== null) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
    }
    if (!pending) return;
    pending = null;
    notify();
}

/**
 * Called whenever the workspace's open conversation changes.
 *
 * Before the request has arrived, a different conversation on screen is the
 * page it is navigating away from, so it is left alone (until it expires).
 * Once it has arrived, leaving its conversation -- for another one or for no
 * conversation at all -- spends it.
 */
export function noteContinuationFocusConversation(conversationId: string | null, now = Date.now()) {
    if (!pending) return;
    // Expiry first: a request older than the arrival window is spent even when
    // its conversation is the one opening now.
    if (!pending.arrived && now - pending.requestedAt > CONTINUATION_FOCUS_ARRIVAL_MS) {
        clearContinuationFocus();
        return;
    }
    if (conversationId !== null && conversationId === pending.conversationId) {
        pending.arrived = true;
        return;
    }
    if (pending.arrived) clearContinuationFocus();
}

export function subscribeContinuationFocus(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function continuationFocusSnapshot(): ContinuationFocusHandoff | null {
    return pending;
}

export function serverContinuationFocusSnapshot(): ContinuationFocusHandoff | null {
    return null;
}

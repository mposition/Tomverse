/**
 * Per-conversation serialized, coalescing sync queue for a conversation's
 * model settings (`selectedModels` / `disabledPanels`).
 *
 * Why this exists (trace 5dc1d2ee-6c98-44fa-8b6f-03d798c3f011,
 * `MODEL_NOT_SELECTED`): the previous client sync debounced a PATCH and, when
 * a newer change arrived, aborted the in-flight fetch. Aborting a fetch only
 * detaches the client from the response -- the server keeps processing the
 * request it already received -- so an older PATCH could commit to the
 * database *after* a newer one, leaving `Conversation.selectedModels` stale
 * while the screen showed the newer selection. The next `/api/chat` request
 * for the newer model was then correctly refused by the server.
 *
 * The queue removes that failure mode structurally:
 *
 *  * PATCHes for one conversation never overlap. A write starts only after
 *    the previous write's response has been observed, so this client cannot
 *    produce out-of-order commits for a conversation.
 *  * In-flight writes are never aborted. A change made while a write is
 *    running is coalesced into `desired` and sent as the immediately next
 *    write.
 *  * `confirmed` is what the server said it stored (the PATCH response's
 *    normalized `selectedModels`/`disabledPanels`), not what the client sent.
 *  * `ensureConfirmed` is the send barrier: it resolves only once the given
 *    snapshot has actually been confirmed by the server -- "no pending
 *    request" is not treated as success.
 *  * Every piece of state is keyed by conversation id, so one conversation's
 *    pending write can neither block, cancel nor overwrite another's.
 */

export type ModelSettingsSnapshot = {
    models: string[];
    disabled: string[];
};

export type ModelSettingsPersistResult =
    | { ok: true; confirmed: ModelSettingsSnapshot }
    | { ok: false; retryable: boolean; traceId?: string };

export type ModelSettingsPersistFn = (
    conversationId: string,
    snapshot: ModelSettingsSnapshot
) => Promise<ModelSettingsPersistResult>;

export type ModelSettingsSyncOutcome =
    | { status: "confirmed"; confirmed: ModelSettingsSnapshot }
    | {
          status: "failed";
          traceId: string;
          confirmed: ModelSettingsSnapshot | null;
      };

export type ModelSettingsSyncQueueOptions = {
    persist: ModelSettingsPersistFn;
    /**
     * How long to sit on a newly desired snapshot before starting its write,
     * so rapid toggles coalesce into one PATCH. `ensureConfirmed` always
     * flushes immediately -- the debounce never delays a send.
     */
    debounceMs?: number;
    /** Delay before the single retry of a retryable failure. */
    retryDelayMs?: number;
    createTraceId?: () => string;
};

type Waiter = {
    revision: number;
    resolve: (outcome: ModelSettingsSyncOutcome) => void;
};

type ConversationSyncState = {
    desired: ModelSettingsSnapshot | null;
    desiredRevision: number;
    confirmed: ModelSettingsSnapshot | null;
    confirmedRevision: number;
    inFlightRevision: number | null;
    pumping: boolean;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    waiters: Waiter[];
};

const cloneSnapshot = (
    snapshot: ModelSettingsSnapshot
): ModelSettingsSnapshot => ({
    models: [...snapshot.models],
    disabled: [...snapshot.disabled],
});

export const modelSettingsSnapshotsEqual = (
    a: ModelSettingsSnapshot | null,
    b: ModelSettingsSnapshot | null
) => {
    if (!a || !b) return a === b;
    return (
        a.models.length === b.models.length &&
        a.models.every((modelId, index) => modelId === b.models[index]) &&
        a.disabled.length === b.disabled.length &&
        a.disabled.every((modelId, index) => modelId === b.disabled[index])
    );
};

const defaultTraceId = () =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const wait = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createModelSettingsSyncQueue(
    options: ModelSettingsSyncQueueOptions
) {
    const debounceMs = options.debounceMs ?? 0;
    const retryDelayMs = options.retryDelayMs ?? 500;
    const createTraceId = options.createTraceId ?? defaultTraceId;
    const states = new Map<string, ConversationSyncState>();

    const stateFor = (conversationId: string): ConversationSyncState => {
        let state = states.get(conversationId);
        if (!state) {
            state = {
                desired: null,
                desiredRevision: 0,
                confirmed: null,
                confirmedRevision: 0,
                inFlightRevision: null,
                pumping: false,
                debounceTimer: null,
                waiters: [],
            };
            states.set(conversationId, state);
        }
        return state;
    };

    const settleWaiters = (
        state: ConversationSyncState,
        upToRevision: number,
        outcome: ModelSettingsSyncOutcome
    ) => {
        const settled = state.waiters.filter(
            (waiter) => waiter.revision <= upToRevision
        );
        state.waiters = state.waiters.filter(
            (waiter) => waiter.revision > upToRevision
        );
        for (const waiter of settled) waiter.resolve(outcome);
    };

    const persistWithOneRetry = async (
        conversationId: string,
        snapshot: ModelSettingsSnapshot
    ): Promise<ModelSettingsPersistResult> => {
        let result: ModelSettingsPersistResult;
        try {
            result = await options.persist(conversationId, snapshot);
        } catch {
            result = { ok: false, retryable: true };
        }
        if (result.ok || !result.retryable) return result;
        if (retryDelayMs > 0) await wait(retryDelayMs);
        try {
            return await options.persist(conversationId, snapshot);
        } catch {
            return { ok: false, retryable: false };
        }
    };

    const pump = async (conversationId: string) => {
        const state = stateFor(conversationId);
        if (state.pumping) return;
        state.pumping = true;
        try {
            while (
                state.desiredRevision > state.confirmedRevision &&
                state.desired
            ) {
                const revision = state.desiredRevision;
                const snapshot = cloneSnapshot(state.desired);
                state.inFlightRevision = revision;
                const result = await persistWithOneRetry(
                    conversationId,
                    snapshot
                );
                state.inFlightRevision = null;
                if (result.ok) {
                    state.confirmed = cloneSnapshot(result.confirmed);
                    state.confirmedRevision = revision;
                    // A newer desired revision keeps the loop going; the
                    // waiters for this and any older revision are done.
                    settleWaiters(state, revision, {
                        status: "confirmed",
                        confirmed: cloneSnapshot(state.confirmed),
                    });
                    if (state.desiredRevision === revision) {
                        state.desired = cloneSnapshot(state.confirmed);
                    }
                } else {
                    const traceId = result.traceId ?? createTraceId();
                    if (state.desiredRevision === revision) {
                        // Abandon the failed snapshot: desired rolls back to
                        // the last server-confirmed state so the queue is not
                        // stuck retrying a write the server refuses. The
                        // caller reverts its screen state from the outcome.
                        state.desired = state.confirmed
                            ? cloneSnapshot(state.confirmed)
                            : null;
                        state.desiredRevision = state.confirmedRevision;
                    }
                    settleWaiters(state, revision, {
                        status: "failed",
                        traceId,
                        confirmed: state.confirmed
                            ? cloneSnapshot(state.confirmed)
                            : null,
                    });
                }
            }
        } finally {
            state.pumping = false;
        }
    };

    const scheduleUnlessPumping = (conversationId: string) => {
        const state = stateFor(conversationId);
        // A running pump re-reads `desired` after each write, so the change
        // is already going to be picked up as the immediately next write.
        if (state.pumping) return;
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
        if (debounceMs <= 0) {
            void pump(conversationId);
            return;
        }
        state.debounceTimer = setTimeout(() => {
            state.debounceTimer = null;
            void pump(conversationId);
        }, debounceMs);
    };

    const enqueue = (
        conversationId: string,
        snapshot: ModelSettingsSnapshot
    ): number => {
        const state = stateFor(conversationId);
        const normalized = cloneSnapshot(snapshot);
        if (
            modelSettingsSnapshotsEqual(state.desired, normalized) &&
            state.desiredRevision > state.confirmedRevision
        ) {
            // Identical to what is already queued -- reuse its revision
            // instead of scheduling a duplicate write.
            scheduleUnlessPumping(conversationId);
            return state.desiredRevision;
        }
        if (
            state.inFlightRevision === null &&
            state.desiredRevision === state.confirmedRevision &&
            modelSettingsSnapshotsEqual(state.confirmed, normalized)
        ) {
            // Already exactly what the server has confirmed.
            return state.desiredRevision;
        }
        state.desired = normalized;
        state.desiredRevision += 1;
        scheduleUnlessPumping(conversationId);
        return state.desiredRevision;
    };

    return {
        /**
         * Records `snapshot` as the conversation's desired server state and
         * schedules (or coalesces into) a serialized write.
         */
        enqueue,

        /**
         * The send barrier. Resolves `confirmed` only once the server has
         * confirmed the given snapshot (or a later one that still confirms
         * it); resolves `failed` when the write permanently failed, carrying
         * the last confirmed state to recover to.
         */
        ensureConfirmed(
            conversationId: string,
            snapshot: ModelSettingsSnapshot
        ): Promise<ModelSettingsSyncOutcome> {
            const state = stateFor(conversationId);
            const revision = enqueue(conversationId, snapshot);
            if (
                revision <= state.confirmedRevision &&
                state.inFlightRevision === null &&
                state.confirmed
            ) {
                return Promise.resolve({
                    status: "confirmed",
                    confirmed: cloneSnapshot(state.confirmed),
                });
            }
            const outcome = new Promise<ModelSettingsSyncOutcome>((resolve) => {
                state.waiters.push({ revision, resolve });
            });
            // A send must not wait out the coalescing debounce.
            if (state.debounceTimer) {
                clearTimeout(state.debounceTimer);
                state.debounceTimer = null;
            }
            void pump(conversationId);
            return outcome;
        },

        /**
         * True while this conversation has a change the server has not
         * confirmed yet (queued or in flight). Used to keep a late-arriving
         * GET response from clobbering newer local state.
         */
        hasUnconfirmedChanges(conversationId: string): boolean {
            const state = states.get(conversationId);
            if (!state) return false;
            return (
                state.inFlightRevision !== null ||
                state.desiredRevision > state.confirmedRevision
            );
        },

        /**
         * Seeds the confirmed state from a server read (conversation create
         * response or detail GET). Ignored while the conversation has
         * unconfirmed local changes -- a stale read must not overwrite them.
         */
        markConfirmed(
            conversationId: string,
            snapshot: ModelSettingsSnapshot
        ): boolean {
            const state = stateFor(conversationId);
            if (
                state.inFlightRevision !== null ||
                state.desiredRevision > state.confirmedRevision
            ) {
                return false;
            }
            state.confirmed = cloneSnapshot(snapshot);
            state.desired = cloneSnapshot(snapshot);
            return true;
        },

        /**
         * Monotonic count of local mutations recorded for this conversation.
         * A reader that captures it before a fetch and finds it changed when
         * the response lands knows the response predates a local change and
         * must not be applied over it -- including the case where the change
         * was already confirmed while the read was still in flight.
         */
        localRevision(conversationId: string): number {
            return states.get(conversationId)?.desiredRevision ?? 0;
        },

        confirmedSnapshot(
            conversationId: string
        ): ModelSettingsSnapshot | null {
            const state = states.get(conversationId);
            return state?.confirmed ? cloneSnapshot(state.confirmed) : null;
        },

        /** Drops all state for a conversation (e.g. after it is deleted). */
        reset(conversationId: string) {
            const state = states.get(conversationId);
            if (state?.debounceTimer) clearTimeout(state.debounceTimer);
            states.delete(conversationId);
        },
    };
}

export type ModelSettingsSyncQueue = ReturnType<
    typeof createModelSettingsSyncQueue
>;

/**
 * CHAT-LATENCY-01: one content-free timing line per chat turn.
 *
 * `RoutingRun`/`RoutingAttempt` hold the same moments, but only when
 * `ROUTING_DISPATCH_INSTRUMENTATION` is `observe` or `enforce`, which is off by
 * default. This event is written on every turn regardless, so a baseline does
 * not wait for that flag, and it carries nothing but identifiers the logs
 * already carry and durations: no prompt, no answer, no attachment name.
 *
 * ## What the numbers are, and what they are not
 *
 * Both are measured on the server, from the moment `handleChatPost` began:
 *
 * - `serverMsToFirstVisibleChunk`: until the first chunk the user can see was
 *   handed to the response stream. Keepalives and routing markers do not
 *   count, because they are stripped before anything is drawn. It is **not**
 *   time-to-first-paint: the network and the client's render come after it,
 *   and a server measurement must not be reported as what the user saw.
 * - `serverMsToSettlement`: until the turn's terminal outcome was decided and
 *   its settlement began. The assistant message write, the closing trailer and
 *   the stream's close come after it, so this is not "the turn was done" --
 *   it is the last moment the route knows on every terminal path, including
 *   cancellation and failure.
 *
 * `outcome` is the turn's settlement outcome, plus `failed_before_stream` for a
 * request that failed before a response stream existed.
 */

export type ChatTurnTimingOutcome =
    | "completed"
    | "cancelled"
    | "failed"
    | "empty"
    | "failed_before_stream";

export type ChatTurnTimingInput = {
    traceId: string;
    modelId: string | null;
    provider: string | null;
    outcome: ChatTurnTimingOutcome;
    requestReceivedAt: number;
    firstVisibleChunkAt: number | null;
    endedAt: number;
};

export const CHAT_TURN_TIMING_EVENT = "chat_turn_timing";

const nonNegative = (value: number) => Math.max(0, Math.round(value));

export const chatTurnTimingEvent = (input: ChatTurnTimingInput) => ({
    event: CHAT_TURN_TIMING_EVENT,
    traceId: input.traceId,
    modelId: input.modelId,
    provider: input.provider,
    outcome: input.outcome,
    firstVisibleChunkSent: input.firstVisibleChunkAt !== null,
    serverMsToFirstVisibleChunk:
        input.firstVisibleChunkAt === null
            ? null
            : nonNegative(input.firstVisibleChunkAt - input.requestReceivedAt),
    serverMsToSettlement: nonNegative(input.endedAt - input.requestReceivedAt),
    timestamp: new Date(input.endedAt).toISOString(),
});

/** Writes the event. Logging never fails the turn it describes. */
export const logChatTurnTiming = (input: ChatTurnTimingInput) => {
    try {
        console.info(JSON.stringify(chatTurnTimingEvent(input)));
    } catch {
        // Diagnostics only.
    }
};

/**
 * ADR v2.1 pre-commit buffer.
 *
 * Withhold the first chunk for a caller-supplied duration so a failure
 * inside that window is still before the commit point. The clock is the
 * instant that chunk became ready to flush, not the start of the request.
 * The duration is not chosen here, and no mode name is mapped to one.
 * Absent is not zero. A held chunk has not been flushed, so it is not the
 * commit point.
 *
 * The column this would store is precommitBufferMs. Nothing here writes
 * it. The request path does not import this module.
 */

const finiteDate = (value: unknown): value is Date =>
    value instanceof Date && Number.isFinite(value.getTime());

const positiveIntegerMs = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= Number.MAX_SAFE_INTEGER;

export type PrecommitBufferDecision = "hold" | "release" | "undecided";

/**
 * Hold, release, or leave the first chunk undecided.
 *
 * `hold` while `now` is strictly before the window ends. `release` once
 * `now` has reached that instant: the caller may flush, and that flush is
 * the commit. `undecided` when the duration is missing, not a positive
 * integer, or either clock is not a finite date. `undecided` is not
 * `release` and it is not `hold`.
 */
export const precommitBufferDecision = (input: {
    bufferMs: unknown;
    chunkReadyAt: unknown;
    now: unknown;
}): PrecommitBufferDecision => {
    if (!positiveIntegerMs(input.bufferMs) || !finiteDate(input.chunkReadyAt) || !finiteDate(input.now)) {
        return "undecided";
    }
    if (input.now.getTime() < input.chunkReadyAt.getTime() + input.bufferMs) return "hold";
    return "release";
};

/** A chunk that is still withheld has not been shown, so it is not a commit. */
export const heldChunkIsCommitPoint = false;

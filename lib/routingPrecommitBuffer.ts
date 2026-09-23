/**
 * ADR v2.1 §10.2.
 *
 * Withhold the first chunk for a caller-supplied duration so a failure
 * inside that window is still before the commit point in §10.1. The
 * duration is not chosen here, and no mode name is mapped to one. Absent
 * is not zero. A held chunk has not been flushed, so it is not the commit
 * point.
 *
 * The column this would store is precommitBufferMs. Nothing here writes
 * it. The request path does not import this module.
 */

const finiteDate = (value: unknown): value is Date =>
    value instanceof Date && Number.isFinite(value.getTime());

/**
 * Whether the first chunk is still withheld.
 *
 * True while `now` is strictly before the window ends. False once `now`
 * has reached that instant: the caller may flush, and that flush is the
 * commit. Null when the duration is missing, not a positive finite number,
 * or either clock is not a finite date. Null is not "flush now" and it is
 * not "hold forever".
 */
export const precommitBufferOpen = (input: {
    bufferMs: unknown;
    startedAt: unknown;
    now: unknown;
}): boolean | null => {
    if (typeof input.bufferMs !== "number" || !Number.isFinite(input.bufferMs) || input.bufferMs <= 0) {
        return null;
    }
    if (!finiteDate(input.startedAt) || !finiteDate(input.now)) return null;
    return input.now.getTime() < input.startedAt.getTime() + input.bufferMs;
};

/** A chunk that is still withheld has not been shown, so it is not a commit. */
export const heldChunkIsCommitPoint = false;

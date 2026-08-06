/**
 * One request per key, however many callers ask for it.
 *
 * The §10 recovery needs this: when a comparison's context goes stale, every
 * panel in the run is refused at nearly the same moment, and each one asks for
 * a fresh context. Three preparations would defeat the point — the panels are
 * supposed to end up on *one* snapshot, and three calls would produce three.
 *
 * So the first caller runs the factory and the rest await the same promise.
 * The result is then kept, not recomputed: a caller that arrives after the
 * preparation finished gets the same bundle its siblings already have, which
 * is what makes "the run re-prepared once" true rather than approximately
 * true.
 *
 * A rejection is not cached. A failed preparation is a transient fact about
 * the network, and remembering it would turn one bad moment into a permanent
 * refusal for that key.
 */
export type SharedPendingRequest<T> = {
    run: (key: string, factory: () => Promise<T>) => Promise<T>;
    /** Forgets a key, so the next caller runs the factory again. */
    forget: (key: string) => void;
    /** How many times the factory has actually run, for tests and metrics. */
    runCount: () => number;
};

export function createSharedPendingRequest<T>(): SharedPendingRequest<T> {
    const inFlight = new Map<string, Promise<T>>();
    let runCount = 0;

    return {
        run(key, factory) {
            const existing = inFlight.get(key);
            if (existing) return existing;
            runCount += 1;
            const pending = factory().catch((error) => {
                // Only a failure is dropped: a resolved value is the shared
                // answer and has to stay shared.
                inFlight.delete(key);
                throw error;
            });
            inFlight.set(key, pending);
            return pending;
        },
        forget(key) {
            inFlight.delete(key);
        },
        runCount: () => runCount,
    };
}

import { type AmuxInfraFailureKind, amuxInfraFailureKindOfReason } from "./infraFailureCore.ts";

/**
 * A worker that keeps failing on the platform is taken out of assignment for
 * a while, then tried again (owner decision 2026-11-15).
 *
 * Production 2026-11-15: the two Cursor workers exited at once on every run
 * (their usage had expired), and each new card went to them and failed the
 * same way. The state is derived, never stored: it is read from the worker's
 * own most recent ended attempts, so it heals itself and needs no clean-up.
 *
 * - closed: fewer than AMUX_WORKER_CIRCUIT_THRESHOLD infrastructure failures
 *   in a row (lib/amux/infraFailureCore.ts). The worker takes work.
 * - open: that many or more. The worker takes no work until `retryAtMs`,
 *   which doubles with each further failure, from five minutes to an hour.
 * - probing: the wait is over, or the worker's usage was observed again after
 *   its last failure (its sign-in works again). It may take one card; one more
 *   failure opens it again for longer, any other ending closes it.
 *
 * Pure and dependency-free.
 */

export const AMUX_WORKER_CIRCUIT_THRESHOLD = 3;
export const AMUX_WORKER_CIRCUIT_BASE_MS = 5 * 60_000;
export const AMUX_WORKER_CIRCUIT_MAX_MS = 60 * 60_000;
/** How many of a worker's latest ended attempts the state is read from. */
export const AMUX_WORKER_CIRCUIT_HISTORY = 12;

export type AmuxWorkerCircuit =
  | { state: "closed"; consecutive: number; lastKind: AmuxInfraFailureKind | null }
  | { state: "open"; consecutive: number; lastKind: AmuxInfraFailureKind;
      lastAtMs: number; retryAtMs: number }
  | { state: "probing"; consecutive: number; lastKind: AmuxInfraFailureKind;
      lastAtMs: number; why: "timer" | "usage_observed" };

export const AMUX_WORKER_CIRCUIT_CLOSED: AmuxWorkerCircuit =
  Object.freeze({ state: "closed", consecutive: 0, lastKind: null });

/** The wait after `consecutive` infrastructure failures in a row. */
export function amuxWorkerCircuitWaitMs(consecutive: number): number {
  const over = Math.max(0, Math.trunc(consecutive) - AMUX_WORKER_CIRCUIT_THRESHOLD);
  return Math.min(AMUX_WORKER_CIRCUIT_MAX_MS, AMUX_WORKER_CIRCUIT_BASE_MS * 2 ** Math.min(over, 10));
}

export function amuxWorkerCircuit(input: {
  /** The worker's latest ended attempts, newest first. */
  recent: ReadonlyArray<{ reason: string | null; endedAtMs: number }>;
  /** When the worker's usage was last observed with work left; null when never. */
  usageObservedAtMs: number | null;
  nowMs: number;
}): AmuxWorkerCircuit {
  let consecutive = 0;
  let lastKind: AmuxInfraFailureKind | null = null;
  let lastAtMs = 0;
  for (const attempt of input.recent) {
    const kind = amuxInfraFailureKindOfReason(attempt.reason);
    if (!kind) break;
    if (consecutive === 0) { lastKind = kind; lastAtMs = attempt.endedAtMs; }
    consecutive += 1;
  }
  if (consecutive < AMUX_WORKER_CIRCUIT_THRESHOLD || lastKind === null)
    return { state: "closed", consecutive, lastKind };
  // A sign-in that reads its usage again is worth one early try, twice at
  // most: a worker whose usage reads fine but whose runs still fail would
  // otherwise be tried at every five-minute reading.
  if (input.usageObservedAtMs !== null && input.usageObservedAtMs > lastAtMs &&
      consecutive < AMUX_WORKER_CIRCUIT_THRESHOLD + 2)
    return { state: "probing", consecutive, lastKind, lastAtMs, why: "usage_observed" };
  const retryAtMs = lastAtMs + amuxWorkerCircuitWaitMs(consecutive);
  if (input.nowMs >= retryAtMs)
    return { state: "probing", consecutive, lastKind, lastAtMs, why: "timer" };
  return { state: "open", consecutive, lastKind, lastAtMs, retryAtMs };
}

/** Whether the claim may assign the worker a card. */
export const amuxWorkerCircuitAdmits = (circuit: AmuxWorkerCircuit | undefined) =>
  circuit?.state !== "open";

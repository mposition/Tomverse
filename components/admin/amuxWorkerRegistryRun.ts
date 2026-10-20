import type { AdminApiFailure } from "@/lib/adminApiOutcome";
import {
  AMUX_WORKER_REGISTRY_REFUSALS,
  type AmuxWorkerDesiredState,
  type AmuxWorkerRegistryAdminView,
  type AmuxWorkerRoleCeiling,
  type AmuxWorkerSeedEntry,
} from "@/lib/amux/workerRegistryCore";

/**
 * The requests behind AMUX › Operations settings › Workers, as plain
 * functions so a test can drive them with a fake io. Each change is sent
 * once. Only a receipt that names this very change lets a run go on; a
 * refusal or a pre-transaction status wrote nothing and stops; any other
 * answer may have written, so nothing more is sent and the registry is read
 * again before anything is released (foundation principle 7).
 */

/** What is in flight: how far a run is, a read, or nothing. */
export type AmuxWorkerRegistryPending = { done: number; total: number } | "reading" | null;

/**
 * How the last run ended. `unread`: it ended, but the registry could not be
 * read again, so the screen shows no list at all.
 */
export type AmuxWorkerRegistryNotice = "done" | "stopped" | "outcome_unknown" | "unread" | null;

export type AmuxWorkerRegistryRefusal = { workerName: string; code: string } | null;

/** One change of a worker's desired state or role ceiling, against the revision the person saw. */
export type AmuxWorkerChangeRequest = {
  workerName: string;
  roleCeiling: AmuxWorkerRoleCeiling;
  desiredState: AmuxWorkerDesiredState;
  expectedRevision: number;
};

/** One step of a run or a read, applied to the screen's state in order. */
export type AmuxWorkerRegistryUpdate = Partial<{
  pending: AmuxWorkerRegistryPending;
  notice: AmuxWorkerRegistryNotice;
  refusal: AmuxWorkerRegistryRefusal;
  failure: AdminApiFailure | null;
  view: AmuxWorkerRegistryAdminView | null;
}>;

export type AmuxWorkerRegistryIo = {
  post: (request: AmuxWorkerChangeRequest) => Promise<Response>;
  /** The view as the route answers it now, or `null` when it cannot be read. */
  read: () => Promise<AmuxWorkerRegistryAdminView | null>;
  failureOf: (response: Response) => Promise<AdminApiFailure>;
  networkFailure: () => AdminApiFailure;
};

/**
 * Statuses the route answers before its transaction starts (a bad or
 * oversized body, no session or role, a stale step-up, the rate limit), or
 * that a proxy answers without reaching it. Nothing was written.
 */
const NO_WRITE_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 413, 428, 429]);

/** The route's own 409s: the code latch and the change rule. Nothing was written. */
export const AMUX_WORKER_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "registry_writes_off",
  ...AMUX_WORKER_REGISTRY_REFUSALS,
]);

const refusalError = async (response: Response): Promise<unknown> => {
  try {
    const body = (await response.clone().json()) as { error?: unknown } | null;
    return body?.error ?? null;
  } catch {
    return null;
  }
};

/**
 * A 2xx proves only what its body says: the receipt of this very change, at
 * the next revision. A body that broke off, does not parse, or names anything
 * else is not a success -- the change may or may not have been recorded.
 */
const isChangeReceipt = async (response: Response, request: AmuxWorkerChangeRequest): Promise<boolean> => {
  try {
    const body = (await response.json()) as Record<string, unknown> | null;
    return (
      body !== null &&
      typeof body === "object" &&
      body.workerName === request.workerName &&
      body.revision === request.expectedRevision + 1 &&
      body.action === (request.expectedRevision === 0 ? "amux.worker.register" : "amux.worker.change") &&
      typeof body.eventId === "string" &&
      body.eventId.length > 0
    );
  } catch {
    return false;
  }
};

/**
 * Sends the given changes one by one, each once. Whatever happened, the
 * registry is read again before anything is released, and the next run
 * starts from what that read shows.
 */
async function runChanges(
  requests: readonly AmuxWorkerChangeRequest[],
  io: AmuxWorkerRegistryIo,
  update: (changes: AmuxWorkerRegistryUpdate) => void,
): Promise<void> {
  update({ pending: { done: 0, total: requests.length }, notice: null, refusal: null, failure: null });
  try {
    let outcome: "done" | "stopped" | "outcome_unknown" = "done";
    for (const [index, request] of requests.entries()) {
      let response: Response;
      try {
        response = await io.post(request);
      } catch {
        update({ failure: io.networkFailure() });
        outcome = "outcome_unknown";
        break;
      }
      if (response.ok) {
        if (await isChangeReceipt(response, request)) {
          update({ pending: { done: index + 1, total: requests.length } });
          continue;
        }
        outcome = "outcome_unknown";
        break;
      }
      const error = await refusalError(response);
      if (response.status === 409 && typeof error === "string" && AMUX_WORKER_REFUSAL_CODES.has(error)) {
        update({ refusal: { workerName: request.workerName, code: error } });
        outcome = "stopped";
      } else if (NO_WRITE_STATUSES.has(response.status) || response.status === 409 ||
                 (response.status === 503 && error === "registry_change_failed")) {
        update({ failure: await io.failureOf(response) });
        outcome = "stopped";
      } else {
        outcome = "outcome_unknown";
      }
      break;
    }
    update({ pending: "reading" });
    const view = await io.read();
    update({ view, notice: view === null ? "unread" : outcome });
  } finally {
    update({ pending: null });
  }
}

/** Registers the given seed entries one by one, each with revision 0. */
export function runAmuxWorkerSeedRegistration(
  entries: readonly AmuxWorkerSeedEntry[],
  io: AmuxWorkerRegistryIo,
  update: (changes: AmuxWorkerRegistryUpdate) => void,
): Promise<void> {
  return runChanges(entries.map((entry) => ({ ...entry, expectedRevision: 0 })), io, update);
}

/** Turns one worker on, off or back on: one change against the revision the person saw. */
export function runAmuxWorkerStateChange(
  request: AmuxWorkerChangeRequest,
  io: AmuxWorkerRegistryIo,
  update: (changes: AmuxWorkerRegistryUpdate) => void,
): Promise<void> {
  return runChanges([request], io, update);
}

/** Reading the registry again on request; a failed read leaves no view. */
export async function runAmuxWorkerRegistryReread(
  io: Pick<AmuxWorkerRegistryIo, "read">,
  update: (changes: AmuxWorkerRegistryUpdate) => void,
): Promise<void> {
  update({ pending: "reading", failure: null });
  try {
    const view = await io.read();
    update(view === null ? { view } : { view, notice: null, refusal: null });
  } finally {
    update({ pending: null });
  }
}

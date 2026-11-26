import { randomUUID } from "node:crypto";
import {
  emptyManagedCodeView, reservationState, type DesktopManagedCodeInput, type ManagedCatalogSnapshot, type ManagedCodeModel,
  type ManagedCodeView, type ManagedReceipt, type ManagedRefusal, type ManagedReservationView, type ManagedTerminalReason,
} from "../managed-code-contract";
import type { ManagedCodeClient, ManagedOutcome } from "./managed-code-client";

const MIN_HEARTBEAT_MS = 1_000;
// The server's lease is 120 seconds; a keep-alive slower than half of that could let a healthy task lapse.
const MAX_HEARTBEAT_MS = 60_000;
const LOST_AFTER_MISSES = 2;

type Reserve = Extract<DesktopManagedCodeInput, { action: "reserve" }>;
export type ManagedTimer = (run: () => void, ms: number) => () => void;
const defaultTimer: ManagedTimer = (run, ms) => {
  const handle = setTimeout(run, ms);
  handle.unref?.();
  return () => clearTimeout(handle);
};

const modelView = (catalog: ManagedCatalogSnapshot): ManagedCodeModel[] => catalog.models
  .filter((row) => row.channels.includes("code") && row.capabilities.structuredOutput !== "none")
  .map((row) => ({ id: row.modelId, name: row.name, provider: row.provider, minimumPlan: row.minimumPlan }));

/**
 * The one managed reservation this window holds, kept alive while the app runs.
 *
 * It holds credits and nothing else: no model call is made here. Every number comes from a server receipt. The keep-alive
 * message runs in the main process so a closed settings page does not let the reservation lapse; if the app stops, the
 * server's own lease returns the unused credits.
 */
export function createManagedCodeSession(deps: {
  client: ManagedCodeClient; signal: AbortSignal; timer?: ManagedTimer; newTaskId?: () => string;
}) {
  const timer = deps.timer ?? defaultTimer;
  const newTaskId = deps.newTaskId ?? randomUUID;
  let catalog: ManagedCatalogSnapshot | null = null;
  let reservation: ManagedReservationView | null = null;
  let refusal: ManagedRefusal | null = null;
  let misses = 0;
  let stopBeat: (() => void) | undefined;
  // The same request keeps its task id, so sending it again after a lost answer cannot hold credits twice.
  let attempt: { key: string; taskId: string } | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  // Heartbeat, release and reserve change the same reservation; one at a time keeps a late answer from undoing a newer one.
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  const view = (): ManagedCodeView => ({
    catalog: catalog ? { version: catalog.version, models: modelView(catalog) } : null,
    reservation: reservation ? { ...reservation } : null,
    refusal,
  });
  const stop = () => { stopBeat?.(); stopBeat = undefined; };
  deps.signal.addEventListener("abort", stop, { once: true });

  function adopt(receipt: ManagedReceipt, endedBy?: ManagedTerminalReason) {
    const { executor, reviewer } = receipt.modelPair;
    const ended = endedBy ?? reservation?.endedBy;
    reservation = {
      id: receipt.reservationId, state: reservationState(receipt.state),
      executor: { id: executor.modelId, name: executor.name, provider: executor.provider },
      reviewer: { id: reviewer.modelId, name: reviewer.name, provider: reviewer.provider },
      billing: receipt.billing, heartbeat: "ok", ...(ended ? { endedBy: ended } : {}),
    };
    if (reservation.state !== "active") stop();
  }

  function schedule(intervalMs: number) {
    stop();
    const wait = Math.min(MAX_HEARTBEAT_MS, Math.max(MIN_HEARTBEAT_MS, intervalMs));
    stopBeat = timer(() => { void exclusive(beat).catch(() => {}); }, wait);
  }

  /** The server no longer holds the reservation as active; its record, not this window's, says what happened to the credits. */
  async function resync() {
    if (!reservation) return;
    const closed = await deps.client.status(reservation.id);
    if (deps.signal.aborted || !reservation) return;
    if (closed.kind === "ok") adopt(closed.value);
    else { reservation = { ...reservation, state: "interrupted" }; stop(); }
  }

  async function beat() {
    if (deps.signal.aborted || !reservation || reservation.state !== "active") return;
    const outcome = await deps.client.heartbeat(reservation.id);
    if (deps.signal.aborted || !reservation) return;
    if (outcome.kind === "ok") {
      misses = 0;
      adopt(outcome.value);
      if (reservation.state === "active") schedule(outcome.value.heartbeatIntervalMs);
      return;
    }
    if (outcome.kind === "refused" && (outcome.reason === "notFound" || outcome.reason === "notActive")) {
      await resync();
      return;
    }
    misses += 1;
    if (misses >= LOST_AFTER_MISSES) reservation = { ...reservation, heartbeat: "lost" };
    schedule(MIN_HEARTBEAT_MS * 5);
  }

  async function loadCatalog(): Promise<ManagedOutcome<ManagedCatalogSnapshot>> {
    const outcome = await deps.client.catalog();
    if (outcome.kind === "ok") catalog = outcome.value;
    return outcome;
  }

  const refuse = (reason: ManagedRefusal) => { refusal = reason; };

  async function read() {
    if (!catalog) {
      const outcome = await loadCatalog();
      if (outcome.kind === "ok") refusal = null;
      else if (!reservation) refuse(outcome.kind === "refused" ? outcome.reason : "unreachable");
    }
    return view();
  }

  async function reserve(input: Reserve) {
    refusal = null;
    if (reservation?.state === "active") { refuse("alreadyReserved"); return view(); }
    if (!catalog) {
      const loaded = await loadCatalog();
      if (loaded.kind !== "ok") { refuse(loaded.kind === "refused" ? loaded.reason : "unreachable"); return view(); }
    }
    const pinned = catalog!;
    // Only models the list offers: the same ones the person could pick.
    const rows = new Map(modelView(pinned).map((row) => [row.id, row]));
    const executor = rows.get(input.executorModelId), reviewer = rows.get(input.reviewerModelId);
    if (!executor || !reviewer) { refuse("catalog"); return view(); }
    if (executor.provider === reviewer.provider) { refuse("sameProvider"); return view(); }
    const key = [pinned.version, pinned.contentHash, input.executorModelId, input.reviewerModelId, input.approvedCredits].join("|");
    if (attempt?.key !== key) attempt = { key, taskId: newTaskId() };
    const outcome = await deps.client.reserve({
      taskId: attempt.taskId, catalogVersion: pinned.version, contentHash: pinned.contentHash,
      executorModelId: input.executorModelId, reviewerModelId: input.reviewerModelId, approvedCredits: input.approvedCredits,
    });
    if (deps.signal.aborted) return view();
    if (outcome.kind === "ok") {
      attempt = undefined;
      misses = 0;
      adopt(outcome.value);
      schedule(outcome.value.heartbeatIntervalMs);
      return view();
    }
    if (outcome.kind === "unreachable") { refuse("unreachable"); return view(); }
    // A refusal is an answer: the next try is a new decision, and a changed catalogue is read again before it.
    attempt = undefined;
    if (outcome.reason === "catalog") catalog = null;
    refuse(outcome.reason);
    return view();
  }

  async function release(reason: Extract<ManagedTerminalReason, "completed" | "cancelled">) {
    refusal = null;
    if (!reservation || reservation.state !== "active") return view();
    const outcome = await deps.client.release(reservation.id, reason);
    if (deps.signal.aborted) return view();
    if (outcome.kind === "ok") { adopt(outcome.value, reason); return view(); }
    // Not released: the keep-alive goes on, so the reservation is neither dropped here nor left to lapse by accident.
    if (outcome.kind === "refused" && (outcome.reason === "notFound" || outcome.reason === "notActive")) await resync();
    else refuse(outcome.kind === "refused" ? outcome.reason : "unreachable");
    return view();
  }

  return {
    view,
    stop,
    run(input: DesktopManagedCodeInput): Promise<ManagedCodeView> {
      return exclusive(async () => {
        if (deps.signal.aborted) return emptyManagedCodeView;
        switch (input.action) {
          case "read": return read();
          case "reserve": return reserve(input);
          case "release": return release(input.reason);
          case "dismiss":
            if (reservation && reservation.state !== "active") reservation = null;
            refusal = null;
            return view();
        }
      });
    },
  };
}

export type ManagedCodeSession = ReturnType<typeof createManagedCodeSession>;

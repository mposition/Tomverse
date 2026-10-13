"use client";

import { useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import {
  adminNetworkFailure,
  readAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxWorkerCapabilityMessages } from "@/lib/adminMessages/amuxWorkerCapability";
import {
  AMUX_WORKER_CAPABILITY_REFUSALS,
  amuxWorkerCapabilityImportsToWrite,
  parseAmuxWorkerCapabilityAdminView,
  type AmuxWorkerCapability,
  type AmuxWorkerCapabilityAdminView,
} from "@/lib/amux/workerCapabilityCore";

const CAPABILITY_PATH = "/api/admin/amux/workers/capabilities";

type Messages = (typeof adminAmuxWorkerCapabilityMessages)["en"];

export type AmuxWorkerCapabilityImport = { workerName: string; expectedRevision: number; capability: AmuxWorkerCapability };
export type AmuxWorkerCapabilityPending = { done: number; total: number } | "reading" | null;
export type AmuxWorkerCapabilityNotice = "done" | "stopped" | "outcome_unknown" | "unread" | null;
export type AmuxWorkerCapabilityRefusalNotice = { workerName: string; code: string } | null;

const cellClass = "border-b border-zinc-200 px-2 py-2 align-top dark:border-zinc-700";
const headClass = `${cellClass} text-xs font-semibold text-zinc-600 dark:text-zinc-400`;
const buttonClass =
  "inline-flex min-h-11 items-center rounded-md border border-zinc-400 px-3 py-1 text-xs font-bold disabled:opacity-60 dark:border-zinc-500";

const describe = (m: Messages, capability: AmuxWorkerCapability | null) => {
  if (capability === null) return m.none;
  const parts = [`${m.tags}: ${capability.routingTags.join(", ")}`];
  if (capability.model) parts.push(`${m.model}: ${capability.model}`);
  if (capability.v22) parts.push(`${m.v22}: ${capability.v22.roles.join(", ")} (${capability.v22.tools.join(", ")}, ${capability.v22.model})`);
  return parts.join(" · ");
};

/**
 * The capability section of AMUX › Execution › Workers, without hooks, so a
 * test can call it and read the tree it returns. The import control is the
 * owner's only, enabled only with the code latch on, something left to import
 * and nothing in flight.
 */
export function AmuxWorkerCapabilityView({
  m,
  view,
  isOwner,
  pending,
  notice,
  refusal,
  failure,
  onImport,
  onReread,
}: {
  m: Messages;
  view: AmuxWorkerCapabilityAdminView | null;
  isOwner: boolean;
  pending: AmuxWorkerCapabilityPending;
  notice: AmuxWorkerCapabilityNotice;
  refusal: AmuxWorkerCapabilityRefusalNotice;
  failure: AdminApiFailure | null;
  onImport: (imports: AmuxWorkerCapabilityImport[]) => void;
  onReread: () => void;
}) {
  const imports = view === null ? [] : amuxWorkerCapabilityImportsToWrite(view);
  const busy = pending !== null;
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4" data-testid="amux-worker-capability-panel">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{m.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.description}</p>
      {view === null ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-700 dark:text-red-300" data-testid="amux-worker-capability-unavailable">
            {m.unavailable}
          </p>
          <button type="button" className={`${buttonClass} w-fit`} disabled={busy} onClick={onReread} data-testid="amux-worker-capability-reread">
            {pending === "reading" ? m.reading : m.reread}
          </button>
        </div>
      ) : (
        <>
          <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="amux-worker-capability-latch">
            {view.writesLatch ? m.writesOn : m.writesOff}
          </p>
          {view.catalogReadable ? null : (
            <p role="alert" className="text-sm text-amber-700 dark:text-amber-300" data-testid="amux-worker-capability-catalog-unreadable">
              {m.catalogUnreadable}
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm text-zinc-900 dark:text-zinc-100">
              <thead>
                <tr>
                  <th scope="col" className={headClass}>{m.column.worker}</th>
                  <th scope="col" className={headClass}>{m.column.ceiling}</th>
                  <th scope="col" className={headClass}>{m.column.current}</th>
                  <th scope="col" className={headClass}>{m.column.proposed}</th>
                  <th scope="col" className={headClass}>{m.column.status}</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.workerName} data-testid={`amux-worker-capability-row-${row.workerName}`}>
                    <th scope="row" className={`${cellClass} font-mono text-xs`}>{row.workerName}</th>
                    <td className={cellClass}>{row.roleCeiling}</td>
                    <td className={cellClass}>{describe(m, row.current?.capability ?? null)}</td>
                    <td className={cellClass}>{describe(m, row.proposed)}</td>
                    <td className={cellClass} data-testid={`amux-worker-capability-status-${row.workerName}`}>
                      {row.proposed === null ? m.status.none : row.refusal ? m.status.refused(row.refusal) : row.same ? m.status.same : m.status.ready}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {isOwner ? (
            <div className="flex flex-col gap-2" data-testid="amux-worker-capability-import">
              <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.importTitle}</h3>
              <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.importHelp}</p>
              {imports.length === 0 ? (
                <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.importNothing}</p>
              ) : (
                <button
                  type="button"
                  className={`${buttonClass} w-fit`}
                  disabled={busy || !view.writesLatch}
                  onClick={() => onImport(imports)}
                  data-testid="amux-worker-capability-import-run"
                >
                  {pending !== null && pending !== "reading" ? m.importRunning(pending.done, pending.total) : m.importRun(imports.length)}
                </button>
              )}
            </div>
          ) : null}
        </>
      )}
      {notice === "done" ? <p role="status" className="text-sm" data-testid="amux-worker-capability-done">{m.importDone}</p> : null}
      {notice === "stopped" ? <p role="status" className="text-sm" data-testid="amux-worker-capability-stopped">{m.importStopped}</p> : null}
      {notice === "outcome_unknown" ? (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-300" data-testid="amux-worker-capability-outcome-unknown">{m.importOutcomeUnknown}</p>
      ) : null}
      {notice === "unread" ? (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-300" data-testid="amux-worker-capability-run-unread">{m.importUnread}</p>
      ) : null}
      {refusal ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300" data-testid="amux-worker-capability-refused">
          {m.importRefused(refusal.workerName, refusal.code)}
        </p>
      ) : null}
      {failure ? <AdminApiFailureNotice failure={failure} /> : null}
    </section>
  );
}

export type AmuxWorkerCapabilityUpdate = Partial<{
  pending: AmuxWorkerCapabilityPending;
  notice: AmuxWorkerCapabilityNotice;
  refusal: AmuxWorkerCapabilityRefusalNotice;
  failure: AdminApiFailure | null;
  view: AmuxWorkerCapabilityAdminView | null;
}>;

export type AmuxWorkerCapabilityIo = {
  post: (entry: AmuxWorkerCapabilityImport) => Promise<Response>;
  read: () => Promise<AmuxWorkerCapabilityAdminView | null>;
  failureOf: (response: Response) => Promise<AdminApiFailure>;
  networkFailure: () => AdminApiFailure;
};

const NO_WRITE_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 413, 428, 429]);
const REFUSAL_CODES: ReadonlySet<string> = new Set([
  "capability_writes_off",
  "stale_revision",
  "unreadable_registry",
  ...AMUX_WORKER_CAPABILITY_REFUSALS,
]);

const refusalError = async (response: Response): Promise<unknown> => {
  try {
    const body = (await response.clone().json()) as { error?: unknown } | null;
    return body?.error ?? null;
  } catch {
    return null;
  }
};

/** A 2xx proves only what its body says: this worker's capability at the next revision. */
const isCapabilityReceipt = async (response: Response, entry: AmuxWorkerCapabilityImport): Promise<boolean> => {
  try {
    const body = (await response.json()) as Record<string, unknown> | null;
    return (
      body !== null &&
      typeof body === "object" &&
      body.workerName === entry.workerName &&
      body.revision === entry.expectedRevision + 1 &&
      body.action === "amux.worker.capability" &&
      typeof body.eventId === "string" &&
      body.eventId.length > 0
    );
  } catch {
    return false;
  }
};

/**
 * Records the given imports one by one, each sent once. Only a verified
 * receipt lets the run go on. A refusal or a pre-transaction status wrote
 * nothing and stops the run; any other answer may have written, so nothing
 * more is sent (foundation principle 7). The capabilities are read again
 * before anything is released.
 */
export async function runAmuxWorkerCapabilityImport(
  imports: readonly AmuxWorkerCapabilityImport[],
  io: AmuxWorkerCapabilityIo,
  update: (changes: AmuxWorkerCapabilityUpdate) => void,
): Promise<void> {
  update({ pending: { done: 0, total: imports.length }, notice: null, refusal: null, failure: null });
  try {
    let outcome: "done" | "stopped" | "outcome_unknown" = "done";
    for (const [index, entry] of imports.entries()) {
      let response: Response;
      try {
        response = await io.post(entry);
      } catch {
        update({ failure: io.networkFailure() });
        outcome = "outcome_unknown";
        break;
      }
      if (response.ok) {
        if (await isCapabilityReceipt(response, entry)) {
          update({ pending: { done: index + 1, total: imports.length } });
          continue;
        }
        outcome = "outcome_unknown";
        break;
      }
      const error = await refusalError(response);
      if (response.status === 409 && typeof error === "string" && REFUSAL_CODES.has(error)) {
        update({ refusal: { workerName: entry.workerName, code: error } });
        outcome = "stopped";
      } else if (NO_WRITE_STATUSES.has(response.status) || response.status === 409 ||
                 (response.status === 503 && error === "capability_change_failed")) {
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

export async function runAmuxWorkerCapabilityReread(
  io: Pick<AmuxWorkerCapabilityIo, "read">,
  update: (changes: AmuxWorkerCapabilityUpdate) => void,
): Promise<void> {
  update({ pending: "reading", failure: null });
  try {
    const view = await io.read();
    update(view === null ? { view } : { view, notice: null, refusal: null });
  } finally {
    update({ pending: null });
  }
}

/**
 * The view with its requests. A capability write needs the owner role, R2a's
 * code latch and a recent step-up, all checked by the route; a stale step-up
 * is answered 428 and rendered with the way back (`AdminApiFailureNotice`,
 * docs/ui-contracts/admin-console-ia.md rule 7).
 */
export function AmuxWorkerCapabilityPanel({ view, isOwner }: { view: AmuxWorkerCapabilityAdminView | null; isOwner: boolean }) {
  const m = useAdminMessages(adminAmuxWorkerCapabilityMessages) as Messages;
  const { locale } = useAdminLocale();
  const [current, setCurrent] = useState<AmuxWorkerCapabilityAdminView | null>(view);
  const [pending, setPending] = useState<AmuxWorkerCapabilityPending>(null);
  const [notice, setNotice] = useState<AmuxWorkerCapabilityNotice>(null);
  const [refusal, setRefusal] = useState<AmuxWorkerCapabilityRefusalNotice>(null);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);

  const apply = (changes: AmuxWorkerCapabilityUpdate) => {
    if ("view" in changes) setCurrent(changes.view ?? null);
    if ("notice" in changes) setNotice(changes.notice ?? null);
    if ("refusal" in changes) setRefusal(changes.refusal ?? null);
    if ("failure" in changes) setFailure(changes.failure ?? null);
    if ("pending" in changes) setPending(changes.pending ?? null);
  };

  const io: AmuxWorkerCapabilityIo = {
    post: (entry) =>
      adminFetch(CAPABILITY_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry),
      }),
    read: async () => {
      try {
        const response = await adminFetch(CAPABILITY_PATH, { method: "GET" });
        return response.ok ? parseAmuxWorkerCapabilityAdminView(await response.json().catch(() => null)) : null;
      } catch {
        return null;
      }
    },
    failureOf: (response) => readAdminApiFailure(response, { fallback: m.changeFailed, locale }),
    networkFailure: () => adminNetworkFailure(locale),
  };

  return (
    <AmuxWorkerCapabilityView
      m={m}
      view={current}
      isOwner={isOwner}
      pending={pending}
      notice={notice}
      refusal={refusal}
      failure={failure}
      onImport={(imports) => void runAmuxWorkerCapabilityImport(imports, io, apply)}
      onReread={() => void runAmuxWorkerCapabilityReread(io, apply)}
    />
  );
}

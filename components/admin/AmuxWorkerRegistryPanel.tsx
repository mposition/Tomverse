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
import { adminAmuxWorkerRegistryMessages } from "@/lib/adminMessages/amuxWorkerRegistry";
import {
  AMUX_WORKER_REGISTRY_REFUSALS,
  amuxWorkerSeedEntriesToRegister,
  parseAmuxWorkerRegistryAdminView,
  type AmuxWorkerRegistryAdminView,
  type AmuxWorkerSeedEntry,
} from "@/lib/amux/workerRegistryCore";

const REGISTRY_PATH = "/api/admin/amux/workers";

type Messages = (typeof adminAmuxWorkerRegistryMessages)["en"];

/** What is in flight: a registration run (how far it is), a read, or nothing. */
export type AmuxWorkerRegistryPending = { done: number; total: number } | "reading" | null;

/**
 * How the last registration run ended. `unread`: it ended, but the registry
 * could not be read again, so the screen shows no registry at all.
 */
export type AmuxWorkerRegistryNotice =
  | "done"
  | "stopped"
  | "outcome_unknown"
  | "unread"
  | null;

export type AmuxWorkerRegistryRefusal = { workerName: string; code: string } | null;

const cellClass = "border-b border-zinc-200 px-2 py-2 align-top dark:border-zinc-700";
const headClass = `${cellClass} text-xs font-semibold text-zinc-600 dark:text-zinc-400`;
const buttonClass =
  "inline-flex min-h-11 items-center rounded-md border border-zinc-400 px-3 py-1 text-xs font-bold disabled:opacity-60 dark:border-zinc-500";

const brisbaneTime = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Brisbane",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * AMUX › Execution › Workers, without hooks, so a test can call it and read
 * the tree it returns.
 *
 * `view` is what was last read, or `null` when nothing current is known. With
 * no view nothing can be registered: the only control is reading it again. The
 * registration control is shown to the owner only, and enabled only when the
 * code latch is on, something is left to register and nothing is in flight.
 */
export function AmuxWorkerRegistryView({
  m,
  view,
  isOwner,
  pending,
  notice,
  refusal,
  failure,
  onRegister,
  onReread,
}: {
  m: Messages;
  view: AmuxWorkerRegistryAdminView | null;
  isOwner: boolean;
  pending: AmuxWorkerRegistryPending;
  notice: AmuxWorkerRegistryNotice;
  refusal: AmuxWorkerRegistryRefusal;
  failure: AdminApiFailure | null;
  onRegister: (entries: AmuxWorkerSeedEntry[]) => void;
  onReread: () => void;
}) {
  const toRegister = view === null ? [] : amuxWorkerSeedEntriesToRegister(view);
  const busy = pending !== null;
  return (
    <section
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4"
      data-testid="amux-worker-registry-panel"
    >
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{m.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.description}</p>
      {view === null ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-700 dark:text-red-300" data-testid="amux-worker-registry-unavailable">
            {m.unavailable}
          </p>
          <button
            type="button"
            className={`${buttonClass} w-fit`}
            disabled={busy}
            onClick={onReread}
            data-testid="amux-worker-registry-reread"
          >
            {pending === "reading" ? m.reading : m.reread}
          </button>
        </div>
      ) : (
        <>
          <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="amux-worker-registry-latch">
            {view.writesLatch ? m.writesOn : m.writesOff}
          </p>
          {isOwner ? null : (
            <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="amux-worker-registry-read-only">
              {m.readOnly}
            </p>
          )}
          {view.registryReadable ? null : (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300" data-testid="amux-worker-registry-unreadable">
              {m.unreadableRows}
            </p>
          )}

          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.comparisonTitle}</h3>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.comparisonHelp}</p>
          <p
            className={`text-sm font-semibold ${view.comparison.status === "match" ? "text-zinc-900 dark:text-zinc-100" : "text-amber-700 dark:text-amber-300"}`}
            data-testid="amux-worker-registry-comparison-status"
            data-status={view.comparison.status}
          >
            {m.comparisonStatus[view.comparison.status]}
          </p>
          {view.comparison.rows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm text-zinc-900 dark:text-zinc-100">
                <thead>
                  <tr>
                    <th scope="col" className={headClass}>{m.column.worker}</th>
                    <th scope="col" className={headClass}>{m.column.registry}</th>
                    <th scope="col" className={headClass}>{m.column.catalog}</th>
                    <th scope="col" className={headClass}>{m.column.verdict}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.comparison.rows.map((row) => (
                    <tr key={row.workerName} data-testid={`amux-worker-comparison-${row.workerName}`} data-verdict={row.verdict}>
                      <th scope="row" className={`${cellClass} font-mono text-xs`}>{row.workerName}</th>
                      <td className={cellClass}>{row.registryState ?? m.notRegistered}</td>
                      <td className={cellClass}>{m.catalogState[row.catalog]}</td>
                      <td className={cellClass}>{m.verdict[row.verdict]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.workersTitle}</h3>
          {view.rows.length === 0 ? (
            <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="amux-worker-registry-empty">{m.noWorkers}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm text-zinc-900 dark:text-zinc-100">
                <thead>
                  <tr>
                    <th scope="col" className={headClass}>{m.column.worker}</th>
                    <th scope="col" className={headClass}>{m.column.class}</th>
                    <th scope="col" className={headClass}>{m.column.role}</th>
                    <th scope="col" className={headClass}>{m.column.desired}</th>
                    <th scope="col" className={headClass}>{m.column.revision}</th>
                    <th scope="col" className={headClass}>{m.column.changed}</th>
                    <th scope="col" className={headClass}>{m.column.latch}</th>
                    <th scope="col" className={headClass}>{m.column.observation}</th>
                    <th scope="col" className={headClass}>{m.column.effective}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((row) => (
                    <tr key={row.workerName} data-testid={`amux-worker-row-${row.workerName}`}>
                      <th scope="row" className={`${cellClass} font-mono text-xs`}>{row.workerName}</th>
                      <td className={cellClass}>
                        {row.providerClass} ({row.verified ? m.verified : m.unverified})
                      </td>
                      <td className={cellClass}>{row.roleCeiling}</td>
                      <td className={cellClass}>{row.desiredState}</td>
                      <td className={cellClass}>{row.revision}</td>
                      <td className={cellClass}>
                        <time dateTime={row.changedAt} title={row.changedAt}>
                          {brisbaneTime.format(new Date(row.changedAt))}
                        </time>
                      </td>
                      <td className={cellClass}>{m.latch[row.latch ?? "none"]}</td>
                      <td className={cellClass}>{row.observation ?? m.noObservation}</td>
                      <td className={cellClass} data-testid={`amux-worker-effective-${row.workerName}`}>
                        {row.assignable ? m.assignable : row.reasons.map((reason) => m.reason[reason]).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {isOwner && view.seed !== null ? (
            <div className="flex flex-col gap-2" data-testid="amux-worker-registry-seed">
              <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.seedTitle}</h3>
              <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.seedHelp}</p>
              {toRegister.length === 0 ? (
                <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.seedAllRegistered}</p>
              ) : (
                <>
                  <ul className="list-disc pl-5 text-sm text-zinc-700 dark:text-zinc-300">
                    {toRegister.map((entry) => (
                      <li key={entry.workerName}>
                        <span className="font-mono text-xs">{entry.workerName}</span> · {entry.desiredState} · {entry.roleCeiling}
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className={`${buttonClass} w-fit`}
                    disabled={busy || !view.writesLatch}
                    onClick={() => onRegister(toRegister)}
                    data-testid="amux-worker-registry-seed-register"
                  >
                    {pending !== null && pending !== "reading"
                      ? m.seedRegistering(pending.done, pending.total)
                      : m.seedRegister(toRegister.length)}
                  </button>
                </>
              )}
            </div>
          ) : null}
        </>
      )}
      {notice === "done" ? (
        <p role="status" className="text-sm" data-testid="amux-worker-registry-done">{m.seedDone}</p>
      ) : null}
      {notice === "stopped" ? (
        <p role="status" className="text-sm" data-testid="amux-worker-registry-stopped">{m.seedStopped}</p>
      ) : null}
      {notice === "outcome_unknown" ? (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-300" data-testid="amux-worker-registry-outcome-unknown">
          {m.seedOutcomeUnknown}
        </p>
      ) : null}
      {notice === "unread" ? (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-300" data-testid="amux-worker-registry-run-unread">
          {m.seedUnread}
        </p>
      ) : null}
      {refusal ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300" data-testid="amux-worker-registry-refused">
          {m.seedRefused(refusal.workerName, refusal.code)}
        </p>
      ) : null}
      {failure ? <AdminApiFailureNotice failure={failure} /> : null}
    </section>
  );
}

/** One step of a run or a read, applied to the panel's state in order. */
export type AmuxWorkerRegistryUpdate = Partial<{
  pending: AmuxWorkerRegistryPending;
  notice: AmuxWorkerRegistryNotice;
  refusal: AmuxWorkerRegistryRefusal;
  failure: AdminApiFailure | null;
  view: AmuxWorkerRegistryAdminView | null;
}>;

export type AmuxWorkerRegistryIo = {
  post: (entry: AmuxWorkerSeedEntry) => Promise<Response>;
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
const REFUSAL_CODES: ReadonlySet<string> = new Set(["registry_writes_off", ...AMUX_WORKER_REGISTRY_REFUSALS]);

const refusalError = async (response: Response): Promise<unknown> => {
  try {
    const body = (await response.clone().json()) as { error?: unknown } | null;
    return body?.error ?? null;
  } catch {
    return null;
  }
};

/**
 * Registers the given seed entries one by one, each sent once with revision 0.
 * The first answer that is not a success stops the run: a refusal or a
 * pre-transaction status wrote nothing for that worker; any other answer --
 * `outcome_unknown`, an unreadable body, another status, or no answer at all
 * -- may have written it, so nothing more is sent (foundation principle 7).
 * Whatever happened, the registry is read again before anything is released,
 * and the next run registers only what that read shows is missing.
 */
export async function runAmuxWorkerSeedRegistration(
  entries: readonly AmuxWorkerSeedEntry[],
  io: AmuxWorkerRegistryIo,
  update: (changes: AmuxWorkerRegistryUpdate) => void,
): Promise<void> {
  update({ pending: { done: 0, total: entries.length }, notice: null, refusal: null, failure: null });
  try {
    let outcome: "done" | "stopped" | "outcome_unknown" = "done";
    for (const [index, entry] of entries.entries()) {
      let response: Response;
      try {
        response = await io.post(entry);
      } catch {
        update({ failure: io.networkFailure() });
        outcome = "outcome_unknown";
        break;
      }
      if (response.ok) {
        update({ pending: { done: index + 1, total: entries.length } });
        continue;
      }
      const error = await refusalError(response);
      if (response.status === 409 && typeof error === "string" && REFUSAL_CODES.has(error)) {
        update({ refusal: { workerName: entry.workerName, code: error } });
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

/**
 * The view with its requests. Registration needs the owner role, the stage's
 * code latch and a recent step-up, all checked by the route; a stale step-up
 * is answered 428 and rendered with the way back (`AdminApiFailureNotice`,
 * docs/ui-contracts/admin-console-ia.md rule 7).
 */
export function AmuxWorkerRegistryPanel({
  view,
  isOwner,
}: {
  view: AmuxWorkerRegistryAdminView | null;
  isOwner: boolean;
}) {
  const m = useAdminMessages(adminAmuxWorkerRegistryMessages) as Messages;
  const { locale } = useAdminLocale();
  const [current, setCurrent] = useState<AmuxWorkerRegistryAdminView | null>(view);
  const [pending, setPending] = useState<AmuxWorkerRegistryPending>(null);
  const [notice, setNotice] = useState<AmuxWorkerRegistryNotice>(null);
  const [refusal, setRefusal] = useState<AmuxWorkerRegistryRefusal>(null);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);

  const apply = (changes: AmuxWorkerRegistryUpdate) => {
    if ("view" in changes) setCurrent(changes.view ?? null);
    if ("notice" in changes) setNotice(changes.notice ?? null);
    if ("refusal" in changes) setRefusal(changes.refusal ?? null);
    if ("failure" in changes) setFailure(changes.failure ?? null);
    if ("pending" in changes) setPending(changes.pending ?? null);
  };

  const io: AmuxWorkerRegistryIo = {
    post: (entry) =>
      adminFetch(REGISTRY_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...entry, expectedRevision: 0 }),
      }),
    read: async () => {
      try {
        const response = await adminFetch(REGISTRY_PATH, { method: "GET" });
        return response.ok
          ? parseAmuxWorkerRegistryAdminView(await response.json().catch(() => null))
          : null;
      } catch {
        return null;
      }
    },
    failureOf: (response) => readAdminApiFailure(response, { fallback: m.changeFailed, locale }),
    networkFailure: () => adminNetworkFailure(locale),
  };

  return (
    <AmuxWorkerRegistryView
      m={m}
      view={current}
      isOwner={isOwner}
      pending={pending}
      notice={notice}
      refusal={refusal}
      failure={failure}
      onRegister={(entries) => void runAmuxWorkerSeedRegistration(entries, io, apply)}
      onReread={() => void runAmuxWorkerRegistryReread(io, apply)}
    />
  );
}

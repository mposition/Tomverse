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
  parseAmuxWorkerCapabilityAdminView,
  type AmuxWorkerCapability,
  type AmuxWorkerCapabilityAdminView,
} from "@/lib/amux/workerCapabilityCore";

const CAPABILITY_PATH = "/api/admin/amux/workers/capabilities";

type Messages = (typeof adminAmuxWorkerCapabilityMessages)["en"];

export type AmuxWorkerCapabilityPending = "reading" | null;

const cellClass = "border-b border-zinc-200 px-2 py-2 align-top dark:border-zinc-700";
const headClass = `${cellClass} text-xs font-semibold text-zinc-600 dark:text-zinc-400`;
const buttonClass =
  "inline-flex min-h-11 items-center rounded-md border border-zinc-400 px-3 py-1 text-xs font-bold disabled:opacity-60 dark:border-zinc-500";

const describe = (m: Messages, capability: AmuxWorkerCapability | null) => {
  if (capability === null) return m.none;
  const parts = [`${m.tags}: ${capability.routingTags.join(", ")}`];
  if (capability.toolCapabilities.length > 0) parts.push(`${m.tools}: ${capability.toolCapabilities.join(", ")}`);
  if (capability.model) parts.push(`${m.model}: ${capability.model}`);
  if (capability.v22) parts.push(`${m.v22}: ${capability.v22.roles.join(", ")} (${capability.v22.tools.join(", ")}, ${capability.v22.model})`);
  return parts.join(" · ");
};

/**
 * The capability section of AMUX › Execution › Workers, without hooks, so a
 * test can call it and read the tree it returns. It shows what is recorded
 * for each registered worker. Stage R2a's import from the catalog variables
 * went with the variables at R2e (orchestration policy version 35, section
 * 5), so this section offers no write; an owner records a capability through
 * the capability route, which checks the owner role, R2a's code latch and a
 * recent step-up itself.
 */
export function AmuxWorkerCapabilityView({
  m,
  view,
  pending,
  failure,
  onReread,
}: {
  m: Messages;
  view: AmuxWorkerCapabilityAdminView | null;
  pending: AmuxWorkerCapabilityPending;
  failure: AdminApiFailure | null;
  onReread: () => void;
}) {
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
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm text-zinc-900 dark:text-zinc-100">
              <thead>
                <tr>
                  <th scope="col" className={headClass}>{m.column.worker}</th>
                  <th scope="col" className={headClass}>{m.column.ceiling}</th>
                  <th scope="col" className={headClass}>{m.column.current}</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.workerName} data-testid={`amux-worker-capability-row-${row.workerName}`}>
                    <th scope="row" className={`${cellClass} font-mono text-xs`}>{row.workerName}</th>
                    <td className={cellClass}>{row.roleCeiling}</td>
                    <td className={cellClass}>{describe(m, row.current?.capability ?? null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {failure ? <AdminApiFailureNotice failure={failure} /> : null}
    </section>
  );
}

export type AmuxWorkerCapabilityUpdate = Partial<{
  pending: AmuxWorkerCapabilityPending;
  failure: AdminApiFailure | null;
  view: AmuxWorkerCapabilityAdminView | null;
}>;

export type AmuxWorkerCapabilityIo = {
  read: () => Promise<Response>;
  failureOf: (response: Response) => Promise<AdminApiFailure>;
  networkFailure: () => AdminApiFailure;
};

/**
 * Reads the capabilities again. A failed read shows no capabilities rather
 * than the last ones, with what the route answered; a body that does not
 * parse is a failed read too.
 */
export async function runAmuxWorkerCapabilityReread(
  io: AmuxWorkerCapabilityIo,
  update: (changes: AmuxWorkerCapabilityUpdate) => void,
): Promise<void> {
  update({ pending: "reading", failure: null });
  try {
    let response: Response;
    try {
      response = await io.read();
    } catch {
      update({ view: null, failure: io.networkFailure() });
      return;
    }
    if (!response.ok) {
      update({ view: null, failure: await io.failureOf(response) });
      return;
    }
    update({ view: parseAmuxWorkerCapabilityAdminView(await response.json().catch(() => null)) });
  } finally {
    update({ pending: null });
  }
}

/** The view with its read. */
export function AmuxWorkerCapabilityPanel({ view }: { view: AmuxWorkerCapabilityAdminView | null }) {
  const m = useAdminMessages(adminAmuxWorkerCapabilityMessages) as Messages;
  const { locale } = useAdminLocale();
  const [current, setCurrent] = useState<AmuxWorkerCapabilityAdminView | null>(view);
  const [pending, setPending] = useState<AmuxWorkerCapabilityPending>(null);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);

  const apply = (changes: AmuxWorkerCapabilityUpdate) => {
    if ("view" in changes) setCurrent(changes.view ?? null);
    if ("failure" in changes) setFailure(changes.failure ?? null);
    if ("pending" in changes) setPending(changes.pending ?? null);
  };

  const io: AmuxWorkerCapabilityIo = {
    read: () => adminFetch(CAPABILITY_PATH, { method: "GET" }),
    failureOf: (response) => readAdminApiFailure(response, { fallback: m.unavailable, locale }),
    networkFailure: () => adminNetworkFailure(locale),
  };

  return (
    <AmuxWorkerCapabilityView
      m={m}
      view={current}
      pending={pending}
      failure={failure}
      onReread={() => void runAmuxWorkerCapabilityReread(io, apply)}
    />
  );
}

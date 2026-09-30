"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import {
  adminNetworkFailure,
  readAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxOrchestratorHaltsMessages } from "@/lib/adminMessages/amuxOrchestratorHalts";
import {
  AMUX_ORCHESTRATOR_HALT_KEY_PREFIX_LENGTH,
  AMUX_ORCHESTRATOR_RECEIPT_TARGET_HREFS,
} from "@/lib/amux/orchestratorHaltCore";
import type {
  AmuxOrchestratorAdminHalt,
  AmuxOrchestratorAdminView,
  AmuxOrchestratorAdminWrite,
} from "@/lib/amux/orchestratorHaltStore";

const CLEAR_PATH = "/api/admin/amux/orchestrator-halts";
const cellClass = "border-b border-zinc-200 px-2 py-1 align-top dark:border-zinc-700";

type Limits = { open: number; cleared: number; human: number };

/**
 * AMUX › Execution › Halts (orchestration policy version 20, section 7).
 *
 * Everything shown is read on the server; this component only sends the
 * clear. A clear needs the owner role and a recent step-up, both checked by
 * the route; a stale step-up is answered 428 and rendered with the way back
 * (`AdminApiFailureNotice`, docs/ui-contracts/admin-console-ia.md rule 7).
 * The clear sends the halt id and the first eight characters the person typed
 * of its key, and nothing that could run the original operation.
 */
export function AmuxOrchestratorHaltsPanel({
  view,
  canClear,
  limits,
}: {
  view: AmuxOrchestratorAdminView;
  canClear: boolean;
  limits: Limits;
}) {
  const m = useAdminMessages(adminAmuxOrchestratorHaltsMessages);
  return (
    <section
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4"
      data-testid="amux-orchestrator-halts-panel"
    >
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{m.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.description}</p>

      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.openTitle}</h3>
      <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="amux-halts-open-count">
        {m.openShown(view.open.length, view.openCount, limits.open)}
      </p>
      {view.open.length === 0 ? (
        <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.noOpen}</p>
      ) : (
        <>
          {canClear ? null : (
            <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.clearOwnerOnly}</p>
          )}
          <HaltTable halts={view.open} canClear={canClear} showCleared={false} />
        </>
      )}

      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.humanTitle}</h3>
      <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="amux-halts-human-count">
        {m.humanShown(view.humanRequired.length, view.humanRequiredCount, limits.human)}
      </p>
      {view.humanRequired.length === 0 ? (
        <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.noHuman}</p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="amux-halts-human-list">
          {view.humanRequired.map((write) => (
            <li
              key={write.requestId}
              className="rounded-md border border-zinc-200 p-3 text-sm text-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
            >
              <span className="block font-mono text-xs">{write.requestId}</span>
              <WriteSummary write={write} />
            </li>
          ))}
        </ul>
      )}

      <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.clearedTitle}</h3>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        {m.clearedShown(view.cleared.length, view.clearedCount, limits.cleared)}
      </p>
      {view.cleared.length === 0 ? (
        <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.noCleared}</p>
      ) : (
        <HaltTable halts={view.cleared} canClear={false} showCleared />
      )}
    </section>
  );
}

function HaltTable({
  halts,
  canClear,
  showCleared,
}: {
  halts: AmuxOrchestratorAdminHalt[];
  canClear: boolean;
  showCleared: boolean;
}) {
  const m = useAdminMessages(adminAmuxOrchestratorHaltsMessages);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm text-zinc-800 dark:text-zinc-100">
        <thead>
          <tr>
            <th scope="col" className={cellClass}>{m.haltId}</th>
            <th scope="col" className={cellClass}>{m.reason}</th>
            <th scope="col" className={cellClass}>{m.request}</th>
            <th scope="col" className={cellClass}>{showCleared ? m.clearedAt : m.openedAt}</th>
          </tr>
        </thead>
        <tbody>
          {halts.map((halt) => (
            <tr key={halt.haltId} data-testid="amux-halt-row">
              <td className={cellClass}>
                <span className="block font-mono text-xs">{halt.haltId}</span>
                <span className="block font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  {m.haltKey}: {halt.haltKey}
                </span>
                {canClear ? <ClearHaltForm haltId={halt.haltId} /> : null}
              </td>
              <td className={`${cellClass} font-mono text-xs`}>{halt.reasonCode}</td>
              <td className={cellClass}>
                {halt.requestId === null ? (
                  m.none
                ) : (
                  <>
                    <span className="block font-mono text-xs">{halt.requestId}</span>
                    {halt.write ? (
                      <WriteSummary write={halt.write} />
                    ) : (
                      <span className="block text-xs">{m.writeMissing}</span>
                    )}
                  </>
                )}
              </td>
              <td className={`${cellClass} font-mono text-xs`}>
                {showCleared ? (halt.clearedAt ?? m.none) : halt.openedAt}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WriteSummary({ write }: { write: AmuxOrchestratorAdminWrite }) {
  const m = useAdminMessages(adminAmuxOrchestratorHaltsMessages);
  return (
    <div className="mt-1 flex flex-col gap-1 text-xs">
      <span>{m.write(write.callKind, write.receiptCount)}</span>
      <span className="font-mono">{m.writeTimes(write.admittedAt, write.deadlineAt)}</span>
      <span>
        {write.resolvedAt && write.resolution
          ? m.writeClosed(write.resolution, write.resolvedAt)
          : write.ackedAt
            ? m.writeAcked(write.ackedAt)
            : m.writeUnsettled}
      </span>
      {write.receipts.length > 0 ? (
        <div>
          <span className="block font-semibold">{m.receiptsTitle}</span>
          <span className="block">{m.receiptsShown(write.receipts.length, write.receiptCount)}</span>
          <ul className="flex flex-col gap-1" data-testid="amux-halt-receipts">
            {write.receipts.map((receipt, index) => {
              const href = AMUX_ORCHESTRATOR_RECEIPT_TARGET_HREFS[receipt.targetKind];
              return (
                <li key={`${receipt.targetKind}-${receipt.targetId ?? "batch"}-${index}`}>
                  <span>{m.receipt(receipt.targetKind, receipt.rowCount)}</span>
                  {receipt.targetId ? (
                    <span className="ml-1 font-mono">{receipt.targetId}</span>
                  ) : null}
                  {href ? (
                    <Link
                      href={href}
                      className="ml-2 underline underline-offset-2"
                      data-testid="amux-halt-receipt-link"
                    >
                      {m.receiptLink}
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

type ClearRefusal = "not_found" | "already_cleared" | "halt_key_mismatch";

const isClearRefusal = (value: unknown): value is ClearRefusal =>
  value === "not_found" || value === "already_cleared" || value === "halt_key_mismatch";

function ClearHaltForm({ haltId }: { haltId: string }) {
  const m = useAdminMessages(adminAmuxOrchestratorHaltsMessages);
  const { locale } = useAdminLocale();
  const router = useRouter();
  const [prefix, setPrefix] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [refusal, setRefusal] = useState<ClearRefusal | null>(null);
  const [done, setDone] = useState(false);
  const inputId = `amux-halt-clear-${haltId}`;

  const clear = async () => {
    setPending(true);
    setFailure(null);
    setRefusal(null);
    try {
      const response = await adminFetch(CLEAR_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ haltId, haltKeyPrefix: prefix.trim() }),
      });
      if (response.ok) {
        setDone(true);
        router.refresh();
        return;
      }
      if (response.status === 409 || response.status === 404) {
        const body = (await response.clone().json().catch(() => null)) as { error?: unknown } | null;
        if (isClearRefusal(body?.error)) {
          setRefusal(body.error);
          return;
        }
      }
      setFailure(await readAdminApiFailure(response, { fallback: m.clearFailed, locale }));
    } catch {
      setFailure(adminNetworkFailure(locale));
    } finally {
      setPending(false);
    }
  };

  if (done) {
    return (
      <p role="status" className="mt-2 text-xs" data-testid="amux-halt-cleared">
        {m.cleared}
      </p>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs font-medium" htmlFor={inputId}>
        {m.clearLabel}
        <input
          id={inputId}
          className="w-40 rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono text-base text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
          value={prefix}
          maxLength={AMUX_ORCHESTRATOR_HALT_KEY_PREFIX_LENGTH}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setPrefix(event.target.value)}
          data-testid="amux-halt-clear-prefix"
        />
      </label>
      <button
        type="button"
        className="inline-flex min-h-11 w-fit items-center rounded-md border border-zinc-400 px-3 py-1 text-xs font-bold disabled:opacity-60 dark:border-zinc-500"
        disabled={pending || prefix.trim().length !== AMUX_ORCHESTRATOR_HALT_KEY_PREFIX_LENGTH}
        onClick={clear}
        data-testid="amux-halt-clear"
      >
        {pending ? m.clearing : m.clear}
      </button>
      {refusal ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-300">
          {m.clearRefusals[refusal]}
        </p>
      ) : null}
      {failure ? <AdminApiFailureNotice failure={failure} /> : null}
    </div>
  );
}

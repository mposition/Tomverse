"use client";

import Link from "next/link";
import { useState } from "react";

import { adminFetch } from "@/lib/adminFetch";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";

/** Owner action: accept that one ended v22 run's CLI usage stays unknown
 * (owner decision 2026-11-10). The server records the acceptance with its
 * audit; the run's reserved cap and unconfirmed cost are unchanged. */
export async function requestAcceptAttemptUnknownUsage(taskId: string, attemptId: string) {
  const response = await adminFetch("/api/admin/amux/execution-usage-acceptance", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId, attemptId, confirm: "accept_unknown_usage" }) });
  if (response.status === 428) throw new Error("reauth");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<{ attemptId: string; source: string; acceptedAt: string }>;
}

export function AmuxAttemptUsageAcceptance({ taskId, attempt, canAccept, date, onAccepted }: {
  taskId: string;
  attempt: { id: string; usageUnknown: boolean;
    usageAcceptance: { source: string; acceptedAt: string } | null };
  canAccept: boolean;
  date: (value: string) => string;
  onAccepted: () => void;
}) {
  const m = useAdminMessages(adminAmuxExecutionMessages).usageUnknown;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"failed" | "reauth" | null>(null);
  if (!attempt.usageUnknown) return null;
  if (attempt.usageAcceptance) return <p className="text-xs text-zinc-400"
    data-testid="amux-attempt-usage-accepted">
    {m.accepted(attempt.usageAcceptance.source, date(attempt.usageAcceptance.acceptedAt))}</p>;
  const accept = async () => {
    if (!window.confirm(m.confirm)) return;
    setBusy(true); setError(null);
    try { await requestAcceptAttemptUnknownUsage(taskId, attempt.id); onAccepted(); }
    catch (reason) { setError(reason instanceof Error && reason.message === "reauth" ? "reauth" : "failed"); }
    finally { setBusy(false); }
  };
  return <div className="mt-1 space-y-1 rounded border border-amber-700 p-2 text-xs"
    data-testid="amux-attempt-usage-unknown">
    <p>{m.held}</p>
    {canAccept && <>
      <button type="button" className="underline" disabled={busy} onClick={() => void accept()}
        data-testid="amux-attempt-usage-accept">{busy ? m.busy : m.accept}</button>
      <p className="text-zinc-400">{m.notZero}</p>
    </>}
    {error === "reauth" ? <Link className="underline"
      href={adminRecentAuthenticationHref(`/admin/amux-execution?tab=cards&taskId=${encodeURIComponent(taskId)}`)}>
      {m.reauth}</Link> : error === "failed" ? <p role="alert">{m.failed}</p> : null}
  </div>;
}

/** The owner queue: each run of this Task whose unknown usage holds its
 * worker, with the same acceptance. Accepted runs leave the list here; the
 * queue's next read no longer lists them. */
export function AmuxTaskUnknownUsageList({ taskId, attempts, canAccept, date }: {
  taskId: string;
  attempts: ReadonlyArray<{ id: string; worker: string; started_at: string }>;
  canAccept: boolean;
  date: (value: string) => string;
}) {
  const m = useAdminMessages(adminAmuxExecutionMessages).usageUnknown;
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  if (attempts.length === 0) return null;
  return <div className="mt-3 space-y-2" data-testid="amux-owner-queue-unknown-usage">
    <p className="text-xs font-bold text-zinc-400">{m.queueTitle}</p>
    {attempts.map((attempt) => <div key={attempt.id} className="text-sm">
      <p className="text-zinc-300">{m.queueRun(attempt.worker, date(attempt.started_at))}</p>
      <AmuxAttemptUsageAcceptance taskId={taskId} canAccept={canAccept} date={date}
        attempt={{ id: attempt.id, usageUnknown: true,
          usageAcceptance: accepted.has(attempt.id) ?
            { source: "owner_accept", acceptedAt: new Date().toISOString() } : null }}
        onAccepted={() => setAccepted((current) => new Set([...current, attempt.id]))} />
    </div>)}
  </div>;
}

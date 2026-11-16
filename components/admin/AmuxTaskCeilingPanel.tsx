"use client";

import Link from "next/link";
import { useState } from "react";

import { useAdminMessages } from "./AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxTaskCeilingMessages } from "@/lib/adminMessages/amuxTaskCeiling";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

/** What the Task detail read returns (lib/amux/v4TaskCeilingReapprovalService.ts). */
export type AmuxTaskCeilingView = {
  eligible: boolean;
  refusal: string | null;
  reason: string | null;
  approvedCeilingMicroUsd: string | null;
  currentCeilingMicroUsd: string | null;
  catalogDigest: string | null;
  maxAttempts: number | null;
  routes: Array<{ workerName: string; modelId: string; perAttemptMicroUsd: string; approved: boolean }>;
};

export type AmuxTaskCeilingOutcome =
  | { kind: "approved"; ceilingMicroUsd: string }
  | { kind: "refused"; reason: string | null }
  | { kind: "reauth" }
  | { kind: "unknown" };

const usd = (micro: string) => (Number(micro) / 1_000_000).toFixed(4);

/** One POST re-approving the ceiling the owner was shown. Never resent on an unknown outcome. */
export async function requestAmuxTaskCeilingReapproval(input: {
  taskId: string; revision: number; catalogDigest: string; ceilingMicroUsd: string;
  fetcher?: typeof adminFetch;
}): Promise<AmuxTaskCeilingOutcome> {
  let response: Response;
  try {
    response = await (input.fetcher ?? adminFetch)("/api/admin/amux/task-ceiling", {
      method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ taskId: input.taskId, revision: input.revision,
        catalogDigest: input.catalogDigest, ceilingMicroUsd: input.ceilingMicroUsd, ownerConfirmed: true }),
    });
  } catch { return { kind: "unknown" }; }
  if (response.status === 428) return { kind: "reauth" };
  let body: Record<string, unknown> = {};
  try { body = await response.json() as Record<string, unknown>; } catch { body = {}; }
  if (response.ok && body.status === "reapproved" && typeof body.ceilingMicroUsd === "string")
    return { kind: "approved", ceilingMicroUsd: body.ceilingMicroUsd };
  // A 4xx refused before any write; a 5xx may have written.
  if (response.status >= 400 && response.status < 500) {
    const reason = typeof body.reason === "string" ? body.reason : typeof body.error === "string" ? body.error : null;
    return { kind: "refused", reason };
  }
  return { kind: "unknown" };
}

export function AmuxTaskCeilingPanel({ taskId, revision, view, canAct, onChanged, fetcher, reauthReturnPath }: {
  taskId: string; revision: number; view: AmuxTaskCeilingView; canAct: boolean;
  /** Reloads the board and the card after the approval. */
  onChanged: () => void;
  fetcher?: typeof adminFetch;
  reauthReturnPath?: string;
}) {
  const m = useAdminMessages(adminAmuxTaskCeilingMessages);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AmuxTaskCeilingOutcome | null>(null);
  const current = view.currentCeilingMicroUsd;
  // The reloaded card no longer offers it; the answer stays on screen.
  if (outcome?.kind === "approved") return <p role="status" className="text-sm"
    data-testid="amux-task-ceiling-outcome">{m.approved(usd(outcome.ceilingMicroUsd))}</p>;
  if (!view.eligible || !current || !view.catalogDigest) return null;
  const catalogDigest = view.catalogDigest;

  const run = async () => {
    setBusy(true);
    setConfirming(false);
    const result = await requestAmuxTaskCeilingReapproval({ taskId, revision, catalogDigest,
      ceilingMicroUsd: current, fetcher });
    setOutcome(result);
    setBusy(false);
    if (result.kind === "approved") onChanged();
  };

  return <section className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4"
    data-testid="amux-task-ceiling">
    <h4 className="font-semibold">{m.title}</h4>
    <p className="text-sm leading-6">{m.intro} {m.effect}</p>
    <dl className="grid gap-1 text-sm sm:grid-cols-2">
      <div><dt className="inline">{m.approvedCeiling}: </dt><dd className="inline font-semibold">
        {view.approvedCeilingMicroUsd === null ? "-" : `$${usd(view.approvedCeilingMicroUsd)}`}</dd></div>
      <div><dt className="inline">{m.currentCeiling}: </dt><dd className="inline font-semibold"
        data-testid="amux-task-ceiling-current">${usd(current)}
        {view.maxAttempts !== null && ` (${m.attempts(view.maxAttempts)})`}</dd></div>
    </dl>
    {view.routes.length > 0 && <div className="text-sm">
      <p className="font-medium">{m.routes}</p>
      <ul className="mt-1 space-y-1">
        {view.routes.map((route) => <li key={route.workerName + ":" + route.modelId}>
          {route.workerName} · {route.modelId} · ${usd(route.perAttemptMicroUsd)}
          {!route.approved && <span className="ml-2 rounded border border-amber-500/50 px-1 text-xs">{m.newRoute}</span>}
        </li>)}
      </ul>
    </div>}
    {canAct && <div className="flex flex-wrap gap-2">
      {!confirming ? <button type="button" className="min-h-11 rounded-lg border border-blue-500/50 px-3 py-2 font-semibold"
        disabled={busy} onClick={() => setConfirming(true)}
        data-testid="amux-task-ceiling-approve">{m.approve}</button> :
        <div className="space-y-2" role="group" aria-label={m.title}>
          <p className="text-sm font-semibold">{m.confirmApprove(usd(current))}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="min-h-11 rounded-lg border border-blue-500/50 px-3 py-2 font-semibold"
              disabled={busy} onClick={() => void run()}
              data-testid="amux-task-ceiling-confirm">{m.confirm}</button>
            <button type="button" className="min-h-11 rounded-lg border border-zinc-600 px-3 py-2"
              disabled={busy} onClick={() => setConfirming(false)}>{m.cancel}</button>
          </div>
        </div>}
    </div>}
    {busy && <p role="status" className="text-sm">{m.working}</p>}
    {outcome && <div role="status" className="text-sm" data-testid="amux-task-ceiling-outcome">
      {outcome.kind === "refused" && <p>{m.notApprovable} {outcome.reason ? m.reason[outcome.reason] ?? outcome.reason : ""}</p>}
      {outcome.kind === "reauth" && <Link className="underline" href={adminRecentAuthenticationHref(reauthReturnPath ??
        "/admin/amux-execution?tab=cards&taskId=" + encodeURIComponent(taskId))}>{m.reauth}</Link>}
      {outcome.kind === "unknown" && <p>{m.failed}</p>}
    </div>}
  </section>;
}

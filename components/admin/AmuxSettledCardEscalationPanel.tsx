"use client";

import Link from "next/link";
import { useState } from "react";

import { useAdminMessages } from "./AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxSettledCardEscalationMessages } from "@/lib/adminMessages/amuxSettledCardEscalation";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

export type AmuxSettledCardEscalationOutcome =
  | { kind: "closed" }
  | { kind: "refused"; reason: string | null }
  | { kind: "reauth" }
  | { kind: "unknown" };

/** One POST closing a done card's leftover escalations. Never resent on an unknown outcome. */
export async function requestAmuxSettledCardEscalationClose(input: {
  taskId: string; escalationId: string; fetcher?: typeof adminFetch;
}): Promise<AmuxSettledCardEscalationOutcome> {
  let response: Response;
  try {
    response = await (input.fetcher ?? adminFetch)("/api/admin/amux/settled-card-escalation", {
      method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ taskId: input.taskId, escalationId: input.escalationId, ownerConfirmed: true }),
    });
  } catch { return { kind: "unknown" }; }
  if (response.status === 428) return { kind: "reauth" };
  let body: Record<string, unknown> = {};
  try { body = await response.json() as Record<string, unknown>; } catch { body = {}; }
  if (response.ok && body.status === "closed") return { kind: "closed" };
  // A 4xx refused before any write; a 5xx may have written.
  if (response.status >= 400 && response.status < 500) {
    const reason = typeof body.reason === "string" ? body.reason : typeof body.error === "string" ? body.error : null;
    return { kind: "refused", reason };
  }
  return { kind: "unknown" };
}

export function AmuxSettledCardEscalationPanel({ taskId, escalationId, canAct, onChanged, fetcher, reauthReturnPath }: {
  taskId: string; escalationId: string; canAct: boolean;
  /** Reloads what lists the card after the close. */
  onChanged: () => void;
  fetcher?: typeof adminFetch;
  /** Where a fresh sign-in returns; the execution board's card by default. */
  reauthReturnPath?: string;
}) {
  const m = useAdminMessages(adminAmuxSettledCardEscalationMessages);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AmuxSettledCardEscalationOutcome | null>(null);

  const run = async () => {
    setBusy(true);
    setConfirming(false);
    const result = await requestAmuxSettledCardEscalationClose({ taskId, escalationId, fetcher });
    setOutcome(result);
    setBusy(false);
    if (result.kind === "closed") onChanged();
  };

  return <section className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4"
    data-testid="amux-settled-card-escalation">
    <h4 className="font-semibold">{m.title}</h4>
    <p className="text-sm leading-6">{m.intro} {m.effect}</p>
    {canAct && outcome?.kind !== "closed" && <div className="flex flex-wrap gap-2">
      {!confirming ? <button type="button" className="min-h-11 rounded-lg border border-zinc-600 px-3 py-2 font-semibold"
        disabled={busy} onClick={() => setConfirming(true)}
        data-testid="amux-settled-card-escalation-close">{m.close}</button> :
        <div className="space-y-2" role="group" aria-label={m.title}>
          <p className="text-sm font-semibold">{m.confirmClose}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="min-h-11 rounded-lg border border-blue-500/50 px-3 py-2 font-semibold"
              disabled={busy} onClick={() => void run()}
              data-testid="amux-settled-card-escalation-confirm">{m.confirm}</button>
            <button type="button" className="min-h-11 rounded-lg border border-zinc-600 px-3 py-2"
              disabled={busy} onClick={() => setConfirming(false)}>{m.cancel}</button>
          </div>
        </div>}
    </div>}
    {busy && <p role="status" className="text-sm">{m.working}</p>}
    {outcome && <div role="status" className="text-sm" data-testid="amux-settled-card-escalation-outcome">
      {outcome.kind === "closed" && <p>{m.closed}</p>}
      {outcome.kind === "refused" && <p>{m.notClosable} {outcome.reason ? m.reason[outcome.reason] ?? outcome.reason : ""}</p>}
      {outcome.kind === "reauth" && <Link className="underline" href={adminRecentAuthenticationHref(reauthReturnPath ??
        "/admin/amux-execution?tab=cards&taskId=" + encodeURIComponent(taskId))}>{m.reauth}</Link>}
      {outcome.kind === "unknown" && <p>{m.failed}</p>}
    </div>}
  </section>;
}

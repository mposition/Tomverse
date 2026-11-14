"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxProcessAuditMessages } from "@/lib/adminMessages/amuxProcessAudit";
import { adminFetch } from "@/lib/adminFetch";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { AMUX_PROCESS_AUDIT_MAX_CADENCE_DAYS, AMUX_PROCESS_AUDIT_MIN_CADENCE_DAYS } from "@/lib/amuxProcessAuditCore";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * The owner's schedule controls. Every change, "run now" included, is one POST
 * that the route audits; none of them spends money (the run is the box's
 * flat-rate Codex CLI), so "run now" asks once and nothing more.
 */
export function AmuxProcessAuditControls({ enabled, cadenceDays, status }: {
  enabled: boolean;
  cadenceDays: number;
  status: readonly string[];
}) {
  const m = useAdminMessages(adminAmuxProcessAuditMessages);
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [days, setDays] = useState(String(cadenceDays));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const send = async (runNow: boolean) => {
    if (runNow && !window.confirm(m.confirmRunNow)) return;
    const cadence = Number(days);
    setBusy(true);
    setMessage(null);
    try {
      const response = await adminFetch("/api/admin/amux/process-audit/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: on, cadenceDays: cadence, runNow, ownerConfirmed: true }),
      });
      if (response.ok) {
        // The saved state is read again by the refresh; the body is consumed so the request finishes.
        await discardResponseBody(response);
        setMessage(m.saved);
        router.refresh();
        return;
      }
      const code = await response.json().then((body: { error?: unknown }) => String(body.error ?? response.status), () => String(response.status));
      setMessage(response.status === 428 ? m.reauth : m.failed(code));
    } catch {
      setMessage(m.failed("network"));
    } finally {
      setBusy(false);
    }
  };

  const cadenceValid = /^\d+$/.test(days) && Number(days) >= AMUX_PROCESS_AUDIT_MIN_CADENCE_DAYS &&
    Number(days) <= AMUX_PROCESS_AUDIT_MAX_CADENCE_DAYS;

  return (
    <div className="flex flex-col gap-3" data-testid="amux-process-audit-controls">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-300">
        {status.map((line) => <li key={line}>{line}</li>)}
      </ul>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm text-zinc-200">
          <input type="checkbox" checked={on} onChange={(event) => setOn(event.target.checked)} disabled={busy} />
          {m.scheduleOn}
        </label>
        <label className="flex flex-col gap-1 text-sm text-zinc-200">
          {m.cadence}
          <input type="number" inputMode="numeric" min={AMUX_PROCESS_AUDIT_MIN_CADENCE_DAYS} max={AMUX_PROCESS_AUDIT_MAX_CADENCE_DAYS}
            value={days} onChange={(event) => setDays(event.target.value)} disabled={busy}
            className="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1" />
        </label>
        <button type="button" onClick={() => void send(false)} disabled={busy || !cadenceValid}
          className="rounded bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-50">
          {m.save}
        </button>
        <button type="button" onClick={() => void send(true)} disabled={busy || !cadenceValid}
          className="rounded border border-zinc-600 px-3 py-1.5 text-sm font-medium text-zinc-100 disabled:opacity-50"
          data-testid="amux-process-audit-run-now">
          {m.runNow}
        </button>
      </div>
      <p className="text-xs text-zinc-500">{m.runNowNote}</p>
      {message ? (
        <p role="status" className="text-sm text-zinc-200">
          {message}{" "}
          {message === m.reauth ? (
            <Link href={adminRecentAuthenticationHref("/admin/amux-execution?tab=process-audit")} className="underline">
              {m.reauthLink}
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

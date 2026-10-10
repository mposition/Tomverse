"use client";

import { useEffect, useRef, useState } from "react";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxAnalysisBudgetMessages } from "@/lib/adminMessages/amuxAnalysisBudget";

type Hold = { id: string; previewId: string; status: string; reservedMicroUsd: string;
  expiresAt: string; canCancel: boolean; cancellationAuditId: string | null };
const ID = /^[A-Za-z0-9:_-]{1,128}$/;

export function AmuxUnusedAnalysisReservationPanel({ operatorId, available }: {
  operatorId: string; available: boolean;
}) {
  const m = useAdminMessages(adminAmuxAnalysisBudgetMessages).cancellation;
  const { locale } = useAdminLocale();
  const key = `tomverse-amux-unused-reservation:${operatorId}`;
  const [holdId, setHoldId] = useState("");
  const [hold, setHold] = useState<Hold | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    try {
      const pending = sessionStorage.getItem(key);
      if (pending && ID.test(pending)) queueMicrotask(() => {
        setHoldId(pending); setUnknown(true);
      });
    } catch { /* Storage failure never authorizes a write. */ }
  }, [key]);

  const read = async () => {
    if (!ID.test(holdId) || inFlight.current) return;
    inFlight.current = true; setBusy(true); setFailure(null); setHold(null); setConfirmed(false);
    try {
      const query = new URLSearchParams({ holdId });
      const response = await adminFetch(`/api/admin/amux/ideas/analysis-reservations?${query}`,
        { cache: "no-store" });
      if (!response.ok) {
        setFailure(await readAdminApiFailure(response, { fallback: m.readFailed, locale })); return;
      }
      const body = await response.json() as { state?: unknown; hold?: Partial<Hold> };
      const row = body.hold;
      if (body.state !== "found" || row?.id !== holdId || !ID.test(row.previewId ?? "") ||
          typeof row.status !== "string" || !/^[1-9]\d*$/.test(row.reservedMicroUsd ?? "") ||
          typeof row.expiresAt !== "string" || typeof row.canCancel !== "boolean" ||
          !(row.cancellationAuditId === null || typeof row.cancellationAuditId === "string")) {
        throw new Error("unavailable");
      }
      setHold(row as Hold);
      if (row.status === "released" && row.cancellationAuditId) {
        sessionStorage.removeItem(key); setUnknown(false);
      }
    } catch {
      setFailure({ message: m.readFailed, tone: "error", requiresReauthentication: false, approvalId: null });
    } finally { inFlight.current = false; setBusy(false); }
  };

  const cancel = async () => {
    if (!available || !hold?.canCancel || hold.id !== holdId || !confirmed || unknown || inFlight.current) return;
    // Persist the exact pending ID before the write, including across reauthentication.
    try { sessionStorage.setItem(key, hold.id); }
    catch {
      setFailure({ message: m.writeFailed, tone: "error", requiresReauthentication: false, approvalId: null }); return;
    }
    inFlight.current = true; setBusy(true); setFailure(null); setConfirmed(false); setUnknown(true);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/analysis-reservations", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holdId: hold.id, previewId: hold.previewId, confirmedUnused: true }),
      });
      if (!response.ok) {
        if (response.status < 500) { sessionStorage.removeItem(key); setUnknown(false); setHold(null); }
        setFailure(await readAdminApiFailure(response, { fallback: m.writeFailed, locale })); return;
      }
      const receipt = await response.json() as Record<string, unknown>;
      if (receipt.holdId !== hold.id || receipt.releasedMicroUsd !== hold.reservedMicroUsd ||
          typeof receipt.auditId !== "string" || !receipt.auditId || receipt.modelCallStarted !== false) return;
      sessionStorage.removeItem(key); setUnknown(false);
      setHold({ ...hold, status: "released", canCancel: false, cancellationAuditId: receipt.auditId });
    } catch { /* Keep the pending ID. Only exact-ID read-back can resolve an unknown write. */ }
    finally { inFlight.current = false; setBusy(false); }
  };

  return <section className="space-y-3 rounded-xl border border-white/10 p-4"
    data-testid="amux-unused-reservation">
    <h2 className="font-semibold">{m.title}</h2>
    <p className="text-sm text-zinc-400">{m.hint}</p>
    {!available ? <p>{m.disabled}</p> : null}
    <label className="block text-sm">{m.holdId}
      <input className="mt-1 block w-full rounded border border-white/20 bg-transparent p-2"
        value={holdId} disabled={busy || unknown} maxLength={128} onChange={(event) => {
          setHoldId(event.target.value.trim()); setHold(null); setConfirmed(false); setFailure(null);
        }} />
    </label>
    <button type="button" disabled={busy || !ID.test(holdId)} onClick={() => void read()}
      className="rounded border border-white/20 px-3 py-2 text-sm">{m.lookup}</button>
    {unknown ? <p role="alert">{m.unknown}</p> : null}
    {hold ? <div className="space-y-2 text-sm">
      <p>{m.status}: {hold.status}</p><p>{m.amount}: {hold.reservedMicroUsd}</p>
      <p>{m.expiresAt}: {hold.expiresAt}</p>
      {hold.status === "released" && hold.cancellationAuditId ?
        <p role="status">{m.released} {m.audit}: {hold.cancellationAuditId}</p> :
        hold.canCancel && !unknown ? <>
          <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={busy || !available}
            onChange={(event) => setConfirmed(event.target.checked)} />{m.confirm}</label>
          <button type="button" disabled={!available || !confirmed || busy} onClick={() => void cancel()}
            className="rounded border border-white/20 px-3 py-2">{m.cancel}</button>
        </> : <p>{m.ineligible}</p>}
    </div> : null}
    {failure ? <AdminApiFailureNotice failure={failure} currentPath="/admin/amux-backlog?tab=ideas"
      onRetry={() => void read()} retryDisabled={busy} /> : null}
  </section>;
}

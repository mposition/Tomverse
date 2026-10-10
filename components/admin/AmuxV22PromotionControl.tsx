"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminFetch";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { useAdminMessages } from "./AdminLocaleProvider";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";

type Control = { codeLatch: boolean; environmentEnabled: boolean;
  active: boolean; authorizationAuditLogId: string | null;
  graduation: { ok: boolean; count: number; spanMs: number };
  graduationExceptionId: string; graduationExceptionAvailable: boolean;
  graduationExceptionApplied: boolean };
const url = "/api/admin/amux/v22-auto-promotion";
async function readControl(): Promise<Control> {
  const response = await adminFetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("unavailable");
  return response.json() as Promise<Control>;
}

/** Owner controls live on Promotion; the card board stays read-only. */
export function AmuxV22PromotionControl() {
  const m = useAdminMessages(adminAmuxExecutionMessages);
  const [control, setControl] = useState<Control | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void readControl().then((value) => { if (!cancelled) setControl(value); })
      .catch(() => { if (!cancelled) setError("unavailable"); });
    return () => { cancelled = true; };
  }, []);
  const configure = async (active: boolean) => {
    if (!control || busy || unknown || (active && !confirmed)) return;
    setBusy(true); setError(null);
    let acknowledged = false;
    try {
      const response = await adminFetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policyVersion: 22, active,
          expectedAuditLogId: control.authorizationAuditLogId,
          ...(active && control.graduationExceptionAvailable ? {
            graduationExceptionId: control.graduationExceptionId,
          } : {}),
        }),
      });
      if (response.status === 428) { setError("reauth"); return; }
      if (!response.ok) {
        const result: { error?: unknown } = await response.json();
        if (response.status >= 500 || result.error === "outcome_unknown") {
          setUnknown(true); return;
        }
        setError(typeof result.error === "string" ? result.error : "unavailable");
        return;
      }
      const result: { active: boolean; authorizationAuditLogId: string | null } =
        await response.json();
      acknowledged = true;
      setControl((current) => current ? { ...current, ...result } : current);
      setConfirmed(false);
      // A failed read-back is not a failed acknowledged write.
      setControl(await readControl());
    } catch {
      if (acknowledged) setError("unavailable");
      else setUnknown(true);
    } finally { setBusy(false); }
  };
  const needsExceptionApproval = control?.graduationExceptionAvailable &&
    !control.graduationExceptionApplied && !control.graduation.ok;
  const canActivate = Boolean(control?.codeLatch && control.environmentEnabled &&
    (control.graduation.ok || control.graduationExceptionAvailable));
  return <section data-testid="amux-v22-promotion-control"
    className="rounded border border-zinc-300 p-3 text-sm dark:border-zinc-700">
    <h2 className="font-semibold">{m.promotionControl}</h2>
    <p className="mt-2 text-xs text-zinc-500">{m.promotionCaveat}</p>
    {!control && !error && <p>{m.loading}</p>}
    {control && <>
      <p className="mt-2">{m.promotionState}: {control.active ? m.promotionOn : m.promotionOff}</p>
      <p>{m.graduationMeasurement(control.graduation.count,
        Math.floor(control.graduation.spanMs / 86_400_000))}</p>
      {control.graduationExceptionAvailable && <p className="text-amber-600 dark:text-amber-400">
        {control.graduationExceptionApplied ? m.exceptionApplied : m.exceptionAvailable}
      </p>}
      {(!control.active || needsExceptionApproval) && <>
        <label className="my-2 flex items-start gap-2">
          <input type="checkbox" checked={confirmed} disabled={busy || unknown}
            onChange={(event) => setConfirmed(event.target.checked)} />
          {control.graduationExceptionAvailable ? m.confirmException : m.confirmPromotion}
        </label>
        <button type="button" className="rounded border px-3 py-2"
          disabled={busy || unknown || !confirmed || !canActivate}
          onClick={() => void configure(true)}>{m.activatePromotion}</button>
      </>}
      {control.active && <button type="button" className="ml-2 rounded border px-3 py-2"
        disabled={busy || unknown} onClick={() => void configure(false)}>
        {m.deactivatePromotion}</button>}
    </>}
    {unknown && <p role="alert" className="mt-2">{m.unknownOutcome}</p>}
    {error && <p role="alert" className="mt-2">
      {error === "reauth" ? <Link className="underline"
        href={adminRecentAuthenticationHref("/admin/amux-promotion?tab=auto-promotion")}>{m.reauth}</Link> :
        <>{m.promotionRefused} <code>{error}</code></>}
    </p>}
  </section>;
}

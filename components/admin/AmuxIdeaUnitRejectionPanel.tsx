"use client";

import { useState } from "react";
import { z } from "zod";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import type { AmuxVisibleAnalysisUnit } from
  "@/lib/amux/ideaAnalysisResultReadCore";

const id = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const preparedSchema = z.object({ state: z.literal("prepared"),
  decisionId: id, confirmationDigest: digest, expiresAt: z.string().datetime(),
  draftUnitId: id, unitKind: z.enum(["node", "card"]),
  targetCreated: z.literal(false), retryWrite: z.literal(false),
  auditId: id }).strict();
type Prepared = z.infer<typeof preparedSchema>;

export function AmuxIdeaUnitRejectionPanel({ ideaId, unit }: {
  ideaId: string; unit: AmuxVisibleAnalysisUnit;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const [reason, setReason] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [recoveryId, setRecoveryId] = useState("");
  const [readbackPreparedId, setReadbackPreparedId] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (unit.decisionState !== "proposed" || !unit.proposal ||
      !["node", "card"].includes(unit.proposal.kind)) return null;

  const fail = async (response: Response) => {
    const value: unknown = await response.json().catch(() => null);
    const code = value && typeof value === "object" && "error" in value &&
      typeof value.error === "string" ? value.error : "unavailable";
    if (response.status === 428) setReauth(true);
    if (code === "outcome_unknown") setUnknown(true);
    else setError(m.unitRejectFailed(code));
  };
  const prepare = async () => {
    if (busy || unknown || prepared || rejected || cancelled ||
        reason.trim().length < 3) return;
    const prepareRequestId = crypto.randomUUID();
    setRequestId(prepareRequestId); setBusy(true); setError(null); setReauth(false);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions/reject/prepare", {
          method: "POST", cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ideaId, draftUnitId: unit.id,
            prepareRequestId, reason: reason.trim() }),
        });
      if (!response.ok) { await fail(response); return; }
      const parsed = preparedSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.draftUnitId !== unit.id ||
          parsed.data.unitKind !== unit.proposal?.kind) {
        setUnknown(true); return;
      }
      setPrepared(parsed.data);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const consume = async () => {
    if (!prepared || busy || unknown || rejected ||
        Date.now() >= Date.parse(prepared.expiresAt)) return;
    setBusy(true); setError(null); setReauth(false);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions/reject/consume", {
          method: "POST", cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decisionId: prepared.decisionId,
            consumeRequestId: crypto.randomUUID(),
            confirmationDigest: prepared.confirmationDigest }),
        });
      if (!response.ok) { await fail(response); return; }
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !("state" in value) ||
          value.state !== "consumed" || !("targetCreated" in value) ||
          value.targetCreated !== false) { setUnknown(true); return; }
      setRejected(true);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const readBack = async () => {
    const lookup: Record<string, string> = prepared ? { decisionId: prepared.decisionId } :
      { prepareRequestId: requestId ?? recoveryId.trim() };
    if (busy || !Object.values(lookup)[0]) return;
    setBusy(true);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions?" + new URLSearchParams(lookup),
        { cache: "no-store" });
      const value: unknown = await response.json();
      const belongsHere = value && typeof value === "object" &&
        "ideaId" in value && value.ideaId === ideaId &&
        "draftUnitId" in value && value.draftUnitId === unit.id;
      if (belongsHere && "state" in value && value.state === "consumed" &&
          "action" in value && value.action === "reject_unit") {
        setRejected(true); setUnknown(false);
      } else if (belongsHere && "state" in value &&
          value.state === "prepared" && "decisionId" in value &&
          id.safeParse(value.decisionId).success) {
        setReadbackPreparedId(value.decisionId as string);
        setUnknown(true);
      } else setUnknown(true);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    const decisionId = prepared?.decisionId ?? readbackPreparedId;
    if (!decisionId || busy || rejected || cancelled) return;
    setBusy(true); setError(null);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/unit-decisions/cancel", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId }),
      });
      if (!response.ok) { await fail(response); return; }
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !("state" in value) ||
          value.state !== "cancelled") { setUnknown(true); return; }
      setCancelled(true); setPrepared(null); setUnknown(false);
      setReadbackPreparedId(null);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  return <section className="space-y-2 rounded border border-zinc-300 p-3 dark:border-zinc-700">
    <h5 className="font-medium">{m.unitRejectTitle} · {unit.localRef}</h5>
    <p className="text-xs">{m.unitRejectHint}</p>
    {!prepared && !rejected && !cancelled ? <label className="block">{m.unitRejectReason}
      <textarea value={reason} maxLength={500} disabled={busy || unknown}
        onChange={(event) => setReason(event.target.value)}
        className="mt-1 w-full rounded border border-zinc-400 bg-transparent p-2" />
    </label> : null}
    {!prepared && !rejected && !cancelled ? <button type="button" onClick={() => void prepare()}
      disabled={busy || unknown || reason.trim().length < 3}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.unitRejectPrepare}</button> : null}
    {prepared ? <div className="space-y-1">
      <p>{m.storyRegistrationDigest}: <code>{prepared.confirmationDigest}</code></p>
      <p>{m.storyRegistrationExpires}: {prepared.expiresAt}</p>
      {!rejected ? <button type="button" onClick={() => void consume()}
        disabled={busy || unknown}
        className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
        {m.unitRejectConsume}</button> : null}
    </div> : null}
    {requestId ? <p className="break-all text-xs">{m.storyRegistrationRequestId}: {requestId}</p> : null}
    {!prepared && !requestId ? <label className="block text-xs">{m.storyRegistrationRecoveryId}
      <input value={recoveryId} onChange={(event) => setRecoveryId(event.target.value)}
        className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2" />
    </label> : null}
    {unknown ? <p role="alert">{m.storyRegistrationUnknown}</p> : null}
    {rejected ? <p role="status">{m.unitRejectDone}</p> : null}
    {cancelled ? <p role="status">{m.storyRegistrationCancelled}</p> : null}
    {unknown || prepared || recoveryId ? <button type="button"
      onClick={() => void readBack()} disabled={busy}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.storyRegistrationReadBack}</button> : null}
    {readbackPreparedId ? <p className="break-all text-xs">
      {m.storyRegistrationDecisionId}: {readbackPreparedId}</p> : null}
    {(prepared || readbackPreparedId) && !rejected && !cancelled ? <button type="button"
      onClick={() => void cancel()} disabled={busy}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.storyRegistrationCancel}</button> : null}
    {reauth ? <a className="underline"
      href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>
      {m.analysisResultReauth}</a> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

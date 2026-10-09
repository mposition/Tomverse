"use client";

import { useState } from "react";
import { z } from "zod";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

const ref = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const uuid = z.string().uuid();
const unknownSchema = z.object({ state: z.literal("outcome_unknown"),
  ideaId: ref, decisionId: ref, consumeRequestId: uuid,
  retryWrite: z.literal(false) }).passthrough();

/** Manual recovery is deliberately separate from every consume button. The
 * owner must read back one exact decision and make a new explicit choice. */
export function AmuxIdeaUnknownDecisionRecoveryPanel({ ideaId }: {
  ideaId: string;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const [decisionId, setDecisionId] = useState("");
  const [observed, setObserved] = useState<z.infer<typeof unknownSchema> | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const readBack = async () => {
    if (busy || !ref.safeParse(decisionId).success) return;
    setBusy(true); setObserved(null); setConfirmed(false); setStatus(null);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions?" +
        new URLSearchParams({ decisionId }), { cache: "no-store" });
      const value: unknown = await response.json();
      const parsed = unknownSchema.safeParse(value);
      if (response.ok && parsed.success && parsed.data.ideaId === ideaId &&
          parsed.data.decisionId === decisionId) {
        setObserved(parsed.data);
      } else {
        setStatus(m.unitUnknownRecoveryUnavailable);
      }
    } catch { setStatus(m.unitUnknownRecoveryUnavailable); }
    finally { setBusy(false); }
  };
  const resolve = async () => {
    if (busy || !observed || !confirmed) return;
    setBusy(true); setStatus(null); setReauth(false);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions/no-commit", {
          method: "POST", cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decisionId: observed.decisionId,
            consumeRequestId: observed.consumeRequestId,
            confirmation: "no_commit" }),
        });
      const value: unknown = await response.json();
      if (response.status === 428) setReauth(true);
      if (response.ok && value && typeof value === "object" &&
          "state" in value && value.state === "invalidated") {
        setObserved(null); setConfirmed(false);
        setStatus(m.unitUnknownRecoveryInvalidated);
      } else {
        setObserved(null); setConfirmed(false);
        setStatus(m.unitUnknownRecoveryUnavailable);
      }
    } catch {
      setObserved(null); setConfirmed(false);
      setStatus(m.unitUnknownRecoveryUnavailable);
    }
    finally { setBusy(false); }
  };
  return <section className="space-y-2 rounded-lg border border-amber-400 p-3 text-sm">
    <h4 className="font-medium">{m.unitUnknownRecoveryTitle}</h4>
    <p>{m.unitUnknownRecoveryHint}</p>
    <label className="block">{m.storyRegistrationDecisionId}
      <input value={decisionId} onChange={(event) => {
        setDecisionId(event.target.value.trim()); setObserved(null);
        setConfirmed(false); setStatus(null);
      }} className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2" />
    </label>
    <button type="button" onClick={() => void readBack()} disabled={busy ||
      !ref.safeParse(decisionId).success}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.storyRegistrationReadBack}</button>
    {observed ? <div className="space-y-2">
      <p role="status">{m.unitUnknownRecoveryObserved}</p>
      <p className="break-all">{m.unitUnknownRecoveryAttempt}:
        <code>{observed.consumeRequestId}</code></p>
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)} />
        {m.unitUnknownRecoveryConfirm}</label>
      <button type="button" onClick={() => void resolve()}
        disabled={busy || !confirmed}
        className="min-h-11 rounded border border-amber-500 px-3 disabled:opacity-50">
        {m.unitUnknownRecoveryResolve}</button>
    </div> : null}
    {reauth ? <a className="underline"
      href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>
      {m.analysisResultReauth}</a> : null}
    {status ? <p role="alert">{status}</p> : null}
  </section>;
}

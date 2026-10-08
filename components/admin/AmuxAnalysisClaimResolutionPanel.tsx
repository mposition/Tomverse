"use client";

import { useCallback, useEffect, useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from
  "@/components/admin/AdminLocaleProvider";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxAnalysisBudgetMessages } from
  "@/lib/adminMessages/amuxAnalysisBudget";
import { isAmuxClaimResolutionWriteOutcomeUnknown } from
  "@/lib/amux/ideaAnalysisClaimResolutionUiCore";

type Disposition = "not_started_proven" | "evidence_insufficient";
type Readback = { holdId: string; previewId: string; ideaId: string;
  chunkIndex: number; leaseGeneration: number; reservedMicroUsd: string;
  holdStatus: "in_flight" | "outcome_unknown"; claimRequestId: string;
  ideaState: "analyzing" | "cancelled"; ideaCancelledAt: string | null;
  payloadDigest: string; resultRequestId: string | null;
  resultDigest: string | null;
  resultOutcome: "verified_success" | "invocation_failed" | "outcome_unknown" | null;
  resultEffectiveOutcome: "outcome_unknown" | null;
  resultFailureReason: "usage_unverified" | null;
  zeroReleaseEligible: boolean; readbackDigest: string };

function parseReadback(value: unknown): Readback | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const row = root.readback;
  if (root.state !== "resolvable" || !row || typeof row !== "object" ||
      Array.isArray(row)) return null;
  const data = row as Record<string, unknown>;
  const strings = ["holdId", "previewId", "ideaId", "reservedMicroUsd",
    "holdStatus", "ideaState", "claimRequestId", "payloadDigest", "readbackDigest"];
  const ideaTupleValid =
    (data.ideaState === "analyzing" && data.ideaCancelledAt === null) ||
    (data.ideaState === "cancelled" && typeof data.ideaCancelledAt === "string");
  const resultTupleValid =
    (data.resultRequestId === null && data.resultDigest === null &&
      data.resultOutcome === null && data.resultEffectiveOutcome === null &&
      data.resultFailureReason === null && data.zeroReleaseEligible === true) ||
    (typeof data.resultRequestId === "string" &&
      typeof data.resultDigest === "string" &&
      data.resultOutcome === "outcome_unknown" &&
      data.resultEffectiveOutcome === "outcome_unknown" &&
      data.resultFailureReason === null && data.zeroReleaseEligible === false) ||
    (typeof data.resultRequestId === "string" &&
      typeof data.resultDigest === "string" &&
      ["verified_success", "invocation_failed"].includes(
        String(data.resultOutcome)) &&
      data.resultEffectiveOutcome === "outcome_unknown" &&
      data.resultFailureReason === "usage_unverified" &&
      data.zeroReleaseEligible === false);
  return strings.every((key) => typeof data[key] === "string") &&
    Number.isSafeInteger(data.chunkIndex) && data.leaseGeneration === 1 && ideaTupleValid &&
    resultTupleValid
    ? data as Readback : null;
}

export function AmuxAnalysisClaimResolutionPanel({ holdId, onResolved }: {
  holdId: string; onResolved: () => void;
}) {
  const m = useAdminMessages(adminAmuxAnalysisBudgetMessages).resolution;
  const { locale } = useAdminLocale();
  const [readback, setReadback] = useState<Readback | null>(null);
  const [disposition, setDisposition] = useState<Disposition | null>(null);
  const [evidenceDigest, setEvidenceDigest] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [complete, setComplete] = useState<Disposition | null>(null);

  const load = useCallback(async () => {
    setBusy(true); setFailure(null);
    try {
      const query = new URLSearchParams({ holdId });
      const response = await adminFetch(
        `/api/admin/amux/ideas/analysis-claim-resolution?${query}`, { cache: "no-store" });
      if (!response.ok) {
        setFailure(await readAdminApiFailure(response, { fallback: m.readFailed, locale }));
        return;
      }
      const parsed = parseReadback(await response.json());
      if (!parsed) throw new Error("invalid_readback");
      setReadback(parsed);
      if (!parsed.zeroReleaseEligible) {
        setDisposition((current) => current === "not_started_proven" ? null : current);
      }
    } catch {
      setFailure({ message: m.readFailed, tone: "error",
        requiresReauthentication: false, approvalId: null });
    } finally { setBusy(false); }
  }, [holdId, locale, m.readFailed]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const resolve = async () => {
    if (!readback || !disposition || !confirmed || busy || unknown ||
        !/^[a-f0-9]{64}$/.test(evidenceDigest)) return;
    const resolutionRequestId = crypto.randomUUID();
    setPendingRequestId(resolutionRequestId); setBusy(true); setFailure(null);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/analysis-claim-resolution", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionRequestId, holdId,
          readbackDigest: readback.readbackDigest, evidenceDigest, disposition }),
      });
      if (!response.ok) {
        const errorBody = await response.clone().json().catch(() => null) as
          { error?: unknown } | null;
        if (isAmuxClaimResolutionWriteOutcomeUnknown(response.status, errorBody)) {
          setUnknown(true); return;
        }
        setFailure(await readAdminApiFailure(response, { fallback: m.writeFailed, locale }));
        return;
      }
      const body = await response.json() as Record<string, unknown>;
      if (body.holdId !== holdId || body.disposition !== disposition) {
        setUnknown(true); return;
      }
      setComplete(disposition); onResolved();
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };

  const readReceipt = async () => {
    if (!pendingRequestId || busy) return;
    setBusy(true); setFailure(null);
    try {
      const query = new URLSearchParams({ resolutionRequestId: pendingRequestId });
      const response = await adminFetch(
        `/api/admin/amux/ideas/analysis-claim-resolution?${query}`, { cache: "no-store" });
      if (!response.ok) {
        setFailure(await readAdminApiFailure(response, { fallback: m.readFailed, locale }));
        return;
      }
      const body = await response.json() as Record<string, unknown>;
      const receipt = body.receipt as Record<string, unknown> | undefined;
      if (body.state !== "resolution_found" || receipt?.holdId !== holdId ||
          (receipt.disposition !== "not_started_proven" &&
           receipt.disposition !== "evidence_insufficient")) {
        setFailure({ message: m.notVisible, tone: "error",
          requiresReauthentication: false, approvalId: null });
        return;
      }
      setComplete(receipt.disposition); setUnknown(false); onResolved();
    } catch {
      setFailure({ message: m.readFailed, tone: "error",
        requiresReauthentication: false, approvalId: null });
    } finally { setBusy(false); }
  };

  if (complete) return <div role="status" data-testid="amux-claim-resolution-complete"
    className="rounded-lg border border-zinc-500 p-3">{complete === "not_started_proven"
      ? m.released : m.consumed}</div>;

  return <div data-testid="amux-claim-resolution" className="space-y-3 rounded-lg border border-amber-500/40 p-3">
    <h5 className="font-semibold">{m.title}</h5>
    <p>{m.stop}</p>
    {readback ? <dl className="space-y-1 text-xs">
      <div><dt className="inline font-semibold">{m.status}: </dt><dd className="inline">{readback.holdStatus}</dd></div>
      <div><dt className="inline font-semibold">{m.ideaState}: </dt><dd className="inline">{readback.ideaState}</dd></div>
      {readback.ideaCancelledAt ? <div><dt className="inline font-semibold">{m.cancelledAt}: </dt><dd className="inline font-mono">{readback.ideaCancelledAt}</dd></div> : null}
      <div><dt className="inline font-semibold">{m.claim}: </dt><dd className="inline font-mono break-all">{readback.claimRequestId}</dd></div>
      <div><dt className="inline font-semibold">{m.payload}: </dt><dd className="inline font-mono break-all">{readback.payloadDigest}</dd></div>
      <div><dt className="inline font-semibold">{m.reservation}: </dt><dd className="inline font-mono">{readback.reservedMicroUsd}</dd></div>
      {readback.resultRequestId ? <div><dt className="inline font-semibold">{m.result}: </dt><dd className="inline font-mono break-all">{readback.resultRequestId}</dd></div> : null}
      {readback.resultDigest ? <div><dt className="inline font-semibold">{m.resultDigest}: </dt><dd className="inline font-mono break-all">{readback.resultDigest}</dd></div> : null}
      {readback.resultOutcome ? <div><dt className="inline font-semibold">{m.resultOutcome}: </dt><dd className="inline font-mono">{readback.resultOutcome}</dd></div> : null}
      {readback.resultEffectiveOutcome ? <div><dt className="inline font-semibold">{m.effectiveOutcome}: </dt><dd className="inline font-mono">{readback.resultEffectiveOutcome}</dd></div> : null}
      {readback.resultFailureReason ? <div><dt className="inline font-semibold">{m.failureReason}: </dt><dd className="inline font-mono">{readback.resultFailureReason}</dd></div> : null}
      <div><dt className="inline font-semibold">{m.zeroRelease}: </dt><dd className="inline">{readback.zeroReleaseEligible ? m.eligible : m.ineligible}</dd></div>
      <div><dt className="inline font-semibold">{m.readback}: </dt><dd className="inline font-mono break-all">{readback.readbackDigest}</dd></div>
    </dl> : null}
    {readback && !unknown ? <>
      <label className="block"><span className="block font-semibold">{m.evidence}</span>
        <input value={evidenceDigest} onChange={(event) => setEvidenceDigest(event.target.value.trim().toLowerCase())}
          spellCheck={false} placeholder={m.digestPlaceholder}
          className="mt-1 min-h-11 w-full rounded-lg border border-zinc-500 bg-transparent px-3 font-mono text-xs" /></label>
      <label className="flex gap-2"><input type="radio" name={`resolution-${holdId}`}
        disabled={!readback.zeroReleaseEligible}
        checked={disposition === "not_started_proven"}
        onChange={() => setDisposition("not_started_proven")} />{m.notStarted}</label>
      {!readback.zeroReleaseEligible ? <p role="status">{m.notStartedIneligible}</p> : null}
      <label className="flex gap-2"><input type="radio" name={`resolution-${holdId}`}
        checked={disposition === "evidence_insufficient"}
        onChange={() => setDisposition("evidence_insufficient")} />{m.insufficient}</label>
      <label className="flex gap-2"><input type="checkbox" checked={confirmed}
        onChange={(event) => setConfirmed(event.target.checked)} />{m.confirm}</label>
      <button type="button" onClick={() => void resolve()} disabled={busy || !confirmed ||
        !disposition || !/^[a-f0-9]{64}$/.test(evidenceDigest)}
        className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">{m.apply}</button>
    </> : null}
    {unknown ? <><p role="alert">{m.unknown}</p><button type="button"
      disabled={busy} onClick={() => void readReceipt()}
      className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">{m.check}</button></> : null}
    {failure ? <AdminApiFailureNotice failure={failure} onRetry={unknown ? readReceipt : load}
      testId="amux-claim-resolution-failure" /> : null}
    {busy ? <p role="status">{m.loading}</p> : null}
  </div>;
}

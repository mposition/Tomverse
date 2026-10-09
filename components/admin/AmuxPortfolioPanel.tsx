"use client";

import Link from "next/link";
import { useState } from "react";
import { z } from "zod";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxPortfolioMessages } from
  "@/lib/adminMessages/amuxPortfolio";
import { adminCommonMessages } from "@/lib/adminMessages/common";
import { adminRecentAuthenticationHref } from
  "@/lib/adminReauthenticationCore";

const kinds = ["initiative", "epic", "feature", "story", "task"] as const;
type Kind = typeof kinds[number];
const fields: Record<Kind, readonly string[]> = {
  initiative: ["value"], epic: ["value"], feature: ["value"],
  story: ["impact"], task: ["contribution", "urgency",
    "dependencyUnlock", "workerCoverage", "effort", "deliveryRisk"],
};
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const previewAssessmentResponse = z.object({ confirmationDigest: digest,
  subjectRevision: z.number().int().nonnegative(),
  assessmentVersion: z.number().int().positive(),
  priorMetrics: z.record(z.string(), z.number()).nullable(),
  nextMetrics: z.record(z.string(), z.number()),
  evidenceAsOf: z.string().datetime(), retryWrite: z.literal(false),
}).strict();
const previewScoreResponse = z.object({ confirmationDigest: digest,
  score: z.object({ version: z.string(), total: z.number().int(),
    components: z.record(z.string(), z.number()),
    evidenceConfirmedAt: z.string().datetime(),
    activeStaleAt: z.string().datetime(),
    baselineStaleAt: z.string().datetime(),
    activeFresh: z.boolean(), baselineFresh: z.boolean() }),
  assessmentIds: z.object({ initiative: z.uuid(), epic: z.uuid(),
    feature: z.uuid(), story: z.uuid().nullable(), task: z.uuid() }),
  promotionAuthorized: z.literal(false), retryWrite: z.literal(false),
}).strict();

type Pending = { kind: "assessment" | "score"; requestId: string;
  payload: object; confirmationDigest: string };

export function AmuxPortfolioPanel({ writeAvailable }: {
  writeAvailable: boolean;
}) {
  const m = useAdminMessages(adminAmuxPortfolioMessages);
  const common = useAdminMessages(adminCommonMessages);
  const [kind, setKind] = useState<Kind>("initiative");
  const [subjectId, setSubjectId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [uncertainty, setUncertainty] = useState("medium");
  const [reasonCode, setReasonCode] = useState("initial");
  const [evidenceRefs, setEvidenceRefs] = useState("");
  const [modelDigest, setModelDigest] = useState("");
  const [evidenceAsOf, setEvidenceAsOf] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [preview, setPreview] = useState<unknown>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [latest, setLatest] = useState<unknown>(null);
  const [readiness, setReadiness] = useState<unknown>(null);

  const resetPreview = () => { setPending(null); setPreview(null);
    setConfirmed(false); setResult(null); };
  const messageFor = async (response: Response) => {
    const json: unknown = await response.json().catch(() => null);
    const code = json && typeof json === "object" && "error" in json &&
      typeof json.error === "string" ? json.error : "unavailable";
    setError(response.status === 428 ? m.reauth : m.failed(code));
    if (code === "outcome_unknown") setUnknown(true);
  };
  const post = async (body: unknown) => adminFetch("/api/admin/amux/portfolio", {
    method: "POST", cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const assessmentPreview = async () => {
    if (busy || unknown) return;
    const refs = evidenceRefs.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!subjectId || !evidenceAsOf || !refs.length ||
        fields[kind].some((field) => ratings[field] === undefined)) {
      setError(m.invalid); return;
    }
    const observed = new Date(evidenceAsOf);
    if (!Number.isFinite(observed.getTime()) ||
        (modelDigest.trim() !== "" && !digest.safeParse(modelDigest.trim()).success)) {
      setError(m.invalid); return;
    }
    const payload = { id: crypto.randomUUID(), requestId: crypto.randomUUID(),
      subject: { kind, id: subjectId.trim() },
      metrics: Object.fromEntries(fields[kind].map((field) =>
        [field, ratings[field]])), uncertainty, evidenceRefs: refs,
      evidenceAsOf: observed.toISOString(),
      reasonCode, modelProposalDigest: modelDigest.trim() || null };
    setBusy(true); setError(null); resetPreview();
    try {
      const response = await post({ action: "preview_assessment", payload });
      if (!response.ok) { await messageFor(response); return; }
      const parsed = previewAssessmentResponse.safeParse(await response.json());
      if (!parsed.success) { setError(m.invalid); return; }
      setPending({ kind: "assessment", requestId: payload.requestId,
        payload, confirmationDigest: parsed.data.confirmationDigest });
      setPreview(parsed.data);
    } catch { setError(m.invalid); }
    finally { setBusy(false); }
  };
  const scorePreview = async () => {
    if (busy || unknown || !taskId.trim()) { setError(m.invalid); return; }
    const payload = { id: crypto.randomUUID(), requestId: crypto.randomUUID(),
      taskId: taskId.trim() };
    setBusy(true); setError(null); resetPreview();
    try {
      const response = await post({ action: "preview_score", payload });
      if (!response.ok) { await messageFor(response); return; }
      const parsed = previewScoreResponse.safeParse(await response.json());
      if (!parsed.success) { setError(m.invalid); return; }
      setPending({ kind: "score", requestId: payload.requestId,
        payload, confirmationDigest: parsed.data.confirmationDigest });
      setPreview(parsed.data);
    } catch { setError(m.invalid); }
    finally { setBusy(false); }
  };
  const loadLatest = async () => {
    if (!taskId.trim() || busy) { setError(m.invalid); return; }
    setBusy(true); setError(null); setLatest(null);
    try {
      const response = await adminFetch("/api/admin/amux/portfolio?" +
        new URLSearchParams({ kind: "latest_score", taskId: taskId.trim() }),
      { cache: "no-store" });
      if (!response.ok) { await messageFor(response); return; }
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !("state" in value) ||
          (value.state !== "confirmed" && value.state !== "not_found")) {
        setError(m.invalid); return;
      }
      setLatest(value);
    } catch { setError(m.invalid); }
    finally { setBusy(false); }
  };
  const loadReadiness = async () => {
    if (!taskId.trim() || busy) { setError(m.invalid); return; }
    setBusy(true); setError(null); setReadiness(null);
    try {
      const response = await adminFetch("/api/admin/amux/portfolio?" +
        new URLSearchParams({ kind: "task_ready", taskId: taskId.trim() }),
      { cache: "no-store" });
      if (!response.ok) { await messageFor(response); return; }
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !("ready" in value) ||
          typeof value.ready !== "boolean" || !("reasons" in value) ||
          !Array.isArray(value.reasons) || !("promotionAuthorized" in value) ||
          value.promotionAuthorized !== false) {
        setError(m.invalid); return;
      }
      setReadiness(value);
    } catch { setError(m.invalid); }
    finally { setBusy(false); }
  };
  const approve = async () => {
    if (!pending || !confirmed || !writeAvailable || busy || unknown) return;
    setBusy(true); setError(null);
    try {
      const response = await post({ action: pending.kind === "assessment" ?
        "approve_assessment" : "confirm_score", approval: {
        payload: pending.payload,
        confirmationDigest: pending.confirmationDigest } });
      if (!response.ok) { await messageFor(response); return; }
      const value: unknown = await response.json();
      const resultId = value && typeof value === "object" &&
        ("assessmentId" in value ? value.assessmentId :
          "scoreId" in value ? value.scoreId : null);
      if (typeof resultId !== "string" ||
          !("id" in pending.payload) || resultId !== pending.payload.id) {
        setUnknown(true); return;
      }
      setResult(resultId); setPending(null); setPreview(null);
      setConfirmed(false);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const readBack = async () => {
    if (!pending || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await adminFetch("/api/admin/amux/portfolio?" +
        new URLSearchParams({ kind: pending.kind,
          requestId: pending.requestId }), { cache: "no-store" });
      if (!response.ok) { await messageFor(response); return; }
      const value: unknown = await response.json();
      if (value && typeof value === "object" && "state" in value &&
          ["approved", "confirmed"].includes(String(value.state)) &&
          "confirmationDigest" in value &&
          value.confirmationDigest === pending.confirmationDigest) {
        setUnknown(false); setResult(m.recovered);
        setPending(null); setPreview(null);
      } else if (value && typeof value === "object" && "state" in value &&
          value.state === "confirmed" && "inputDigest" in value &&
          value.inputDigest === pending.confirmationDigest) {
        setUnknown(false); setResult(m.recovered);
        setPending(null); setPreview(null);
      } else { setUnknown(true); setError(m.unknown); }
    } catch { setUnknown(true); setError(m.unknown); }
    finally { setBusy(false); }
  };

  const score = previewScoreResponse.safeParse(preview);
  return <section className="space-y-4 rounded-xl border border-zinc-300 p-4 text-sm dark:border-zinc-700">
    <h3 className="font-semibold">{m.title}</h3>
    <p>{m.hint}</p>
    <p className="text-xs">{m.noPromotion}</p>
    {!writeAvailable ? <p role="status">{m.disabled}</p> : null}
    <div className="grid gap-3 md:grid-cols-2">
      <label>{m.subjectKind}
        <select value={kind} disabled={busy || unknown} onChange={(event) => { setKind(event.target.value as Kind);
          setRatings({}); resetPreview(); }}
          className="mt-1 block min-h-11 w-full rounded border border-zinc-400 bg-transparent p-2">
          {kinds.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>{m.subjectId}
        <input value={subjectId} disabled={busy || unknown} onChange={(event) => { setSubjectId(event.target.value);
          resetPreview(); }} maxLength={128}
          className="mt-1 block min-h-11 w-full rounded border border-zinc-400 bg-transparent p-2" />
      </label>
      {fields[kind].map((field) => <label key={field}>{m.dimensions[field as keyof typeof m.dimensions]}
        <select value={ratings[field] ?? ""} disabled={busy || unknown} onChange={(event) => {
          setRatings((prior) => { const next = { ...prior };
            if (event.target.value === "") delete next[field];
            else next[field] = Number(event.target.value);
            return next; });
          resetPreview(); }}
          className="mt-1 block min-h-11 w-full rounded border border-zinc-400 bg-transparent p-2">
          <option value="">—</option>
          {[0, 1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>)}
      <label>{m.uncertainty}
        <select value={uncertainty} disabled={busy || unknown} onChange={(event) => { setUncertainty(event.target.value);
          resetPreview(); }}
          className="mt-1 block min-h-11 w-full rounded border border-zinc-400 bg-transparent p-2">
          {(["low", "medium", "high"] as const).map((value) =>
            <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>{m.reason}
        <select value={reasonCode} disabled={busy || unknown} onChange={(event) => { setReasonCode(event.target.value);
          resetPreview(); }}
          className="mt-1 block min-h-11 w-full rounded border border-zinc-400 bg-transparent p-2">
          {(["initial", "new_evidence", "operator_override", "major_event"] as const)
            .map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>{m.evidenceAsOf}
        <input type="datetime-local" value={evidenceAsOf} disabled={busy || unknown}
          onChange={(event) => { setEvidenceAsOf(event.target.value); resetPreview(); }}
          className="mt-1 block min-h-11 w-full rounded border border-zinc-400 bg-transparent p-2" />
      </label>
      <label className="md:col-span-2">{m.evidenceRefs}
        <textarea value={evidenceRefs} disabled={busy || unknown} onChange={(event) => { setEvidenceRefs(event.target.value);
          resetPreview(); }} maxLength={2048}
          className="mt-1 block min-h-24 w-full rounded border border-zinc-400 bg-transparent p-2" />
      </label>
      <label className="md:col-span-2">{m.modelDigest}
        <input value={modelDigest} disabled={busy || unknown} onChange={(event) => { setModelDigest(event.target.value);
          resetPreview(); }} maxLength={64}
          className="mt-1 block min-h-11 w-full rounded border border-zinc-400 bg-transparent p-2 font-mono text-xs" />
      </label>
    </div>
    <button type="button" disabled={busy || unknown}
      onClick={() => void assessmentPreview()}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">{m.assess}</button>
    <div className="space-y-2 border-t border-zinc-300 pt-3 dark:border-zinc-700">
      <label className="block">{m.scoreTaskId}
        <input value={taskId} disabled={busy || unknown} onChange={(event) => { setTaskId(event.target.value);
          resetPreview(); }} maxLength={128}
          className="mt-1 block min-h-11 w-full rounded border border-zinc-400 bg-transparent p-2" />
      </label>
      <button type="button" disabled={busy || unknown}
        onClick={() => void scorePreview()}
        className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">{m.calculate}</button>
      <button type="button" disabled={busy} onClick={() => void loadLatest()}
        className="ml-2 min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">{m.latest}</button>
      <button type="button" disabled={busy} onClick={() => void loadReadiness()}
        className="ml-2 min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">{m.readiness}</button>
    </div>
    {readiness ? <div className="space-y-1 rounded border border-zinc-300 p-3 dark:border-zinc-700">
      <p>{m.readinessHint}</p>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
        {JSON.stringify(readiness, null, 2)}
      </pre>
    </div> : null}
    {latest ? <div className="space-y-1 rounded border border-zinc-300 p-3 dark:border-zinc-700">
      <p>{m.historical}</p>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
        {JSON.stringify(latest, null, 2)}
      </pre>
    </div> : null}
    {preview ? <div className="space-y-2 rounded border border-zinc-300 p-3 dark:border-zinc-700">
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
        {JSON.stringify(preview, null, 2)}
      </pre>
      {score.success ? <p role="status">{score.data.score.activeFresh ? m.fresh : m.stale}</p> : null}
      <label className="flex gap-2"><input type="checkbox" checked={confirmed}
        onChange={(event) => setConfirmed(event.target.checked)} />{m.confirmEvidence}</label>
      <button type="button" disabled={!writeAvailable || !confirmed || busy || unknown}
        onClick={() => void approve()}
        className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
        {pending?.kind === "assessment" ? m.approve : m.confirm}
      </button>
    </div> : null}
    {unknown ? <div role="alert" className="space-y-2"><p>{m.unknown}</p>
      <button type="button" onClick={() => void readBack()} disabled={busy}
        className="min-h-11 rounded border border-zinc-400 px-3">{m.readback}</button>
    </div> : null}
    {result ? <p role="status">{result}</p> : null}
    {error ? <div role="alert"><p>{error}</p>
      {error === m.reauth ? <Link href={adminRecentAuthenticationHref(
        "/admin/amux-backlog?tab=ideas")}
        className="inline-flex min-h-11 items-center underline">
        {common.apiFailure.reauthenticate}
      </Link> : null}
    </div> : null}
  </section>;
}

"use client";

import { useState } from "react";
import { z } from "zod";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import type { AmuxVisibleAnalysisUnit } from
  "@/lib/amux/ideaAnalysisResultReadCore";

const ref = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestRef = z.string().uuid();
const catalogSchema = z.object({ features: z.array(z.object({
  ref, level: z.literal("feature"), parentRef: ref,
  revision: z.number().int().nonnegative(), contentDigest: digest,
  state: z.literal("active"),
}).strict()).max(1_000) }).strict();
const preparedSchema = z.object({
  state: z.literal("prepared"), decisionId: ref, confirmationDigest: digest,
  expiresAt: z.string().datetime(), draftUnitId: ref, title: z.string(),
  cardType: z.literal("story"), storyKind: z.enum(["general", "bug"]),
  featureNodeId: ref, duplicateCandidateIds: z.array(ref).max(64),
  backlogOnly: z.literal(true), executionAuthorized: z.literal(false),
  retryWrite: z.literal(false), auditId: ref,
}).strict();
type Prepared = z.infer<typeof preparedSchema>;

/** Per-Story, two-click approval. Browser text never supplies the proposal. */
export function AmuxIdeaStoryRegistrationPanel({ ideaId, unit }: {
  ideaId: string; unit: AmuxVisibleAnalysisUnit;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const [features, setFeatures] = useState<z.infer<typeof catalogSchema>["features"]>([]);
  const [featureId, setFeatureId] = useState("");
  const [reason, setReason] = useState("");
  const [duplicateIds, setDuplicateIds] = useState<string[]>([]);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [recoveryRequestId, setRecoveryRequestId] = useState("");
  const [readbackPreparedId, setReadbackPreparedId] = useState<string | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [closed, setClosed] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const proposal = unit.proposal;
  if (unit.decisionState !== "proposed" || proposal?.kind !== "card" ||
      proposal.cardType !== "story") return null;

  const fail = async (response: Response) => {
    const value: unknown = await response.json().catch(() => null);
    const code = value && typeof value === "object" && "error" in value &&
      typeof value.error === "string" ? value.error : "unavailable";
    if (response.status === 428) setReauth(true);
    if (code === "duplicate_reason_required" && value &&
        typeof value === "object" && "candidateIds" in value &&
        Array.isArray(value.candidateIds) &&
        value.candidateIds.length > 0 && value.candidateIds.length <= 64 &&
        value.candidateIds.every((id) => ref.safeParse(id).success)) {
      setDuplicateIds(value.candidateIds); setRequestId(null);
      setError(null);
    } else if (code === "outcome_unknown") { setUnknown(true); setError(null); }
    else { if (code === "reconfirm") { setDuplicateIds([]); setReason(""); }
      setError(m.storyRegistrationFailed(code)); }
  };
  const load = async () => {
    if (busy || unknown) return;
    setBusy(true); setError(null); setReauth(false);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions/catalog?" +
        new URLSearchParams({ ideaId }), { cache: "no-store" });
      if (!response.ok) { await fail(response); return; }
      const parsed = catalogSchema.safeParse(await response.json());
      if (!parsed.success) { setError(m.resolutionUnavailable); return; }
      setFeatures(parsed.data.features);
    } catch { setError(m.resolutionUnavailable); }
    finally { setBusy(false); }
  };
  const prepare = async () => {
    if (busy || unknown || !featureId || prepared || registered || closed) return;
    const prepareRequestId = crypto.randomUUID();
    setRequestId(prepareRequestId); setBusy(true); setError(null); setReauth(false);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/unit-decisions/prepare", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId, draftUnitId: unit.id, featureNodeId: featureId,
          prepareRequestId,
          decisionReason: duplicateIds.length ? reason.trim() || null : null }),
      });
      if (!response.ok) { await fail(response); return; }
      const parsed = preparedSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.draftUnitId !== unit.id ||
          parsed.data.title !== proposal.title ||
          parsed.data.featureNodeId !== featureId) {
        setUnknown(true); return;
      }
      setPrepared(parsed.data);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const consume = async () => {
    if (busy || unknown || !prepared || registered ||
        Date.now() >= Date.parse(prepared.expiresAt)) return;
    setBusy(true); setError(null); setReauth(false);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/unit-decisions/consume", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId: prepared.decisionId,
          consumeRequestId: crypto.randomUUID(),
          confirmationDigest: prepared.confirmationDigest }),
      });
      if (!response.ok) { await fail(response); return; }
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !("state" in value) ||
          value.state !== "consumed" || !("cardId" in value) ||
          !ref.safeParse(value.cardId).success) { setUnknown(true); return; }
      setCardId(value.cardId as string); setRegistered(true);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const readBack = async () => {
    const lookupId = requestId ?? recoveryRequestId.trim();
    if (busy || (!lookupId && !prepared) ||
        (!prepared && !requestRef.safeParse(lookupId).success)) return;
    setBusy(true);
    try {
      const query: Record<string, string> = prepared ?
        { decisionId: prepared.decisionId } :
        { prepareRequestId: lookupId };
      const response = await adminFetch("/api/admin/amux/ideas/unit-decisions?" +
        new URLSearchParams(query), { cache: "no-store" });
      const value: unknown = await response.json();
      const belongsHere = value && typeof value === "object" &&
        "ideaId" in value && value.ideaId === ideaId &&
        "draftUnitId" in value && value.draftUnitId === unit.id;
      if (belongsHere && "state" in value &&
          value.state === "consumed" && "cardId" in value &&
          ref.safeParse(value.cardId).success) {
        setCardId(value.cardId as string); setRegistered(true); setUnknown(false);
      } else if (belongsHere && "state" in value &&
          value.state === "prepared" && "decisionId" in value &&
          ref.safeParse(value.decisionId).success) {
        setReadbackPreparedId(value.decisionId as string);
        setUnknown(true);
      } else { setUnknown(true); }
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    const decisionId = prepared?.decisionId ?? readbackPreparedId;
    if (busy || !decisionId || registered) return;
    setBusy(true); setError(null);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/unit-decisions/cancel", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId }),
      });
      if (!response.ok) { await fail(response); return; }
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("state" in result) ||
          result.state !== "cancelled") { setUnknown(true); return; }
      setPrepared(null); setReadbackPreparedId(null); setUnknown(false);
      setClosed(true);
      setError(m.storyRegistrationCancelled);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  return <section className="space-y-2 rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
    <h5 className="font-medium">{m.storyRegistrationTitle} · {proposal.title}</h5>
    <p className="text-sm">{m.storyRegistrationHint}</p>
    <button type="button" onClick={() => void load()} disabled={busy || unknown}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.resolutionLoad}</button>
    {features.length ? <label className="block">{m.storyRegistrationFeature}
      <select value={featureId} disabled={busy || !!prepared || unknown}
        onChange={(event) => { setFeatureId(event.target.value);
          setDuplicateIds([]); setReason(""); }}
        className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2">
        <option value="">{m.resolutionChoose}</option>
        {features.map((entry) => <option key={entry.ref} value={entry.ref}>
          {entry.ref} · r{entry.revision}</option>)}
      </select></label> : null}
    {duplicateIds.length > 0 ? <p role="status">
      {m.storyRegistrationDuplicateReason} {duplicateIds.join(", ")}</p> : null}
    {featureId && !prepared && duplicateIds.length > 0 ?
      <label className="block">{m.resolutionReason}
      <textarea value={reason} maxLength={500} disabled={busy || unknown}
        onChange={(event) => setReason(event.target.value)}
        className="mt-1 w-full rounded border border-zinc-400 bg-transparent p-2" />
    </label> : null}
    {featureId && !prepared && !closed ? <button type="button" onClick={() => void prepare()}
      disabled={busy || unknown || (duplicateIds.length > 0 &&
        reason.trim().length < 3)}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.storyRegistrationPrepare}</button> : null}
    {prepared ? <div className="space-y-2 text-sm">
      <p role="status">{m.storyRegistrationPrepared}</p>
      <p>{m.storyRegistrationDecisionId}: <code className="break-all">
        {prepared.decisionId}</code></p>
      <p>{m.storyRegistrationDigest}: <code className="break-all">
        {prepared.confirmationDigest}</code></p>
      <p>{m.storyRegistrationExpires}: {prepared.expiresAt}</p>
      <p>{m.storyRegistrationDuplicates}: {prepared.duplicateCandidateIds.join(", ") || "—"}</p>
      {!registered ? <button type="button" onClick={() => void consume()}
        disabled={busy || unknown}
        className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
        {m.storyRegistrationConsume}</button> : null}
    </div> : null}
    {registered ? <p role="status">{m.storyRegistrationRegistered}
      {cardId ? <> · <code>{cardId}</code></> : null}</p> : null}
    {requestId ? <p className="text-xs">{m.storyRegistrationRequestId}: <code>
      {requestId}</code></p> : null}
    {unknown ? <p role="alert">{m.storyRegistrationUnknown}</p> : null}
    {!prepared && !requestId ? <label className="block text-sm">
      {m.storyRegistrationRecoveryId}
      <input value={recoveryRequestId} onChange={(event) =>
        setRecoveryRequestId(event.target.value)}
        className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2" />
    </label> : null}
    {unknown || prepared || recoveryRequestId ? <button type="button" onClick={() => void readBack()}
      disabled={busy} className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.storyRegistrationReadBack}</button> : null}
    {((prepared && !unknown) || readbackPreparedId) && !registered && !closed ? <button type="button"
      onClick={() => void cancel()} disabled={busy}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.storyRegistrationCancel}</button> : null}
    {reauth ? <a className="underline"
      href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>
      {m.analysisResultReauth}</a> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

"use client";

import { useState } from "react";
import { z } from "zod";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from
  "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from
  "@/lib/adminReauthenticationCore";
import type { AmuxVisibleAnalysisUnit } from
  "@/lib/amux/ideaAnalysisResultReadCore";

const ref = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nodeLevel = z.enum(["initiative", "epic", "feature"]);
const catalogSchema = z.object({ nodes: z.array(z.object({
  ref, level: nodeLevel, parentRef: ref.nullable(),
  revision: z.number().int().nonnegative(), contentDigest: digest,
  state: z.literal("active"),
}).strict()).max(1_000) }).strict();
const preparedSchema = z.object({ state: z.literal("prepared"),
  decisionId: ref, confirmationDigest: digest,
  expiresAt: z.string().datetime(), draftUnitId: ref,
  title: z.string(), level: nodeLevel, parentNodeId: ref.nullable(),
  nodeId: ref, duplicateCandidateIds: z.array(ref).max(64),
  executionAuthorized: z.literal(false), retryWrite: z.literal(false),
  auditId: ref }).strict();
type Prepared = z.infer<typeof preparedSchema>;

/** One node per explicit operator confirmation. Local model references are
 * resolved by the server against earlier consumed decisions. */
export function AmuxIdeaNodeRegistrationPanel({ ideaId, unit }: {
  ideaId: string; unit: AmuxVisibleAnalysisUnit;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const proposal = unit.proposal;
  const [nodes, setNodes] = useState<z.infer<typeof catalogSchema>["nodes"]>([]);
  const [parentId, setParentId] = useState("");
  const [reason, setReason] = useState("");
  const [duplicateIds, setDuplicateIds] = useState<string[]>([]);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [recoveryRequestId, setRecoveryRequestId] = useState("");
  const [readbackPreparedId, setReadbackPreparedId] = useState<string | null>(null);
  const [registeredNodeId, setRegisteredNodeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [closed, setClosed] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (unit.decisionState !== "proposed" || proposal?.kind !== "node") return null;
  const expectedParentLevel = proposal.level === "epic" ? "initiative" :
    proposal.level === "feature" ? "epic" : null;

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
      setError(m.nodeRegistrationFailed(code)); }
  };
  const load = async () => {
    if (busy || unknown) return;
    setBusy(true); setError(null); setReauth(false);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions/nodes/catalog?" +
        new URLSearchParams({ ideaId }), { cache: "no-store" });
      if (!response.ok) { await fail(response); return; }
      const parsed = catalogSchema.safeParse(await response.json());
      if (!parsed.success) { setError(m.resolutionUnavailable); return; }
      setNodes(parsed.data.nodes);
    } catch { setError(m.resolutionUnavailable); }
    finally { setBusy(false); }
  };
  const prepare = async () => {
    if (busy || unknown || prepared || closed || registeredNodeId ||
        (expectedParentLevel !== null && !parentId)) return;
    const prepareRequestId = crypto.randomUUID();
    setRequestId(prepareRequestId); setBusy(true); setError(null);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions/nodes/prepare", {
          method: "POST", cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ideaId, draftUnitId: unit.id,
            parentNodeId: parentId || null, prepareRequestId,
            decisionReason: duplicateIds.length ? reason.trim() || null : null }),
        });
      if (!response.ok) { await fail(response); return; }
      const parsed = preparedSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.draftUnitId !== unit.id ||
          parsed.data.title !== proposal.title ||
          parsed.data.level !== proposal.level ||
          parsed.data.parentNodeId !== (parentId || null)) {
        setUnknown(true); return;
      }
      setPrepared(parsed.data);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const consume = async () => {
    if (busy || unknown || !prepared || registeredNodeId ||
        Date.now() >= Date.parse(prepared.expiresAt)) return;
    setBusy(true); setError(null);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions/nodes/consume", {
          method: "POST", cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decisionId: prepared.decisionId,
            consumeRequestId: crypto.randomUUID(),
            confirmationDigest: prepared.confirmationDigest }),
        });
      if (!response.ok) { await fail(response); return; }
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("state" in result) ||
          result.state !== "consumed" || !("nodeId" in result) ||
          result.nodeId !== prepared.nodeId) { setUnknown(true); return; }
      setRegisteredNodeId(prepared.nodeId);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const readBack = async () => {
    const lookupId = requestId ?? recoveryRequestId.trim();
    if (busy || (!lookupId && !prepared) ||
        (!prepared && !z.uuid().safeParse(lookupId).success)) return;
    setBusy(true);
    try {
      const params: Record<string, string> = prepared ? { decisionId: prepared.decisionId } :
        { prepareRequestId: lookupId };
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions?" + new URLSearchParams(params),
        { cache: "no-store" });
      const value: unknown = await response.json();
      const belongsHere = value && typeof value === "object" &&
        "ideaId" in value && value.ideaId === ideaId &&
        "draftUnitId" in value && value.draftUnitId === unit.id;
      if (belongsHere && "state" in value && value.state === "consumed" &&
          "nodeId" in value && ref.safeParse(value.nodeId).success) {
        setRegisteredNodeId(value.nodeId as string); setUnknown(false);
      } else if (belongsHere && "state" in value &&
          value.state === "prepared" && "decisionId" in value &&
          ref.safeParse(value.decisionId).success) {
        setReadbackPreparedId(value.decisionId as string); setUnknown(true);
      } else setUnknown(true);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    const decisionId = prepared?.decisionId ?? readbackPreparedId;
    if (!decisionId || busy || registeredNodeId) return;
    setBusy(true); setError(null);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions/cancel", {
          method: "POST", cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decisionId }),
        });
      if (!response.ok) { await fail(response); return; }
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !("state" in value) ||
          value.state !== "cancelled") { setUnknown(true); return; }
      setClosed(true); setPrepared(null); setUnknown(false);
      setReadbackPreparedId(null); setError(m.nodeRegistrationCancelled);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  return <section className="space-y-2 rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
    <h5 className="font-medium">{m.nodeRegistrationTitle} · {proposal.title}</h5>
    <p className="text-sm">{m.nodeRegistrationHint}</p>
    {expectedParentLevel ? <><button type="button" onClick={() => void load()}
      disabled={busy || unknown}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.resolutionLoad}</button>
      <label className="block text-sm">{m.nodeRegistrationParent}
        <select value={parentId} disabled={busy || !!prepared || unknown}
          onChange={(event) => { setParentId(event.target.value);
            setDuplicateIds([]); setReason(""); }}
          className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2">
          <option value="">{m.resolutionChoose}</option>
          {nodes.filter((node) => node.level === expectedParentLevel)
            .map((node) => <option key={node.ref} value={node.ref}>
              {node.ref} · r{node.revision}</option>)}
        </select></label></> : <p>{m.nodeRegistrationRoot}</p>}
    {duplicateIds.length > 0 ? <p role="status">
      {m.storyRegistrationDuplicateReason} {duplicateIds.join(", ")}</p> : null}
    {!prepared && !registeredNodeId && !closed ? <>{duplicateIds.length > 0 ?
      <label className="block text-sm">
      {m.resolutionReason}
      <textarea value={reason} onChange={(event) => setReason(event.target.value)}
        maxLength={500} disabled={busy || unknown}
        className="mt-1 w-full rounded border border-zinc-400 bg-transparent p-2" />
    </label> : null}<button type="button" onClick={() => void prepare()}
      disabled={busy || unknown || (expectedParentLevel !== null && !parentId) ||
        (duplicateIds.length > 0 && reason.trim().length < 3)}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.nodeRegistrationPrepare}</button></> : null}
    {prepared ? <div className="space-y-1 text-sm">
      <p>{m.storyRegistrationDecisionId}: <code>{prepared.decisionId}</code></p>
      <p>{m.storyRegistrationDigest}: <code className="break-all">
        {prepared.confirmationDigest}</code></p>
      <p>{m.storyRegistrationExpires}: {prepared.expiresAt}</p>
      <p>{m.storyRegistrationDuplicates}: {prepared.duplicateCandidateIds.join(", ") || "—"}</p>
      {!registeredNodeId ? <button type="button" onClick={() => void consume()}
        disabled={busy || unknown}
        className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
        {m.nodeRegistrationConsume}</button> : null}
    </div> : null}
    {requestId ? <p className="text-xs">{m.storyRegistrationRequestId}: <code>
      {requestId}</code></p> : null}
    {registeredNodeId ? <p role="status">{m.nodeRegistrationRegistered} · <code>
      {registeredNodeId}</code></p> : null}
    {unknown ? <p role="alert">{m.storyRegistrationUnknown}</p> : null}
    {!prepared && !requestId ? <label className="block text-sm">
      {m.storyRegistrationRecoveryId}
      <input value={recoveryRequestId}
        onChange={(event) => setRecoveryRequestId(event.target.value)}
        className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2" />
    </label> : null}
    {unknown || prepared || recoveryRequestId ? <button type="button"
      onClick={() => void readBack()} disabled={busy}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.storyRegistrationReadBack}</button> : null}
    {((prepared && !unknown) || readbackPreparedId) && !registeredNodeId && !closed ?
      <button type="button" onClick={() => void cancel()} disabled={busy}
        className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
        {m.storyRegistrationCancel}</button> : null}
    {reauth ? <a className="underline"
      href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>
      {m.analysisResultReauth}</a> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

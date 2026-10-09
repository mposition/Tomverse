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
const catalog = z.object({ nodes: z.array(z.object({ ref: id,
  level: z.enum(["initiative", "epic", "feature"]),
  parentRef: id.nullable(), revision: z.number().int().nonnegative(),
  contentDigest: digest, state: z.literal("active") }).strict()).max(1_000) }).strict();
const preparedSchema = z.object({ state: z.literal("prepared"),
  decisionId: id, confirmationDigest: digest, expiresAt: z.string().datetime(),
  draftUnitId: id,
  action: z.enum(["select_existing_node", "link_existing_node"]),
  targetNodeId: id, targetRevision: z.number().int().nonnegative(),
  level: z.enum(["initiative", "epic", "feature"]), title: z.string(),
  targetCreated: z.literal(false), retryWrite: z.literal(false),
  auditId: id }).strict();
type Prepared = z.infer<typeof preparedSchema>;

export function AmuxIdeaNodeSelectionPanel({ ideaId, unit }: {
  ideaId: string; unit: AmuxVisibleAnalysisUnit;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const proposal = unit.proposal;
  const [nodes, setNodes] = useState<z.infer<typeof catalog>["nodes"]>([]);
  const [targetId, setTargetId] = useState("");
  const [action, setAction] = useState<"select_existing_node" | "link_existing_node">(
    "select_existing_node");
  const [reason, setReason] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [recoveryId, setRecoveryId] = useState("");
  const [readbackId, setReadbackId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (unit.decisionState !== "proposed" || proposal?.kind !== "node") return null;

  const fail = async (response: Response) => {
    const value: unknown = await response.json().catch(() => null);
    const code = value && typeof value === "object" && "error" in value &&
      typeof value.error === "string" ? value.error : "unavailable";
    if (response.status === 428) setReauth(true);
    if (code === "outcome_unknown") setUnknown(true);
    else setError(m.nodeSelectionFailed(code));
  };
  const load = async () => {
    if (busy || unknown) return;
    setBusy(true); setError(null);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions/nodes/catalog?" +
        new URLSearchParams({ ideaId }), { cache: "no-store" });
      if (!response.ok) { await fail(response); return; }
      const parsed = catalog.safeParse(await response.json());
      if (!parsed.success) { setError(m.resolutionUnavailable); return; }
      setNodes(parsed.data.nodes);
    } catch { setError(m.resolutionUnavailable); }
    finally { setBusy(false); }
  };
  const prepare = async () => {
    if (busy || unknown || prepared || selectedId || cancelled || !targetId ||
        (action === "link_existing_node" && reason.trim().length < 3)) return;
    const prepareRequestId = crypto.randomUUID();
    setRequestId(prepareRequestId); setBusy(true); setError(null); setReauth(false);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions/nodes/select/prepare", {
          method: "POST", cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ideaId, draftUnitId: unit.id,
            targetNodeId: targetId, action, prepareRequestId,
            decisionReason: action === "link_existing_node" ? reason.trim() : null }),
        });
      if (!response.ok) { await fail(response); return; }
      const parsed = preparedSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.draftUnitId !== unit.id ||
          parsed.data.targetNodeId !== targetId ||
          parsed.data.action !== action || parsed.data.level !== proposal.level ||
          parsed.data.title !== proposal.title) { setUnknown(true); return; }
      setPrepared(parsed.data);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const consume = async () => {
    if (!prepared || busy || unknown || selectedId ||
        Date.now() >= Date.parse(prepared.expiresAt)) return;
    setBusy(true); setError(null);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions/nodes/select/consume", {
          method: "POST", cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decisionId: prepared.decisionId,
            consumeRequestId: crypto.randomUUID(),
            confirmationDigest: prepared.confirmationDigest }),
        });
      if (!response.ok) { await fail(response); return; }
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !("state" in value) ||
          value.state !== "consumed" || !("nodeId" in value) ||
          value.nodeId !== prepared.targetNodeId ||
          !("targetCreated" in value) || value.targetCreated !== false) {
        setUnknown(true); return;
      }
      setSelectedId(prepared.targetNodeId);
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
          "nodeId" in value && id.safeParse(value.nodeId).success &&
          "targetCreated" in value && value.targetCreated === false &&
          "action" in value &&
          ["select_existing_node", "link_existing_node"].includes(String(value.action))) {
        setSelectedId(value.nodeId as string); setUnknown(false);
      } else if (belongsHere && "state" in value && value.state === "prepared" &&
          "decisionId" in value && id.safeParse(value.decisionId).success) {
        setReadbackId(value.decisionId as string); setUnknown(true);
      } else setUnknown(true);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    const decisionId = prepared?.decisionId ?? readbackId;
    if (!decisionId || busy || selectedId || cancelled) return;
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
      setCancelled(true); setPrepared(null); setReadbackId(null); setUnknown(false);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  return <section className="space-y-2 rounded border border-zinc-300 p-3 dark:border-zinc-700">
    <h5 className="font-medium">{m.nodeSelectionTitle} · {proposal.title}</h5>
    <p className="text-xs">{m.nodeSelectionHint}</p>
    <button type="button" onClick={() => void load()} disabled={busy || unknown}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.resolutionLoad}</button>
    {!prepared && !selectedId && !cancelled ? <>
      <label className="block">{m.nodeSelectionTarget}
        <select value={targetId} disabled={busy || unknown}
          onChange={(event) => setTargetId(event.target.value)}
          className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2">
          <option value="">{m.resolutionChoose}</option>
          {nodes.filter((node) => node.level === proposal.level).map((node) =>
            <option key={node.ref} value={node.ref}>
              {node.ref} · r{node.revision}</option>)}</select></label>
      <label className="block">{m.nodeSelectionAction}
        <select value={action} disabled={busy || unknown}
          onChange={(event) => setAction(event.target.value as typeof action)}
          className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2">
          <option value="select_existing_node">{m.nodeSelectionSelect}</option>
          <option value="link_existing_node">{m.nodeSelectionLink}</option>
        </select></label>
      {action === "link_existing_node" ? <label className="block">
        {m.unitRejectReason}
        <textarea value={reason} maxLength={500} disabled={busy || unknown}
          onChange={(event) => setReason(event.target.value)}
          className="mt-1 w-full rounded border border-zinc-400 bg-transparent p-2" />
      </label> : null}
      <button type="button" onClick={() => void prepare()}
        disabled={busy || unknown || !targetId ||
          (action === "link_existing_node" && reason.trim().length < 3)}
        className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
        {m.nodeSelectionPrepare}</button>
    </> : null}
    {prepared ? <div className="space-y-1 text-xs">
      <p>{m.nodeSelectionTarget}: {prepared.targetNodeId} · r{prepared.targetRevision}</p>
      <p>{m.storyRegistrationDigest}: <code className="break-all">
        {prepared.confirmationDigest}</code></p>
      <p>{m.storyRegistrationExpires}: {prepared.expiresAt}</p>
      {!selectedId ? <button type="button" onClick={() => void consume()}
        disabled={busy || unknown}
        className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
        {m.nodeSelectionConsume}</button> : null}
    </div> : null}
    {requestId ? <p className="break-all text-xs">{m.storyRegistrationRequestId}: {requestId}</p> : null}
    {!prepared && !requestId ? <label className="block text-xs">
      {m.storyRegistrationRecoveryId}
      <input value={recoveryId} onChange={(event) => setRecoveryId(event.target.value)}
        className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2" />
    </label> : null}
    {unknown ? <p role="alert">{m.storyRegistrationUnknown}</p> : null}
    {selectedId ? <p role="status">{m.nodeSelectionDone} · {selectedId}</p> : null}
    {cancelled ? <p role="status">{m.storyRegistrationCancelled}</p> : null}
    {unknown || prepared || recoveryId ? <button type="button"
      onClick={() => void readBack()} disabled={busy}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.storyRegistrationReadBack}</button> : null}
    {readbackId ? <p className="break-all text-xs">
      {m.storyRegistrationDecisionId}: {readbackId}</p> : null}
    {(prepared || readbackId) && !selectedId && !cancelled ? <button type="button"
      onClick={() => void cancel()} disabled={busy}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.storyRegistrationCancel}</button> : null}
    {reauth ? <a className="underline"
      href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>
      {m.analysisResultReauth}</a> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

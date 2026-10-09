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
const catalog = z.object({ features: z.array(z.object({ ref: id,
  level: z.literal("feature"), parentRef: id,
  revision: z.number().int().nonnegative(),
  contentDigest: digest, state: z.literal("active") }).strict()),
  cards: z.array(z.object({ ref: id,
    sourceSystem: z.literal("admin-idea-v4"),
    cardType: z.enum(["story", "task"]),
    storyKind: z.enum(["general", "bug"]).nullable(),
    featureRef: id, revision: z.number().int().nonnegative(),
    contentDigest: digest,
    status: z.enum(["backlog", "todo", "doing", "review", "done", "blocked"]),
  }).strict()).max(1_000) }).strict();
const preparedSchema = z.object({ state: z.literal("prepared"),
  decisionId: id, confirmationDigest: digest, expiresAt: z.string().datetime(),
  draftUnitId: id, title: z.string(), cardType: z.enum(["story", "task"]),
  targetCardId: id, targetRevision: z.number().int().nonnegative(),
  featureNodeId: id, targetCreated: z.literal(false),
  retryWrite: z.literal(false), auditId: id }).strict();
type Prepared = z.infer<typeof preparedSchema>;

export function AmuxIdeaCardLinkPanel({ ideaId, unit }: {
  ideaId: string; unit: AmuxVisibleAnalysisUnit;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const proposal = unit.proposal;
  const [cards, setCards] = useState<z.infer<typeof catalog>["cards"]>([]);
  const [targetId, setTargetId] = useState("");
  const [reason, setReason] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [recoveryId, setRecoveryId] = useState("");
  const [readbackId, setReadbackId] = useState<string | null>(null);
  const [linkedId, setLinkedId] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (unit.decisionState !== "proposed" || proposal?.kind !== "card" ||
      !["story", "task"].includes(proposal.cardType)) return null;
  const target = cards.find((card) => card.ref === targetId);

  const fail = async (response: Response) => {
    const value: unknown = await response.json().catch(() => null);
    const code = value && typeof value === "object" && "error" in value &&
      typeof value.error === "string" ? value.error : "unavailable";
    if (response.status === 428) setReauth(true);
    if (code === "outcome_unknown") setUnknown(true);
    else setError(m.cardLinkFailed(code));
  };
  const load = async () => {
    if (busy || unknown) return;
    setBusy(true); setError(null);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions/cards/link/catalog?" +
        new URLSearchParams({ ideaId }), { cache: "no-store" });
      if (!response.ok) { await fail(response); return; }
      const parsed = catalog.safeParse(await response.json());
      if (!parsed.success) { setError(m.resolutionUnavailable); return; }
      setCards(parsed.data.cards);
    } catch { setError(m.resolutionUnavailable); }
    finally { setBusy(false); }
  };
  const prepare = async () => {
    if (busy || unknown || prepared || linkedId || cancelled || !target ||
        reason.trim().length < 3) return;
    const prepareRequestId = crypto.randomUUID();
    setRequestId(prepareRequestId); setBusy(true); setError(null); setReauth(false);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions/cards/link/prepare", {
          method: "POST", cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ideaId, draftUnitId: unit.id,
            featureNodeId: target.featureRef, targetCardId: target.ref,
            decisionReason: reason.trim(), prepareRequestId }),
        });
      if (!response.ok) { await fail(response); return; }
      const parsed = preparedSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.draftUnitId !== unit.id ||
          parsed.data.targetCardId !== target.ref ||
          parsed.data.targetRevision !== target.revision ||
          parsed.data.cardType !== proposal.cardType ||
          parsed.data.title !== proposal.title) { setUnknown(true); return; }
      setPrepared(parsed.data);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const consume = async () => {
    if (!prepared || busy || unknown || linkedId ||
        Date.now() >= Date.parse(prepared.expiresAt)) return;
    setBusy(true); setError(null);
    try {
      const response = await adminFetch(
        "/api/admin/amux/ideas/unit-decisions/cards/link/consume", {
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
          value.cardId !== prepared.targetCardId ||
          !("targetCreated" in value) || value.targetCreated !== false) {
        setUnknown(true); return;
      }
      setLinkedId(prepared.targetCardId);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const readBack = async () => {
    const lookup: Record<string, string> = prepared ?
      { decisionId: prepared.decisionId } :
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
          "action" in value && value.action === "link_existing_card" &&
          "cardId" in value && id.safeParse(value.cardId).success &&
          "targetCreated" in value && value.targetCreated === false) {
        setLinkedId(value.cardId as string); setUnknown(false);
      } else if (belongsHere && "state" in value && value.state === "prepared" &&
          "decisionId" in value && id.safeParse(value.decisionId).success) {
        setReadbackId(value.decisionId as string); setUnknown(true);
      } else setUnknown(true);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    const decisionId = prepared?.decisionId ?? readbackId;
    if (!decisionId || busy || linkedId || cancelled) return;
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
    <h5 className="font-medium">{m.cardLinkTitle} · {proposal.title}</h5>
    <p className="text-xs">{m.cardLinkHint}</p>
    <button type="button" onClick={() => void load()} disabled={busy || unknown}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.resolutionLoad}</button>
    {!prepared && !linkedId && !cancelled ? <>
      <label className="block">{m.cardLinkTarget}
        <select value={targetId} disabled={busy || unknown}
          onChange={(event) => setTargetId(event.target.value)}
          className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2">
          <option value="">{m.resolutionChoose}</option>
          {cards.filter((card) => card.cardType === proposal.cardType &&
            card.storyKind === proposal.storyKind).map((card) =>
            <option key={card.ref} value={card.ref}>
              {card.ref} · r{card.revision} · {card.featureRef}</option>)}</select>
      </label>
      <label className="block">{m.unitRejectReason}
        <textarea value={reason} maxLength={500} disabled={busy || unknown}
          onChange={(event) => setReason(event.target.value)}
          className="mt-1 w-full rounded border border-zinc-400 bg-transparent p-2" />
      </label>
      <button type="button" onClick={() => void prepare()}
        disabled={busy || unknown || !target || reason.trim().length < 3}
        className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
        {m.cardLinkPrepare}</button>
    </> : null}
    {prepared ? <div className="space-y-1 text-xs">
      <p>{m.cardLinkTarget}: {prepared.targetCardId} · r{prepared.targetRevision}</p>
      <p>{m.storyRegistrationDigest}: <code className="break-all">
        {prepared.confirmationDigest}</code></p>
      <p>{m.storyRegistrationExpires}: {prepared.expiresAt}</p>
      {!linkedId ? <button type="button" onClick={() => void consume()}
        disabled={busy || unknown}
        className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
        {m.cardLinkConsume}</button> : null}
    </div> : null}
    {requestId ? <p className="break-all text-xs">{m.storyRegistrationRequestId}: {requestId}</p> : null}
    {!prepared && !requestId ? <label className="block text-xs">
      {m.storyRegistrationRecoveryId}
      <input value={recoveryId} onChange={(event) => setRecoveryId(event.target.value)}
        className="mt-1 min-h-11 w-full rounded border border-zinc-400 bg-transparent px-2" />
    </label> : null}
    {unknown ? <p role="alert">{m.storyRegistrationUnknown}</p> : null}
    {linkedId ? <p role="status">{m.cardLinkDone} · {linkedId}</p> : null}
    {cancelled ? <p role="status">{m.storyRegistrationCancelled}</p> : null}
    {unknown || prepared || recoveryId ? <button type="button"
      onClick={() => void readBack()} disabled={busy}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.storyRegistrationReadBack}</button> : null}
    {readbackId ? <p className="break-all text-xs">
      {m.storyRegistrationDecisionId}: {readbackId}</p> : null}
    {(prepared || readbackId) && !linkedId && !cancelled ? <button type="button"
      onClick={() => void cancel()} disabled={busy}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.storyRegistrationCancel}</button> : null}
    {reauth ? <a className="underline"
      href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>
      {m.analysisResultReauth}</a> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

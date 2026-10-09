"use client";

import { useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AmuxIdeaCardRegistrationPanel } from
  "@/components/admin/AmuxIdeaStoryRegistrationPanel";
import { AmuxIdeaCardLinkPanel } from
  "@/components/admin/AmuxIdeaCardLinkPanel";
import { AmuxIdeaUnitRejectionPanel } from
  "@/components/admin/AmuxIdeaUnitRejectionPanel";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import type { AmuxVisibleAnalysisUnit } from
  "@/lib/amux/ideaAnalysisResultReadCore";

type Payload = { ideaId: string; groupId: string; requestId: string;
  operation: "split" | "merge"; sourceUnitIds: string[];
  targetUnitIds: string[]; cards: unknown[]; reason: string };
type Preview = { payload: Payload; confirmationDigest: string;
  expiresAt: string; targets: Array<{ id: string; localRef: string;
    bodyDigest: string }> };

const cardBody = (unit: AmuxVisibleAnalysisUnit) => {
  if (unit.proposal?.kind !== "card") return null;
  const { kind: _kind, localId: _localId,
    sourceRefIds: _sourceRefIds, ...rest } = unit.proposal;
  void _kind; void _localId; void _sourceRefIds;
  return rest;
};

export function AmuxIdeaDerivationPanel({ ideaId, chunkIndex, units }: {
  ideaId: string; chunkIndex: number; units: AmuxVisibleAnalysisUnit[];
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const sourceCards = units.filter((unit) => unit.proposal?.kind === "card" &&
    ["proposed", "approved"].includes(unit.decisionState));
  const [operation, setOperation] = useState<"split" | "merge">("split");
  const [sourceUnitIds, setSourceUnitIds] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [cardsJson, setCardsJson] = useState("[]");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknownRequestId, setUnknownRequestId] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [derived, setDerived] = useState<AmuxVisibleAnalysisUnit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [derivedLoaded, setDerivedLoaded] = useState(false);

  const edited = () => { setPreview(null); setApproved(false); setError(null); };
  const useTemplate = () => {
    const source = sourceCards.find((unit) => unit.id === sourceUnitIds[0]);
    const card = source ? cardBody(source) : null;
    if (!card) return;
    const cards = operation === "split"
      ? [{ ...card, title: `${card.title} - A` },
        { ...card, title: `${card.title} - B` }]
      : [card];
    setCardsJson(JSON.stringify(cards, null, 2));
    edited();
  };
  const loadDerived = async (afterId: string | null = null) => {
    setBusy(true); setError(null);
    try {
      const params = new URLSearchParams({ ideaId, chunkIndex: String(chunkIndex) });
      if (afterId) params.set("afterId", afterId);
      const response = await adminFetch(`/api/admin/amux/ideas/derivations/units?${params}`,
        { cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object" ||
          !Array.isArray((body as { units?: unknown }).units)) {
        throw new Error("read_failed");
      }
      const page = body as { units: AmuxVisibleAnalysisUnit[];
        nextCursor: string | null };
      setDerived((current) => afterId ? [...current, ...page.units] : page.units);
      setNextCursor(page.nextCursor);
      setDerivedLoaded(true);
    } catch { setError(m.derivationUnavailable); }
    finally { setBusy(false); }
  };
  const runPreview = async () => {
    setBusy(true); setError(null); setPreview(null); setApproved(false);
    try {
      const cards: unknown = JSON.parse(cardsJson);
      if (!Array.isArray(cards) || cards.length < 1 || cards.length > 40) {
        throw new Error("invalid_cards");
      }
      const payload: Payload = { ideaId, groupId: crypto.randomUUID(),
        requestId: crypto.randomUUID(), operation, sourceUnitIds,
        targetUnitIds: cards.map(() => crypto.randomUUID()),
        cards, reason: reason.trim() };
      const response = await adminFetch("/api/admin/amux/ideas/derivations/preview", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object" ||
          typeof (body as { confirmationDigest?: unknown }).confirmationDigest !== "string" ||
          !Array.isArray((body as { targets?: unknown }).targets)) {
        throw new Error("preview_failed");
      }
      const value = body as { confirmationDigest: string; expiresAt: string;
        targets: Preview["targets"] };
      setPreview({ payload, ...value });
    } catch { setError(m.derivationUnavailable); }
    finally { setBusy(false); }
  };
  const approve = async () => {
    if (!preview || unknownRequestId) return;
    setBusy(true); setError(null);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/derivations/approve", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: preview.payload,
          confirmationDigest: preview.confirmationDigest }),
      });
      const body: unknown = await response.json();
      if (response.ok && body && typeof body === "object" &&
          (body as { state?: unknown }).state === "approved") {
        setApproved(true); setPreview(null);
        await loadDerived();
      } else if (!response.ok && body && typeof body === "object" &&
          (body as { error?: unknown }).error === "outcome_unknown") {
        setUnknownRequestId(preview.payload.requestId);
        setError(m.derivationUnknown);
      } else { setPreview(null); setError(m.derivationUnavailable); }
    } catch {
      setUnknownRequestId(preview.payload.requestId);
      setError(m.derivationUnknown);
    } finally { setBusy(false); }
  };
  const readback = async () => {
    if (!unknownRequestId) return;
    setBusy(true);
    try {
      const params = new URLSearchParams({ requestId: unknownRequestId });
      const response = await adminFetch(`/api/admin/amux/ideas/derivations?${params}`,
        { cache: "no-store" });
      const body: unknown = await response.json();
      if (response.ok && body && typeof body === "object" &&
          (body as { state?: unknown }).state === "approved") {
        setApproved(true); setPreview(null); setUnknownRequestId(null);
        setError(null); await loadDerived();
      } else { setError(m.derivationUnavailable); }
    } catch { setError(m.derivationUnknown); }
    finally { setBusy(false); }
  };

  return <section className="space-y-3 rounded-xl border border-zinc-300 p-4 dark:border-zinc-700"
    aria-label={m.derivationTitle}>
    <h4 className="font-semibold">{m.derivationTitle}</h4>
    <p className="text-xs text-zinc-600 dark:text-zinc-400">{m.derivationHint}</p>
    <label className="block">{m.derivationOperation}
      <select value={operation} onChange={(event) => {
        setOperation(event.target.value as "split" | "merge"); edited(); }}
        className="mt-1 block min-h-11 w-full rounded border border-zinc-400 bg-transparent p-2">
        <option value="split">split</option><option value="merge">merge</option>
      </select>
    </label>
    <fieldset className="space-y-1">
      <legend>{m.derivationSourceIds}</legend>
      {sourceCards.map((unit) => <label key={unit.id} className="flex items-start gap-2">
        <input type="checkbox" checked={sourceUnitIds.includes(unit.id)}
          onChange={(event) => {
            setSourceUnitIds((current) => event.target.checked
              ? [...current, unit.id] : current.filter((id) => id !== unit.id));
            edited();
          }} />
        <span>{unit.localRef} · {unit.proposal?.kind === "card" ? unit.proposal.title : ""}
          <span className="block text-xs">{unit.id}</span></span>
      </label>)}
    </fieldset>
    <label className="block">{m.derivationSourceIds}
      <input value={sourceUnitIds.join(", ")}
        onChange={(event) => {
          setSourceUnitIds(event.target.value.split(",")
            .map((value) => value.trim()).filter(Boolean));
          edited();
        }}
        className="mt-1 w-full rounded border border-zinc-400 bg-transparent p-2 font-mono text-xs" />
    </label>
    <label className="block">{m.derivationReason}
      <textarea value={reason} onChange={(event) => {
        setReason(event.target.value); edited(); }} maxLength={500} rows={2}
        className="mt-1 w-full rounded border border-zinc-400 bg-transparent p-2" />
    </label>
    <button type="button" onClick={useTemplate} disabled={!sourceUnitIds.length || busy}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.derivationCards} · template
    </button>
    <label className="block">{m.derivationCards}
      <textarea value={cardsJson} onChange={(event) => {
        setCardsJson(event.target.value); edited(); }} rows={14}
        className="mt-1 w-full rounded border border-zinc-400 bg-transparent p-2 font-mono text-xs" />
    </label>
    <button type="button" onClick={() => void runPreview()}
      disabled={busy || !!unknownRequestId}
      className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
      {m.derivationPreview}
    </button>
    {preview ? <div className="space-y-2 rounded border border-zinc-300 p-3 text-xs dark:border-zinc-700">
      <p>{preview.payload.operation} · {preview.payload.sourceUnitIds.length} → {preview.targets.length}</p>
      <p className="break-all">{preview.confirmationDigest}</p>
      <p>{preview.expiresAt}</p>
      <ul className="list-disc pl-5">{preview.targets.map((target) => <li key={target.id}>
        {target.localRef} · {target.id} · {target.bodyDigest}
      </li>)}</ul>
      <button type="button" onClick={() => void approve()} disabled={busy}
        className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
        {m.derivationApprove}
      </button>
    </div> : null}
    {unknownRequestId ? <button type="button" onClick={() => void readback()}
      disabled={busy} className="min-h-11 rounded border border-zinc-400 px-3">
      {m.derivationReadback} · {unknownRequestId}
    </button> : null}
    {approved ? <button type="button" onClick={() => {
      setUnknownRequestId(null); setPreview(null); setApproved(false); setError(null);
    }} disabled={busy} className="min-h-11 rounded border border-zinc-400 px-3">
      {m.derivationNew}
    </button> : null}
    {approved ? <p role="status">{m.derivationApproved}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className="space-y-3">
      <button type="button" onClick={() => void loadDerived()} disabled={busy}
        className="min-h-11 rounded border border-zinc-400 px-3">
        {m.derivationLoad}
      </button>
      {derivedLoaded && derived.length === 0 ? <p>{m.derivationNone}</p> : null}
      {derived.map((unit) => <div key={unit.id}
        className="space-y-2 rounded border border-zinc-300 p-3 dark:border-zinc-700">
        <p>{unit.localRef} · {unit.decisionState} · {unit.id}</p>
        {unit.proposal?.kind === "card" ? <p>{unit.proposal.title}</p> : null}
        {unit.decisionState === "proposed" && unit.proposal?.kind === "card" ? <>
          <AmuxIdeaCardRegistrationPanel ideaId={ideaId} unit={unit} />
          <AmuxIdeaCardLinkPanel ideaId={ideaId} unit={unit} />
          <AmuxIdeaUnitRejectionPanel ideaId={ideaId} unit={unit} />
        </> : null}
      </div>)}
      {nextCursor ? <button type="button"
        onClick={() => void loadDerived(nextCursor)} disabled={busy}
        className="min-h-11 rounded border border-zinc-400 px-3">
        {m.derivationMore}
      </button> : null}
    </div>
  </section>;
}

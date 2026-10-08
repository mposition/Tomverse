"use client";

import { useCallback, useEffect, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AmuxAnalysisClaimResolutionPanel } from
  "@/components/admin/AmuxAnalysisClaimResolutionPanel";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxAnalysisBudgetMessages } from "@/lib/adminMessages/amuxAnalysisBudget";
import type { ConfirmedIdeaTransfer } from "@/lib/amux/ideaTransferConfirmationUiCore";

type PriceReply = { state: "profile"; latest: null | {
  id: string; version: number; status: string; expiresAt: string;
  admissible: boolean } };
type HoldReply = { state: "found"; hold: { id: string; previewId: string;
  status: string; reservedMicroUsd: string } } | { state: "not_visible" };

function priceReply(value: unknown): PriceReply | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.state !== "profile") return null;
  const latest = row.latest;
  if (latest === null) return { state: "profile", latest: null };
  if (!latest || typeof latest !== "object" || Array.isArray(latest)) return null;
  const data = latest as Record<string, unknown>;
  return typeof data.id === "string" && Number.isSafeInteger(data.version) &&
    typeof data.status === "string" && typeof data.expiresAt === "string" &&
    typeof data.admissible === "boolean"
    ? { state: "profile", latest: { id: data.id,
      version: data.version as number, status: data.status,
      expiresAt: data.expiresAt, admissible: data.admissible } } : null;
}

function holdReply(value: unknown): HoldReply | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.state === "not_visible") return { state: "not_visible" };
  if (row.state !== "found" || !row.hold || typeof row.hold !== "object") return null;
  const hold = row.hold as Record<string, unknown>;
  return ["id", "previewId", "status", "reservedMicroUsd"].every((field) =>
    typeof hold[field] === "string") ? { state: "found", hold: hold as
      { id: string; previewId: string; status: string; reservedMicroUsd: string } } : null;
}

export function AmuxAnalysisBudgetPanel({ confirmed, available }: {
  confirmed: ConfirmedIdeaTransfer; available: boolean;
}) {
  const m = useAdminMessages(adminAmuxAnalysisBudgetMessages);
  const [price, setPrice] = useState<PriceReply | null>(null);
  const [hold, setHold] = useState<HoldReply | null>(null);
  const [checked, setChecked] = useState(false);
  const [revokeChecked, setRevokeChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingPriceId, setPendingPriceId] = useState<string | null>(null);
  const [pendingRevocationId, setPendingRevocationId] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<"price" | "hold" | null>(null);
  const [failure, setFailure] = useState(false);

  const loadPrice = useCallback(async () => {
    const response = await adminFetch("/api/admin/amux/ideas/analysis-prices?profile=first-live",
      { cache: "no-store" });
    const parsed = response.ok ? priceReply(await response.json()) : null;
    if (!parsed) throw new Error("price_unavailable");
    setPrice(parsed);
    return parsed;
  }, []);

  const loadHold = useCallback(async () => {
    const query = new URLSearchParams({ previewId: confirmed.previewId });
    const response = await adminFetch(`/api/admin/amux/ideas/analysis-reservations?${query}`,
      { cache: "no-store" });
    const parsed = response.ok ? holdReply(await response.json()) : null;
    if (!parsed) throw new Error("reservation_unavailable");
    setHold(parsed);
    return parsed;
  }, [confirmed.previewId]);

  useEffect(() => {
    if (!available) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setPrice(null); setHold(null); setFailure(false); setUnknown(null);
      void Promise.all([loadPrice(), loadHold()]).catch(() => {
        if (active) setFailure(true);
      });
    });
    return () => { active = false; };
  }, [available, loadHold, loadPrice]);

  const latest = price?.latest;
  const current = latest?.status === "approved" && latest.admissible;
  const holdStatus = hold?.state === "found" ? hold.hold.status : null;
  const knownHoldStatus = holdStatus === null || ["reserved", "in_flight",
    "outcome_unknown", "succeeded", "failed", "released", "expired",
    "owner_consumed", "owner_released_unstarted"].includes(holdStatus);

  const approvePrice = async () => {
    if (!available || busy || !price || current || !checked || unknown) return;
    const id = crypto.randomUUID();
    setPendingPriceId(id); setBusy(true); setFailure(false);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/analysis-prices", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, expectedPreviousVersion: latest?.version ?? 0,
          ownerConfirmedWorstTier: true }),
      });
      if (!response.ok) throw new Error("price_unknown");
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" ||
          (body as Record<string, unknown>).priceVersionId !== id) {
        throw new Error("price_unknown");
      }
      await loadPrice(); setPendingPriceId(null);
    } catch { setUnknown("price"); }
    finally { setBusy(false); }
  };

  const revokeUnusablePrice = async () => {
    if (!available || busy || !latest || latest.status !== "approved" ||
        latest.admissible || !revokeChecked || unknown) return;
    setPendingRevocationId(latest.id); setBusy(true); setFailure(false);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/analysis-prices", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceVersionId: latest.id,
          expectedVersion: latest.version }),
      });
      if (!response.ok) throw new Error("price_revocation_unknown");
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" ||
          (body as Record<string, unknown>).priceVersionId !== latest.id) {
        throw new Error("price_revocation_unknown");
      }
      await loadPrice(); setPendingRevocationId(null); setRevokeChecked(false);
    } catch { setUnknown("price"); }
    finally { setBusy(false); }
  };

  const reserve = async () => {
    if (!available || busy || !current || !latest || !confirmed.previewId ||
        hold?.state !== "not_visible" || unknown) return;
    const holdId = crypto.randomUUID();
    setBusy(true); setFailure(false);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/analysis-reservations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holdId, previewId: confirmed.previewId,
          priceVersionId: latest.id }),
      });
      if (!response.ok) throw new Error("reservation_unknown");
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" ||
          (body as Record<string, unknown>).holdId !== holdId) {
        throw new Error("reservation_unknown");
      }
      await loadHold();
    } catch { setUnknown("hold"); }
    finally { setBusy(false); }
  };

  const readBack = async () => {
    if (!unknown || busy) return;
    setBusy(true); setFailure(false);
    try {
      if (unknown === "price") {
        const query = new URLSearchParams({ id: pendingRevocationId ?? pendingPriceId ?? "" });
        const response = await adminFetch(`/api/admin/amux/ideas/analysis-prices?${query}`,
          { cache: "no-store" });
        const body: unknown = response.ok ? await response.json() : null;
        if (!body || typeof body !== "object" ||
            (body as Record<string, unknown>).state !== "found") {
          throw new Error("price_not_visible");
        }
        if (pendingRevocationId &&
            ((body as { price?: { status?: string } }).price?.status !== "revoked")) {
          throw new Error("price_revocation_not_visible");
        }
        await loadPrice(); setPendingPriceId(null);
        setPendingRevocationId(null); setRevokeChecked(false);
      } else {
        const result = await loadHold();
        if (result.state !== "found") throw new Error("hold_not_visible");
      }
      setUnknown(null);
    } catch { setFailure(true); }
    finally { setBusy(false); }
  };

  return <section className="space-y-3 rounded-xl border border-zinc-300 p-4 text-sm dark:border-zinc-700">
    <h4 className="font-semibold">{m.title}</h4>
    {!available ? <p>{m.unavailable}</p> : null}
    {available && (!price || !hold) && !failure ? <p role="status">{m.loading}</p> : null}
    <p>{m.price}</p>
    <a href="https://platform.claude.com/docs/en/models/opus-5-5/overview"
      target="_blank" rel="noopener noreferrer" className="underline">{m.source}</a>
    {available && price && !current && latest?.status !== "approved" && !unknown ? <>
      <label className="flex items-center gap-2"><input type="checkbox" checked={checked}
        onChange={(event) => setChecked(event.target.checked)} />{m.confirm}</label>
      <button type="button" disabled={!checked || busy} onClick={() => void approvePrice()}
        className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">
        {m.approve}
      </button>
    </> : null}
    {latest?.status === "approved" && !current ? <p role="alert">{m.expired}</p> : null}
    {available && latest?.status === "approved" && !current && !unknown ? <>
      <label className="flex items-center gap-2"><input type="checkbox"
        checked={revokeChecked} onChange={(event) =>
          setRevokeChecked(event.target.checked)} />{m.revokeConfirm}</label>
      <button type="button" disabled={!revokeChecked || busy}
        onClick={() => void revokeUnusablePrice()}
        className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">
        {m.revoke}
      </button>
    </> : null}
    {current ? <p role="status">{m.approved}</p> : null}
    {current && hold?.state === "not_visible" && !unknown ? <button type="button"
      disabled={busy} onClick={() => void reserve()}
      className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">
      {m.reserve}
    </button> : null}
    {holdStatus === "reserved" ? <p role="status">{m.reserved}</p> : null}
    {holdStatus === "in_flight" ? <p role="status">{m.inFlight}</p> : null}
    {holdStatus === "outcome_unknown"
      ? <p role="alert">{m.outcomeUnknown}</p> : null}
    {holdStatus === "owner_released_unstarted"
      ? <p role="status">{m.resolution.released}</p> : null}
    {holdStatus === "owner_consumed"
      ? <p role="status">{m.resolution.consumed}</p> : null}
    {holdStatus && ["succeeded", "failed"].includes(holdStatus)
      ? <p role="status">{m.holdSettled}</p> : null}
    {holdStatus === "released" ? <p role="status">{m.holdReleased}</p> : null}
    {holdStatus === "expired" ? <p role="status">{m.holdExpired}</p> : null}
    {holdStatus && !knownHoldStatus ? <p role="status">
      {m.holdOther} <span className="font-mono">{holdStatus}</span>
    </p> : null}
    {hold?.state === "found" && ["in_flight", "outcome_unknown"].includes(hold.hold.status)
      ? <AmuxAnalysisClaimResolutionPanel holdId={hold.hold.id}
          onResolved={() => { void loadHold().catch(() => setFailure(true)); }} /> : null}
    {unknown ? <><p role="alert">{m.unknown}</p><button type="button"
      disabled={busy} onClick={() => void readBack()}
      className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">
      {m.check}
    </button></> : null}
    {failure ? <p role="alert">{m.failed}</p> : null}
    {busy ? <p role="status">{m.checking}</p> : null}
  </section>;
}

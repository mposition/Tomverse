"use client";

import { useEffect, useRef, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

export type AmuxReservationReleasePhase = "checking" | "releasable" | "sending" | "released" |
  "already_released" | "none" | "in_use" | "outcome_unknown" | "disabled" | "unknown" | "unavailable";
type Messages = typeof adminAmuxIdeaProgressMessages.en.reservationRelease;
const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const MICRO_USD = /^[1-9]\d*$/;
const ENDPOINT = "/api/admin/amux/ideas/analysis-reservations";

/** Micro-USD to "US$x.yy", rounded up so a held amount is never understated. */
export function amuxReservationAmount(microUsd: bigint): string {
  const cents = (microUsd + BigInt(9_999)) / BigInt(10_000);
  return `US$${cents / BigInt(100)}.${(cents % BigInt(100)).toString().padStart(2, "0")}`;
}

/**
 * Releases the unused analysis reservations of one idea with one click
 * (operator decision 2026-11-06, which retired Backlog › Cleanup and recovery
 * and its exact-ID lookup). The server picks the idea's holds and releases each
 * through the canonical owner cancellation writer, which re-checks under its
 * locks that the hold is unclaimed with no usage. A claimed or unknown hold is
 * named, never released. A lost reply makes the panel read-back only, including
 * after a reload; the button returns only after a read-back shows a hold the
 * writer would still accept, and that writer cannot release a hold twice.
 * Quiet: shown only when there is something to release or a release to check,
 * for steps where a hold from an earlier preview may still be held.
 */
export function AmuxIdeaReservationReleasePanel({ ideaId, requestId, available, quiet = false }: {
  ideaId: string; requestId: string; available: boolean; quiet?: boolean;
}) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages).reservationRelease;
  const [phase, setPhase] = useState<AmuxReservationReleasePhase>(available ? "checking" : "disabled");
  const [count, setCount] = useState(0);
  const [amount, setAmount] = useState("");
  const [refused, setRefused] = useState(false);
  const [reauthenticate, setReauthenticate] = useState(false);
  const inFlight = useRef(false);
  const storageKey = `amux-idea-reservation-release:${ideaId}`;

  const readBack = async (resolvePending: boolean, keepRefused = false) => {
    if (inFlight.current || !available) return;
    let pending: string | null;
    try { pending = window.sessionStorage.getItem(storageKey); }
    catch { setPhase("unavailable"); return; }
    // Opening the page with an unresolved release stays read-back only until
    // the owner asks for the result.
    if (pending && !resolvePending) { setPhase("unknown"); return; }
    inFlight.current = true;
    setPhase("checking");
    try {
      const response = await adminFetch(`${ENDPOINT}?${new URLSearchParams({ ideaId })}`, { cache: "no-store" });
      if (response.status === 428) { setReauthenticate(true); setPhase(pending ? "unknown" : "unavailable"); return; }
      const body: unknown = await response.json().catch(() => null);
      const row = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
      if (response.status === 409 && row?.error === "analysis_reservation_read_disabled") {
        setPhase("disabled"); return;
      }
      const releasable = Array.isArray(row?.releasable) ? row.releasable as Array<Record<string, unknown>> : null;
      if (!response.ok || row?.state !== "idea" || row.ideaId !== ideaId || !releasable ||
          !releasable.every((hold) => typeof hold.id === "string" && ID.test(hold.id) &&
            typeof hold.reservedMicroUsd === "string" && MICRO_USD.test(hold.reservedMicroUsd)) ||
          typeof row.releasedCount !== "number" ||
          !(row.blocked === null || ["none", "in_use", "outcome_unknown"].includes(String(row.blocked)))) {
        setPhase(pending ? "unknown" : "unavailable"); return;
      }
      // The current read is the verification the unknown outcome waited for.
      if (pending !== null) window.sessionStorage.removeItem(storageKey);
      // A later read replaces an earlier refusal's notice; the read right
      // after the refusal keeps it beside the state that explains it.
      if (!keepRefused) setRefused(false);
      if (releasable.length > 0) {
        setCount(releasable.length);
        setAmount(amuxReservationAmount(releasable.reduce((sum, hold) =>
          sum + BigInt(hold.reservedMicroUsd as string), BigInt(0))));
        setPhase("releasable");
      } else if (row.blocked === "none" && row.releasedCount > 0) setPhase("already_released");
      else setPhase(row.blocked as AmuxReservationReleasePhase);
    } catch { setPhase(pending ? "unknown" : "unavailable"); }
    finally { inFlight.current = false; }
  };

  useEffect(() => {
    queueMicrotask(() => { void readBack(false); });
    // Keyed by idea in the detail; switching ideas remounts this panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ideaId]);

  const release = async () => {
    if (phase !== "releasable" || inFlight.current || !available) return;
    // Persist before the write, so a reload or a step-up still knows a reply may be lost.
    try { window.sessionStorage.setItem(storageKey, ideaId); }
    catch { setPhase("unavailable"); return; }
    inFlight.current = true;
    setPhase("sending"); setRefused(false); setReauthenticate(false);
    let next: AmuxReservationReleasePhase = "unknown";
    try {
      const response = await adminFetch(ENDPOINT, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId, confirmedUnused: true }),
      });
      const body: unknown = await response.json().catch(() => null);
      const row = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
      const released = Array.isArray(row?.released) ? row.released as Array<Record<string, unknown>> : null;
      if (response.ok && row?.ideaId === ideaId && released && released.length > 0 &&
          row.modelCallStarted === false &&
          released.every((receipt) => typeof receipt.auditId === "string" && receipt.auditId !== "")) {
        window.sessionStorage.removeItem(storageKey);
        setCount(released.length);
        next = "released";
      } else if (response.status >= 400 && response.status < 500) {
        // Every 4xx is answered before a commit or from a rolled-back write;
        // a reply after a partial commit is a 503.
        window.sessionStorage.removeItem(storageKey);
        if (response.status === 428) setReauthenticate(true);
        else if (row?.error === "analysis_reservation_disabled") next = "disabled";
        else setRefused(true);
        if (next === "unknown") next = "checking";
      }
    } catch { /* A lost reply keeps the pending marker: only a read-back resolves it. */ }
    finally { inFlight.current = false; }
    setPhase(next);
    if (next === "checking") void readBack(true, true);
  };

  return <AmuxIdeaReservationReleaseView m={m} phase={phase} count={count} amount={amount}
    quiet={quiet} refused={refused} reauthenticateHref={reauthenticate
      ? adminRecentAuthenticationHref(`/admin/amux-backlog?tab=ideas&idea=${encodeURIComponent(requestId)}`) : null}
    onRelease={() => void release()} onReadBack={() => void readBack(true)} />;
}

/** Hook-free view, so each phase's text and control is testable. */
const QUIET_SHOWN: ReadonlySet<AmuxReservationReleasePhase> = new Set(["releasable", "sending", "released", "unknown"]);

export function AmuxIdeaReservationReleaseView({ m, phase, count, amount, quiet = false, refused,
  reauthenticateHref, onRelease, onReadBack }: {
  m: Messages; phase: AmuxReservationReleasePhase; count: number; amount: string; quiet?: boolean;
  refused: boolean; reauthenticateHref: string | null; onRelease: () => void; onReadBack: () => void;
}) {
  if (quiet && !QUIET_SHOWN.has(phase) && !refused) return null;
  const text: Partial<Record<AmuxReservationReleasePhase, string>> = {
    checking: m.checking, sending: m.sending, released: m.released(count), already_released: m.alreadyReleased,
    none: m.none, in_use: m.inUse, outcome_unknown: m.outcomeUnknown, disabled: m.disabled,
    unknown: m.unknown, unavailable: m.unavailable,
  };
  return (
    <section aria-labelledby="amux-reservation-release-heading" data-testid="amux-reservation-release"
      data-phase={phase} className="space-y-2 rounded-lg border border-zinc-800 p-3">
      <h3 id="amux-reservation-release-heading" className="font-medium text-zinc-100">{m.title}</h3>
      {refused ? <p role="alert" className="text-amber-200">{m.refused}</p> : null}
      {phase === "releasable" ? <>
        <p className="text-zinc-300">{m.releasable(amount, count)}</p>
        <button type="button" data-testid="amux-reservation-release-action" onClick={onRelease}
          className="min-h-11 rounded border border-white/20 px-3 py-2 font-medium text-zinc-100">{m.action}</button>
      </> : <p role={phase === "unknown" ? "alert" : "status"}
        className={phase === "unknown" || phase === "unavailable" ? "text-amber-200" : "text-zinc-300"}>
        {text[phase]}</p>}
      {phase === "unknown" || phase === "unavailable" ? (
        <button type="button" data-testid="amux-reservation-release-readback" onClick={onReadBack}
          className="min-h-11 rounded border border-white/20 px-3 py-2 text-zinc-100">{m.readBack}</button>
      ) : null}
      {reauthenticateHref ? <a href={reauthenticateHref}
        className="inline-flex min-h-11 items-center font-medium underline text-blue-200">{m.reauthenticate}</a> : null}
    </section>
  );
}

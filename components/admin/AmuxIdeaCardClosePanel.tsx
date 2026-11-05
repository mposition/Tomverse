"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaCardCloseMessages } from "@/lib/adminMessages/amuxIdeaCardClose";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import type { AmuxIdeaCardCloseOwnerView } from "@/lib/amux/ideaCardCloseService";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300";
const DANGER = `inline-flex min-h-11 items-center rounded-lg border border-red-500 px-4 text-sm font-medium text-red-300 hover:bg-red-500/10 ${FOCUS}`;
const QUIET = `inline-flex min-h-11 items-center rounded-lg border border-zinc-600 px-3 text-sm text-zinc-100 hover:bg-zinc-800 ${FOCUS}`;

type Phase = "idle" | "sending" | "closed" | "kept" | "cancelled" | "gone" | "refused" | "unknown";

/**
 * The owner's direct answer to "close this stalled idea's remaining cards?",
 * which needs no Decision Maker: it is the way out when the question stayed
 * with the operator or a proposal failed. It shows only while the idea has an
 * open question. The request is never resent on its own; an unknown outcome is
 * read back from the page.
 */
export function AmuxIdeaCardClosePanel({ ideaId }: { ideaId: string }) {
  const m = useAdminMessages(adminAmuxIdeaCardCloseMessages);
  const router = useRouter();
  const [question, setQuestion] = useState<AmuxIdeaCardCloseOwnerView | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [closedCards, setClosedCards] = useState(0);
  const [needsReauthentication, setNeedsReauthentication] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let live = true;
    void adminFetch(`/api/admin/amux/ideas/card-close?${new URLSearchParams({ ideaId })}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((body: { question?: AmuxIdeaCardCloseOwnerView | null } | null) => {
        if (live) setQuestion(body?.question ?? null);
      })
      // A read that fails shows nothing: the question stays open for the next visit.
      .catch(() => undefined);
    return () => { live = false; };
  }, [ideaId]);

  if (!question) return null;

  const answer = async (decision: "close" | "keep") => {
    const trimmed = reason.trim();
    if (inFlight.current) return;
    if (trimmed.length < 3) { setError(m.reasonTooShort); return; }
    inFlight.current = true;
    setPhase("sending");
    setError(null);
    setNeedsReauthentication(false);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/card-close", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId, questionId: question.questionId, decision, reason: trimmed,
          ownerConfirmed: true }),
      });
      const body = await response.json().catch(() => null) as { outcome?: string; closedCards?: number } | null;
      if (response.ok && body?.outcome === "closed") {
        setClosedCards(body.closedCards ?? 0);
        setPhase("closed");
        router.refresh();
      } else if (response.ok && (body?.outcome === "kept" || body?.outcome === "cancelled")) {
        setPhase(body.outcome);
        router.refresh();
      } else if (response.ok && (body?.outcome === "not_open" || body?.outcome === "not_found")) {
        setPhase("gone");
        router.refresh();
      } else if ([400, 403, 404, 409, 415, 428, 429].includes(response.status)) {
        setNeedsReauthentication(response.status === 428);
        setPhase("refused");
      } else {
        setPhase("unknown");
      }
    } catch {
      setPhase("unknown");
    } finally { inFlight.current = false; }
  };

  const answered = phase === "closed" || phase === "kept" || phase === "cancelled" || phase === "gone";
  return <section data-testid="amux-idea-card-close" data-state={phase}
    className="space-y-3 rounded-xl border border-amber-500/40 bg-zinc-900 p-4 text-sm">
    <h3 className="font-medium text-zinc-100">{m.title}</h3>
    <p className="text-zinc-300">{m.reasons[question.reasonCode] ?? m.unknownReason}</p>
    {question.handedOff ? <p role="alert" className="text-amber-200">{m.handedOff}</p> : null}
    <div>
      <p className="text-xs text-zinc-400">{m.cardsLabel}</p>
      <ul className="mt-1 space-y-1 text-xs text-zinc-300" data-testid="amux-idea-card-close-cards">
        {question.cards.map((card) => <li key={card.id}>
          <span className="font-mono">{card.displayKey ?? card.id}</span> · {card.status}
        </li>)}
      </ul>
    </div>
    {answered ? null : <>
      <label className="block space-y-1 text-zinc-300">
        <span className="text-xs text-zinc-400">{m.reasonLabel}</span>
        <textarea value={reason} rows={2} maxLength={500} onChange={(event) => setReason(event.target.value)}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-zinc-100" />
      </label>
      {error ? <p role="alert" className="text-red-200">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={phase === "sending"} onClick={() => void answer("close")} className={DANGER}>
          {m.close}
        </button>
        <button type="button" disabled={phase === "sending"} onClick={() => void answer("keep")} className={QUIET}>
          {m.keep}
        </button>
      </div>
    </>}
    {phase === "sending" ? <p role="status">{m.sending}</p> : null}
    {phase === "closed" ? <p role="status" className="text-zinc-100">{m.closed(closedCards)}</p> : null}
    {phase === "kept" ? <p role="status" className="text-zinc-100">{m.kept}</p> : null}
    {phase === "cancelled" ? <p role="status" className="text-amber-200">{m.cancelled}</p> : null}
    {phase === "gone" ? <p role="status" className="text-zinc-300">{m.gone}</p> : null}
    {phase === "unknown" ? <p role="alert" className="text-amber-200">{m.unknown}</p> : null}
    {phase === "refused" ? <p role="alert" className="text-red-200">{m.refused}</p> : null}
    {needsReauthentication ? <a className="underline text-blue-200"
      href={adminRecentAuthenticationHref(`/admin/amux-backlog?tab=ideas`)}>{m.reauthenticate}</a> : null}
  </section>;
}

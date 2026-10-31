"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

type Result = "closed" | "already_closed" | "not_closable" | "not_found" | "outcome_unknown";
type Outcome = { ideaId: string; result: Result };
type Phase = "idle" | "sending" | "done" | "refused" | "unknown";

const RESULTS = new Set<string>(["closed", "already_closed", "not_closable", "not_found",
  "outcome_unknown"]);
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300";
const DANGER = `inline-flex min-h-11 items-center rounded-lg border border-red-500 px-4 text-sm font-medium text-red-300 hover:bg-red-500/10 ${FOCUS}`;
const QUIET = `inline-flex min-h-11 items-center rounded-lg border border-zinc-600 px-3 text-sm text-zinc-100 hover:bg-zinc-800 ${FOCUS}`;

/**
 * Owner close of ideas waiting for the owner. `single` sits in an idea's
 * detail and opens its reason field on a first click (the second click
 * confirms); `selection` is the Ideas list bar, whose reason field opens once
 * something is ticked. One request answers per idea; anything closed or
 * unknown refreshes the server list, which is the read-back. The request is
 * never resent on its own.
 */
export function AmuxIdeaClosePanel({ ideaIds, mode, labelFor, onSelectAll, onClear, onSent }: {
  ideaIds: string[];
  mode: "single" | "selection";
  labelFor?: (ideaId: string) => string;
  onSelectAll?: () => void;
  onClear?: () => void;
  onSent?: () => void;
}) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages).close;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [needsReauthentication, setNeedsReauthentication] = useState(false);
  const inFlight = useRef(false);
  const single = mode === "single";
  const showForm = single ? open : ideaIds.length > 0 || phase !== "idle";

  const close = async () => {
    const trimmed = reason.trim();
    if (inFlight.current) return;
    if (ideaIds.length === 0) { setError(m.noSelection); return; }
    if (trimmed.length < 3) { setError(m.reasonTooShort); return; }
    // The detail's second click is the confirmation; a batch asks once more.
    if (!single && !window.confirm(m.confirm(ideaIds.length))) return;
    inFlight.current = true;
    setPhase("sending");
    setError(null);
    setNeedsReauthentication(false);
    onSent?.();
    try {
      const response = await adminFetch("/api/admin/amux/ideas/close", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaIds, reason: trimmed, ownerConfirmed: true }),
      });
      const body: unknown = await response.json().catch(() => null);
      const listed = response.ok && body && typeof body === "object" &&
        Array.isArray((body as { outcomes?: unknown }).outcomes)
        ? ((body as { outcomes: unknown[] }).outcomes).filter((entry): entry is Outcome =>
          !!entry && typeof entry === "object" &&
          typeof (entry as Outcome).ideaId === "string" &&
          RESULTS.has((entry as Outcome).result))
        : null;
      if (listed) {
        setOutcomes(listed);
        setPhase("done");
        if (listed.some((entry) => entry.result !== "not_found")) {
          setReason("");
          router.refresh();
        }
      } else if ([400, 403, 404, 415, 428, 429].includes(response.status)) {
        setNeedsReauthentication(response.status === 428);
        setPhase("refused");
      } else {
        setPhase("unknown");
        router.refresh();
      }
    } catch {
      setPhase("unknown");
      router.refresh();
    } finally { inFlight.current = false; }
  };

  return <section data-testid={single ? "amux-idea-close" : "amux-idea-close-selected"} data-state={phase}
    className={`space-y-3 text-sm ${single ? "border-t border-zinc-800 pt-3"
      : "rounded-xl border border-zinc-700 bg-zinc-900 p-3"}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="min-w-0 flex-1 text-zinc-300" role={single ? undefined : "status"}>
        {single ? m.hint : ideaIds.length > 0 ? m.selectedCount(ideaIds.length) : m.selectionHint}
      </p>
      {single && !open ? <button type="button" onClick={() => setOpen(true)} className={DANGER}
        data-testid="amux-idea-close-open">{m.open}</button> : null}
      {!single ? <span className="flex flex-wrap gap-2">
        <button type="button" onClick={onSelectAll} className={QUIET}>{m.selectAll}</button>
        {ideaIds.length > 0 ? <button type="button" onClick={onClear} className={QUIET}>
          {m.clearSelection}</button> : null}
      </span> : null}
    </div>
    {showForm ? <div className="space-y-2" data-testid="amux-idea-close-form">
      <label className="block space-y-1">
        <span className="text-zinc-300">{m.reasonLabel}</span>
        <input value={reason} maxLength={500} data-testid="amux-idea-close-reason"
          aria-invalid={error ? true : undefined}
          onChange={(event) => { setReason(event.target.value); setError(null); }}
          className={`min-h-11 w-full rounded-lg border border-zinc-600 bg-zinc-950 px-3 text-zinc-100 ${FOCUS}`} />
      </label>
      {error ? <p role="alert" className="text-red-300">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void close()} data-testid="amux-idea-close-submit"
          className={DANGER} aria-busy={phase === "sending" || undefined}>
          {phase === "sending" ? m.sending : single ? m.confirmSingle : m.actionSelected(ideaIds.length)}
        </button>
        {single ? <button type="button" className={QUIET}
          onClick={() => { setOpen(false); setReason(""); setError(null); }}>{m.cancel}</button> : null}
      </div>
    </div> : null}
    {phase === "done" && outcomes.length > 0 ? (
      <ul className="space-y-1" role="status" data-testid="amux-idea-close-results">
        {outcomes.map((entry) => (
          <li key={entry.ideaId} data-result={entry.result}
            className={entry.result === "closed" || entry.result === "already_closed"
              ? "text-zinc-100" : "text-amber-200"}>
            {labelFor ? `${labelFor(entry.ideaId)} · ` : ""}{m.results[entry.result]}
          </li>
        ))}
      </ul>
    ) : null}
    {phase === "refused" ? <p role="alert" className="text-amber-200">{m.refused}</p> : null}
    {phase === "unknown" ? <p role="alert" className="text-amber-200">{m.unknown}</p> : null}
    {needsReauthentication ? <a className="underline text-blue-200"
      href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>
      {m.reauthenticate}</a> : null}
  </section>;
}

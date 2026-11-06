"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

type Refusal = "not_found" | "not_resubmittable" | "raw_purged" | "outcome_unknown";
type Phase = { kind: "idle" | "sending" | "reauthenticate" } | { kind: "refusal"; result: Refusal }
  | { kind: "refused"; code: string } | { kind: "previous_open"; href: string };

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300";
const PRIMARY = `inline-flex min-h-11 items-center rounded-lg border border-blue-400 px-4 text-sm font-medium text-blue-100 hover:bg-blue-500/10 ${FOCUS}`;
const REFUSALS = new Set<string>(["not_found", "not_resubmittable", "raw_purged", "outcome_unknown"]);
const UUID = /^[0-9a-f-]{36}$/;
const ideaHref = (requestId: string) =>
  `/admin/amux-backlog?tab=ideas&idea=${encodeURIComponent(requestId)}`;

/** Opens the new idea with a full page load. A client push kept the old idea's
 * "not a plan" lines on screen until the owner reloaded (2026-11-06). */
export function openResubmittedIdea(href: string,
  location: Pick<Location, "assign"> = window.location) {
  location.assign(href);
}

/**
 * "Submit again with the same content" for a session idea whose analysis ended
 * with no plan. The server reads the kept text, submits it as a new idea under
 * a request id derived from this one and then closes this idea, so pressing
 * again after an unknown answer finds the same submission. The detail shows
 * it only while the text is kept.
 */
export function AmuxIdeaResubmitPanel({ ideaId }: { ideaId: string }) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages).resubmit;
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const inFlight = useRef(false);

  const send = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase({ kind: "sending" });
    try {
      const response = await adminFetch("/api/admin/amux/ideas/session-resubmit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId }),
      });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      const result = typeof body?.result === "string" ? body.result : null;
      if (response.ok && result === "resubmitted" && typeof body?.requestId === "string" &&
          UUID.test(body.requestId)) {
        const href = ideaHref(body.requestId);
        if (body.previousClosed === true) { openResubmittedIdea(href); return; }
        setPhase({ kind: "previous_open", href });
        router.refresh();
      } else if (result === "refused" && typeof body?.code === "string") {
        setPhase({ kind: "refused", code: body.code });
      } else if (response.status === 428) {
        setPhase({ kind: "reauthenticate" });
      } else {
        setPhase({ kind: "refusal", result: result && REFUSALS.has(result)
          ? result as Refusal : "outcome_unknown" });
      }
    } catch {
      setPhase({ kind: "refusal", result: "outcome_unknown" });
    } finally { inFlight.current = false; }
  };

  return <section data-testid="amux-idea-resubmit" data-state={phase.kind}
    className="space-y-2 border-t border-zinc-800 pt-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="min-w-0 flex-1 text-zinc-300">{m.hint}</p>
      <button type="button" onClick={() => void send()} className={PRIMARY}
        data-testid="amux-idea-resubmit-submit" disabled={phase.kind === "sending"}
        aria-busy={phase.kind === "sending" || undefined}>
        {phase.kind === "sending" ? m.sending : m.action}
      </button>
    </div>
    {phase.kind === "refusal" ? <p role="alert" className="text-amber-200">
      {m.results[phase.result]}</p> : null}
    {phase.kind === "refused" ? <p role="alert" className="text-amber-200">
      {m.results.refused(phase.code)}</p> : null}
    {phase.kind === "previous_open" ? <p role="status" className="text-amber-200">
      {m.previousOpen} <Link href={phase.href} className="underline text-blue-200">{m.openNew}</Link>
    </p> : null}
    {phase.kind === "reauthenticate" ? <a className="underline text-blue-200"
      href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>{m.reauthenticate}</a> : null}
  </section>;
}

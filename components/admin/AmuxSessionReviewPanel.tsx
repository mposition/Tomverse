"use client";

import { useEffect, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { adminFetch } from "@/lib/adminFetch";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import type { AmuxAnalysisSchemaRejectAt } from "@/lib/amux/ideaAnalysisChunkCore";
import { readAmuxSessionReviewReply, type AmuxSessionReview, type AmuxSessionReviewDetail } from
  "@/lib/amux/ideaSessionReviewCore";

type DetailCheck = keyof typeof adminAmuxIdeaProgressMessages.en.sessionReviewDetailChecks;

/** History and cursor codes share one plain sentence; the code itself is shown beside it. */
function detailCheck(detail: AmuxSessionReviewDetail): DetailCheck {
  if (detail.startsWith("history_")) return "history";
  if (detail.startsWith("cursor_")) return "cursor";
  return detail as DetailCheck;
}

/** Schema words only, e.g. "units[3] (card) · taskRole · value_not_allowed". */
function schemaPlace(at: AmuxAnalysisSchemaRejectAt): string {
  return [at.unit === undefined ? null : `units[${at.unit}]${at.kind ? ` (${at.kind})` : ""}`,
    at.field ?? null, at.rule].filter((part) => part !== null).join(" · ");
}

type State = { kind: "loading" } | { kind: "ready"; review: AmuxSessionReview } |
  { kind: "gone" } | { kind: "reauth" } | { kind: "unavailable" };

/** Why this session idea's answer made no plan, read once when the idea is
 * opened: the model's question to the owner, or the closed "not a plan" word.
 * The server enforces the answer's seven-day retention. */
export function AmuxSessionReviewPanel({ ideaId }: { ideaId: string }) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages);
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void (async () => {
      let next: State;
      try {
        const response = await adminFetch(
          `/api/admin/amux/ideas/session-review?${new URLSearchParams({ ideaId })}`,
          { cache: "no-store" });
        if (response.status === 428) next = { kind: "reauth" };
        else if (response.status === 404) next = { kind: "gone" };
        else {
          const review = response.ok ? readAmuxSessionReviewReply(await response.json()) : null;
          next = review ? { kind: "ready", review } : { kind: "unavailable" };
        }
      } catch {
        next = { kind: "unavailable" };
      }
      if (active) setState(next);
    })();
    return () => { active = false; };
  }, [ideaId]);

  return (
    <div className="space-y-2" data-testid="amux-session-review-reason">
      {state.kind === "loading" ? <p role="status" className="text-zinc-400">{m.sessionReviewLoading}</p> : null}
      {state.kind === "ready" && state.review.reason === "owner_question" ? (
        <section aria-labelledby="amux-session-review-question" className="space-y-1 rounded-lg border p-3 border-amber-400/40">
          <h3 id="amux-session-review-question" className="font-medium text-zinc-100">{m.sessionReviewQuestionTitle}</h3>
          <p className="whitespace-pre-wrap break-words text-zinc-100">{state.review.question}</p>
          <p className="text-xs text-zinc-400">{m.sessionReviewQuestionHint}</p>
        </section>
      ) : null}
      {state.kind === "ready" && state.review.reason === "not_a_plan" ?
        <p className="text-zinc-300">{m.sessionReviewNotAPlan}</p> : null}
      {state.kind === "ready" && state.review.reason === "not_a_plan" && state.review.detail ? (
        <p className="text-zinc-300" data-testid="amux-session-review-detail">
          {m.sessionReviewNotAPlanDetail(m.sessionReviewDetailChecks[detailCheck(state.review.detail)],
            state.review.detail)}
        </p>
      ) : null}
      {state.kind === "ready" && state.review.reason === "not_a_plan" && state.review.at ? (
        <p className="text-zinc-300" data-testid="amux-session-review-at">
          {m.sessionReviewNotAPlanAt(schemaPlace(state.review.at))}
        </p>
      ) : null}
      {state.kind === "gone" ? <p className="text-zinc-400">{m.sessionReviewGone}</p> : null}
      {state.kind === "unavailable" ? <p role="alert" className="text-red-200">{m.sessionReviewUnavailable}</p> : null}
      {state.kind === "reauth" ? (
        <a className="block min-h-11 content-center font-medium underline text-blue-200"
          href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>{m.signIn}</a>
      ) : null}
    </div>
  );
}

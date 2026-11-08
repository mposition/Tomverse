"use client";

import { formatAestDateTime } from "@/lib/adminUiCore";
import { Check, Copy, Loader2, RotateCcw, Send, X } from "lucide-react";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { AdminCopyWorkBriefButton } from "@/components/admin/AdminCopyWorkBriefButton";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import type { AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminAutoRouterOptimizerMessages } from "@/lib/adminMessages/autoRouterOptimizer";
import { recommendationIdeaText } from "@/lib/autoRouterRecommendationIdeaText";
import {
  isRecommendationSendable,
  openRecommendations,
  RECOMMENDATION_SENT_STATUS,
  reportFindings,
  type ActionableRecommendation,
  type RecommendationStatus,
} from "@/lib/autoRouterRecommendationsCore";

/** The part of an optimizer cycle these controls read. */
export type RecommendationCycle = { id: string; createdAt: string; summary: unknown };

export const optimizerCycleAnchor = (cycleId: string) => `optimizer-cycle-${cycleId}`;

/** Names one recommendation, for the send in progress and the send that was refused. */
export const recommendationKey = (cycleId: string, index: number) => `${cycleId}:${index}`;

/** What the last press of a send button came to while its answer matters. */
export type RecommendationSendState = {
  sendingKey: string | null;
  failure: { key: string; failure: AdminApiFailure } | null;
};

/**
 * The idea "Send to AMUX" would send, built the way the send route builds it
 * (recommendationIdeaText over the stored report), for pasting into a local CLI.
 */
export const recommendationBrief = (cycle: RecommendationCycle, item: ActionableRecommendation, origin: string) =>
  recommendationIdeaText({
    recommendation: { kind: item.kind, text: item.text },
    findings: reportFindings(cycle.summary),
    cycle: { id: cycle.id, createdAt: cycle.createdAt },
    origin,
  });

type SetStatus = (cycleId: string, index: number, status: RecommendationStatus) => void;
type SendToAmux = (cycleId: string, index: number) => void;

/**
 * One code or setting recommendation's status and its buttons. An owner can send
 * it to AMUX as an idea; the server builds the idea from the stored report
 * (app/api/admin/auto-llm-router/optimizer/recommendations/send/route.ts). A
 * refused send says why here, beside the button that was pressed: the panel's
 * own notice is too far above this list to be seen from it.
 */
export function RecommendationControls({
  cycle,
  item,
  busy,
  canSend,
  sendState,
  onSetStatus,
  onSend,
}: {
  cycle: RecommendationCycle;
  item: ActionableRecommendation;
  busy: boolean;
  canSend: boolean;
  sendState?: RecommendationSendState;
  onSetStatus: SetStatus;
  onSend: SendToAmux;
}) {
  const m = useAdminMessages(adminAutoRouterOptimizerMessages);
  const buttonClass =
    "inline-flex min-h-11 items-center gap-1 rounded-xl border border-zinc-600 px-3 text-xs font-bold text-zinc-200 disabled:opacity-50";
  const key = recommendationKey(cycle.id, item.index);
  const sending = sendState?.sendingKey === key;
  const refused = sendState?.failure?.key === key ? sendState.failure.failure : null;

  return (
    <div className="mt-1" data-testid="admin-auto-router-recommendation-controls">
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid="admin-auto-router-recommendation-status"
          data-status={item.status}
          className={`rounded border px-1 text-[11px] ${
            item.status === RECOMMENDATION_SENT_STATUS
              ? "border-status-success-900 bg-status-success-950/50 font-bold text-status-success-300"
              : "border-zinc-600 text-zinc-400"
          }`}
        >
          {m.recommendationStatuses[item.status]}
          {item.at ? ` · ${formatAestDateTime(item.at, { seconds: true }) ?? "-"}` : ""}
          {item.reason ? ` · ${(m.recommendationFailureReasons as Record<string, string>)[item.reason] ?? item.reason}` : ""}
          {item.amuxIdeaId ? ` · ${item.amuxIdeaId}` : ""}
        </span>
        {item.prUrl ? (
          <a
            href={item.prUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="admin-auto-router-recommendation-pr"
            className="text-xs font-bold text-blue-300 underline underline-offset-4"
          >
            {m.openPr}
          </a>
        ) : null}
        {item.status !== "done" && item.status !== "dismissed" ? (
          <>
            <button
              type="button"
              onClick={() => onSetStatus(cycle.id, item.index, "done")}
              disabled={busy}
              data-testid="admin-auto-router-recommendation-done"
              className={buttonClass}
            >
              <Check className="h-3.5 w-3.5" aria-hidden />
              {m.markDone}
            </button>
            <button
              type="button"
              onClick={() => onSetStatus(cycle.id, item.index, "dismissed")}
              disabled={busy}
              data-testid="admin-auto-router-recommendation-dismiss"
              className={buttonClass}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              {m.dismiss}
            </button>
          </>
        ) : null}
        {item.status === "done" ||
        item.status === "dismissed" ||
        item.status === "failed" ||
        item.status === "sending_to_amux" ||
        item.status === "needs_lookup" ? (
          <button
            type="button"
            onClick={() => onSetStatus(cycle.id, item.index, "open")}
            disabled={busy}
            data-testid="admin-auto-router-recommendation-reopen"
            className={buttonClass}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            {m.reopen}
          </button>
        ) : null}
        {isRecommendationSendable(item.status) ? (
          <button
            type="button"
            onClick={() => onSend(cycle.id, item.index)}
            disabled={busy || !canSend}
            title={canSend ? undefined : m.sendNotAllowed}
            data-testid="admin-auto-router-recommendation-send"
            className={buttonClass}
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}
            {sending ? m.sendingToAmux : m.sendToAmux}
          </button>
        ) : null}
        <AdminCopyWorkBriefButton
          brief={() => recommendationBrief(cycle, item, window.location.origin)}
          labels={{ copy: m.copyBrief, copied: m.briefCopied, failed: m.briefCopyFailed }}
          className={buttonClass}
          testId="admin-auto-router-recommendation-copy-brief"
          icon={<Copy className="h-3.5 w-3.5" aria-hidden />}
        />
      </div>
      {refused ? <AdminApiFailureNotice failure={refused} testId="admin-auto-router-recommendation-send-failure" /> : null}
    </div>
  );
}

/**
 * The open code and setting recommendations across the cycles the panel
 * loaded, newest first. It says how many cycles it read, because the list is
 * only as wide as that (docs/ui-contracts/admin-console-ia.md rule 6).
 */
export function OpenRecommendationsInbox({
  cycles,
  busy,
  canSend,
  sendState,
  onSetStatus,
  onSend,
}: {
  cycles: readonly RecommendationCycle[];
  busy: boolean;
  canSend: boolean;
  sendState?: RecommendationSendState;
  onSetStatus: SetStatus;
  onSend: SendToAmux;
}) {
  const m = useAdminMessages(adminAutoRouterOptimizerMessages);
  const items = openRecommendations(cycles);
  const byId = new Map(cycles.map((cycle) => [cycle.id, cycle]));
  return (
    <div className="mt-5 rounded-2xl border border-zinc-800 p-4" data-testid="admin-auto-router-recommendation-inbox">
      <h3 className="text-sm font-bold text-zinc-200">{m.inboxTitle}</h3>
      <p className="mt-1 text-xs leading-5 text-zinc-400">{m.inboxDescription}</p>
      <p className="mt-1 text-xs text-zinc-500" data-testid="admin-auto-router-recommendation-inbox-count">
        {m.inboxShowing(items.length, cycles.length)}
      </p>
      {items.length === 0 ? <p className="mt-2 text-sm text-zinc-500">{m.inboxEmpty}</p> : null}
      <ul className="mt-2 space-y-3">
        {items.map((item) => {
          const cycle = byId.get(item.cycleId);
          if (!cycle) return null;
          return (
            <li
              key={`${item.cycleId}:${item.index}`}
              data-testid="admin-auto-router-recommendation-open"
              className="rounded-xl border border-zinc-800 p-3 text-xs text-zinc-300"
            >
              <p className="whitespace-pre-wrap">
                <span className="mr-1 rounded border border-zinc-600 px-1 text-[11px] text-zinc-400">
                  {m.recommendationKinds[item.kind]}
                </span>
                {item.text}
              </p>
              <p className="mt-1 text-zinc-500">
                {formatAestDateTime(item.createdAt, { seconds: true }) ?? "-"} ·{" "}
                <a
                  href={`#${optimizerCycleAnchor(item.cycleId)}`}
                  className="font-bold text-blue-300 underline underline-offset-4"
                >
                  {m.cycleLink}
                </a>
              </p>
              <RecommendationControls cycle={cycle} item={item} busy={busy} canSend={canSend} sendState={sendState} onSetStatus={onSetStatus} onSend={onSend} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

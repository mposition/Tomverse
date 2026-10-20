"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ClipboardCopy, RotateCcw, X } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAutoRouterOptimizerMessages } from "@/lib/adminMessages/autoRouterOptimizer";
import {
  buildRecommendationInstruction,
  copyToClipboard,
  openRecommendations,
  reportFindings,
  type ActionableRecommendation,
  type RecommendationStatus,
} from "@/lib/autoRouterRecommendationsCore";

/** The part of an optimizer cycle these controls read. */
export type RecommendationCycle = { id: string; createdAt: string; summary: unknown };

export const optimizerCycleAnchor = (cycleId: string) => `optimizer-cycle-${cycleId}`;

type SetStatus = (cycleId: string, index: number, status: RecommendationStatus) => void;

/**
 * One code or setting recommendation's status, its buttons, and the copy of a
 * work instruction. The instruction is assembled here from the stored report
 * (lib/autoRouterRecommendationsCore.ts): no model call, no user message, and
 * nothing is sent -- the operator pastes it into a coding session.
 */
export function RecommendationControls({
  cycle,
  item,
  busy,
  onSetStatus,
}: {
  cycle: RecommendationCycle;
  item: ActionableRecommendation;
  busy: boolean;
  onSetStatus: SetStatus;
}) {
  const m = useAdminMessages(adminAutoRouterOptimizerMessages);
  const [copied, setCopied] = useState(false);
  const [manualText, setManualText] = useState<string | null>(null);
  const manualRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // Selected for the operator, who only has to copy it.
    if (manualText !== null) manualRef.current?.select();
  }, [manualText]);

  const copyInstruction = async () => {
    const text = buildRecommendationInstruction({
      labels: m.instruction,
      recommendation: { kind: item.kind, text: item.text },
      findings: reportFindings(cycle.summary),
      cycle: { id: cycle.id, createdAt: cycle.createdAt },
      link: `${window.location.origin}/admin/routing#${optimizerCycleAnchor(cycle.id)}`,
    });
    if ((await copyToClipboard(navigator.clipboard, text)) === "copied") {
      setManualText(null);
      setCopied(true);
    } else {
      setCopied(false);
      setManualText(text);
    }
  };

  const buttonClass =
    "inline-flex min-h-11 items-center gap-1 rounded-xl border border-zinc-600 px-3 text-xs font-bold text-zinc-200 disabled:opacity-50";

  return (
    <div className="mt-1" data-testid="admin-auto-router-recommendation-controls">
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid="admin-auto-router-recommendation-status"
          data-status={item.status}
          className="rounded border border-zinc-600 px-1 text-[11px] text-zinc-400"
        >
          {m.recommendationStatuses[item.status]}
          {item.at ? ` · ${new Date(item.at).toLocaleString()}` : ""}
          {item.reason ? ` · ${(m.recommendationFailureReasons as Record<string, string>)[item.reason] ?? item.reason}` : ""}
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
        {item.status === "open" ? (
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
        ) : (
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
        )}
        <button
          type="button"
          onClick={() => void copyInstruction()}
          data-testid="admin-auto-router-recommendation-copy"
          className={buttonClass}
        >
          <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
          {copied ? m.copied : m.copyInstruction}
        </button>
      </div>
      {manualText !== null ? (
        <label className="mt-2 block text-xs font-bold text-zinc-300">
          {m.instructionBoxLabel}
          <p role="status" className="mt-1 font-normal text-amber-200">
            {m.copyFailed}
          </p>
          <textarea
            ref={manualRef}
            readOnly
            value={manualText}
            rows={10}
            data-testid="admin-auto-router-recommendation-manual"
            className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs font-normal text-zinc-200"
          />
        </label>
      ) : null}
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
  onSetStatus,
}: {
  cycles: readonly RecommendationCycle[];
  busy: boolean;
  onSetStatus: SetStatus;
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
                {new Date(item.createdAt).toLocaleString()} ·{" "}
                <a
                  href={`#${optimizerCycleAnchor(item.cycleId)}`}
                  className="font-bold text-blue-300 underline underline-offset-4"
                >
                  {m.cycleLink}
                </a>
              </p>
              <RecommendationControls cycle={cycle} item={item} busy={busy} onSetStatus={onSetStatus} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

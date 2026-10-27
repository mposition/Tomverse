"use client";

import { useState } from "react";
import { adminMessagesFor, type AdminLocale } from "@/lib/adminLocale";
import { adminAiReviewThresholdDraftMessages } from "@/lib/adminMessages/aiReviewPreparation";
import {
  AI_REVIEW_JUDGED_CEILINGS,
  AI_REVIEW_JUDGED_FLOORS,
  emptyJudgedThresholdDraft,
  judgedThresholdProblems,
} from "@/lib/aiReviewJudgedThresholds";
import { downloadAiReviewDraft } from "./AdminAiReviewPreparationPanel";

const field =
  "min-h-10 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-400";
export function AdminAiReviewThresholdDraft({
  locale,
}: {
  locale: AdminLocale;
}) {
  const m = adminMessagesFor(adminAiReviewThresholdDraftMessages, locale);
  const [draft, setDraft] = useState(emptyJudgedThresholdDraft);
  const [downloaded, setDownloaded] = useState(false);
  const problems = judgedThresholdProblems(draft, false);
  const number = (value: string) => (value === "" ? null : Number(value));
  const labels: Record<string, string> = m.labels;
  return (
    <details
      className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5"
      data-testid="ai-review-threshold-draft"
    >
      <summary className="cursor-pointer font-semibold text-zinc-100">
        {m.title}
      </summary>
      <p className="my-4 text-sm text-zinc-400">{m.description}</p>
      <label className="block text-sm text-zinc-200">
        {m.version}
        <input
          className={`${field} mt-2`}
          value={draft.version}
          onChange={(event) =>
            setDraft({ ...draft, version: event.target.value })
          }
        />
      </label>
      <div className="my-5 grid gap-4 sm:grid-cols-2">
        {(["minWilsonLower", "maxWilsonUpper"] as const).map((group) =>
          (group === "minWilsonLower"
            ? AI_REVIEW_JUDGED_FLOORS
            : AI_REVIEW_JUDGED_CEILINGS
          ).map((key) => (
            <label key={key} className="min-w-0 text-sm text-zinc-200">
              {labels[key] ?? key}
              <input
                className={`${field} mt-2`}
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={
                  (draft[group] as Record<string, number | null>)[key] ?? ""
                }
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    [group]: {
                      ...draft[group],
                      [key]: number(event.target.value),
                    },
                  });
                  setDownloaded(false);
                }}
              />
            </label>
          )),
        )}
        {(
          [
            "maxLanguageArmGap",
            "maxTaskTypeArmShortfall",
            "minBlindReviewedCases",
          ] as const
        ).map((key) => (
          <label key={key} className="text-sm text-zinc-200">
            {labels[key] ?? key}
            <input
              className={`${field} mt-2`}
              type="number"
              min={key === "minBlindReviewedCases" ? 1 : 0}
              max={key === "minBlindReviewedCases" ? undefined : 1}
              step={key === "minBlindReviewedCases" ? 1 : 0.01}
              value={draft[key] ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, [key]: number(event.target.value) })
              }
            />
          </label>
        ))}
        <label className="text-sm text-zinc-200">
          {m.negativeSubset}
          <select
            className={`${field} mt-2`}
            value={draft.negativeSubset.policy}
            onChange={(event) =>
              setDraft({
                ...draft,
                negativeSubset:
                  event.target.value === "gate"
                    ? { policy: "gate", maxWilsonUpper: null }
                    : {
                        policy: event.target.value as
                          | "undecided"
                          | "diagnostic",
                      },
              })
            }
          >
            <option value="undecided">{m.undecided}</option>
            <option value="diagnostic">{m.diagnosticOnly}</option>
            <option value="gate">{m.applyCeiling}</option>
          </select>
        </label>
        {draft.negativeSubset.policy === "gate" && (
          <label className="text-sm text-zinc-200">
            {m.negativeCeiling}
            <input
              className={`${field} mt-2`}
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={draft.negativeSubset.maxWilsonUpper ?? ""}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  negativeSubset: {
                    policy: "gate",
                    maxWilsonUpper: number(event.target.value),
                  },
                })
              }
            />
          </label>
        )}
      </div>
      <label className="block text-sm text-zinc-200">
        {m.rationale}
        <textarea
          className={`${field} my-2`}
          value={draft.rationale}
          onChange={(event) =>
            setDraft({ ...draft, rationale: event.target.value })
          }
        />
      </label>
      <p className="mb-3 text-xs text-zinc-400">{m.metricNotice}</p>
      <button
        type="button"
        className="min-h-10 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-100 disabled:opacity-40"
        disabled={problems.length > 0}
        onClick={() => {
          downloadAiReviewDraft("ai-review-judged-thresholds-draft.json", {
            ...draft,
            approvedBy: null,
            approvedAt: null,
          });
          setDownloaded(true);
        }}
      >
        {m.download}
      </button>
      <p role="status" className="mt-3 text-xs text-zinc-400">
        {downloaded ? m.downloaded : m.inputIssues(problems.length)}
      </p>
    </details>
  );
}

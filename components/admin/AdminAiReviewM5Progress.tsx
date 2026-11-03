"use client";
import { adminMessagesFor, type AdminLocale } from "@/lib/adminLocale";
import { adminAiReviewM5ProgressMessages } from "@/lib/adminMessages/aiReviewPreparation";
import type { AiReviewM5Progress } from "@/lib/aiReviewM5Progress";
import { downloadAiReviewDraft } from "./AdminAiReviewPreparationPanel";

export function AdminAiReviewM5Progress({
  progress,
  locale,
}: {
  progress: AiReviewM5Progress;
  locale: AdminLocale;
}) {
  const m = adminMessagesFor(adminAiReviewM5ProgressMessages, locale);
  const recorded = (value: boolean) => (value ? m.recorded : m.notRecorded);
  const rows = [
    [m.candidates, `${progress.candidates} / ${progress.adopted}`],
    [m.frozenSets, String(progress.frozenAdequateSets)],
    [m.thresholdSets, String(progress.signedJudgedThresholds)],
    [
      m.reportConnection,
      {
        unconfigured: m.unconfigured,
        unavailable: m.unavailable,
        available: m.connected,
      }[progress.reportConnection],
    ],
    [
      m.runs,
      `${progress.verifiedRuns} / ${progress.refusedRuns} / ${progress.unreadableReports}`,
    ],
    [m.approvedPairs, String(progress.registeredApprovedPairs)],
    [m.observationPolicy, recorded(progress.observationPolicyRecorded)],
    [m.rollbackDrill, recorded(progress.rollbackDrillRecorded)],
    [m.promotionSignature, recorded(progress.promotionSignatureRecorded)],
  ];
  return (
    <section
      className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5 sm:p-6"
      data-testid="ai-review-m5-progress"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">{m.title}</h2>
          <p className="mt-2 text-sm text-zinc-400">{m.description}</p>
        </div>
        <button
          type="button"
          onClick={() =>
            downloadAiReviewDraft("ai-review-m5-progress.json", {
              kind: "evidence-inventory",
              promotionVerdict: "not-evaluated",
              ...progress,
            })
          }
          className="min-h-10 rounded-lg border border-zinc-700 px-3 text-sm text-zinc-200"
        >
          {m.download}
        </button>
      </div>
      <dl className="mt-5 divide-y divide-zinc-800">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 py-3 text-sm sm:grid-cols-2">
            <dt className="text-zinc-400">{label}</dt>
            <dd className="break-words text-zinc-200">{value}</dd>
          </div>
        ))}
      </dl>
      {progress.reportConnection !== "available" && (
        <p className="mt-4 rounded-lg border border-zinc-700 p-3 text-sm text-zinc-300">
          {m.connectionHelp}
        </p>
      )}
    </section>
  );
}

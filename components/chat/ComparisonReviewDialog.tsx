"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { trackProductEvent } from "@/lib/productAnalyticsClient";

type ReviewMode = "balanced" | "evidence" | "action";

type ReviewSetup = {
  available: boolean;
  reason?: string;
  promptMessageId?: string;
  assistantMessageIds?: string[];
  responses?: Array<{
    messageId: string;
    modelId: string;
    modelName: string;
  }>;
  estimatedCredits?: number;
  reviewerClass?: string;
  freeMonthlyReviews?: number | null;
  disclaimer?: string;
};

type ComparisonReview = {
  id: string;
  result: {
    consensus: string[];
    differences: Array<{
      issue: string;
      positions: Array<{ responseId: "A" | "B" | "C"; position: string }>;
    }>;
    contradictions: string[];
    missingPoints: string[];
    verificationNeeded: string[];
    modelAssessments: Array<{
      responseId: "A" | "B" | "C";
      strengths: string[];
      cautions: string[];
    }>;
    synthesis: string;
    confidence: "low" | "medium" | "high";
    limitations: string[];
  };
  responseMap: Array<{
    responseId: "A" | "B" | "C";
    messageId: string;
    modelId: string;
    modelName: string;
  }>;
  reviewerModelId: string;
  usageCredits: number;
  originalUsageCredits?: number;
  cached: boolean;
  disclaimer: string;
};

const modeKeys: Array<{
  id: ReviewMode;
  label: string;
  description: string;
}> = [
  {
    id: "balanced",
    label: "chat.aiReviewModeBalanced",
    description: "chat.aiReviewModeBalancedDescription",
  },
  {
    id: "evidence",
    label: "chat.aiReviewModeEvidence",
    description: "chat.aiReviewModeEvidenceDescription",
  },
  {
    id: "action",
    label: "chat.aiReviewModeAction",
    description: "chat.aiReviewModeActionDescription",
  },
];

function ReviewList({
  title,
  items,
  emptyLabel,
  tone = "default",
}: {
  title: string;
  items: string[];
  emptyLabel: string;
  tone?: "default" | "warning";
}) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/70">
      <h3 className="text-sm font-black text-zinc-900 dark:text-zinc-100">{title}</h3>
      {items.length ? (
        <ul className="mt-3 space-y-2">
          {items.map((item, index) => (
            <li
              key={`${index}:${item.slice(0, 32)}`}
              className="flex gap-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300"
            >
              <span
                className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${
                  tone === "warning" ? "bg-amber-500" : "bg-blue-500"
                }`}
              />
              <span className="min-w-0 break-words">{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">{emptyLabel}</p>
      )}
    </section>
  );
}

export function ComparisonReviewDialog({
  conversationId,
  open,
  onClose,
}: {
  conversationId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const [setup, setSetup] = useState<ReviewSetup | null>(null);
  const [review, setReview] = useState<ComparisonReview | null>(null);
  const [mode, setMode] = useState<ReviewMode>("balanced");
  const [includeSynthesis, setIncludeSynthesis] = useState(false);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !conversationId) return;
    const controller = new AbortController();
    void fetch(
      `/api/conversations/${conversationId}/comparison-reviews`,
      { cache: "no-store", signal: controller.signal }
    )
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as ReviewSetup & {
          error?: string;
        };
        if (!response.ok) throw new Error(data.error || t("chat.aiReviewPrepareFailed"));
        setSetup(data);
        trackProductEvent(
          "comparison_review_viewed",
          data.responses?.length || 0
        );
      })
      .catch((fetchError) => {
        if (controller.signal.aborted) return;
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : t("chat.aiReviewPrepareFailed")
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [conversationId, open, t]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open, running]);

  const modelNames = useMemo(
    () =>
      new Map(
        (review?.responseMap || []).map((response) => [
          response.responseId,
          response.modelName,
        ])
      ),
    [review]
  );

  if (!open || !conversationId) return null;

  const runReview = async () => {
    if (
      !setup?.available ||
      !setup.promptMessageId ||
      !setup.assistantMessageIds
    ) {
      return;
    }
    setRunning(true);
    setError("");
    trackProductEvent(
      "comparison_review_started",
      setup.responses?.length || 0,
      { review_mode: mode }
    );
    try {
      const response = await fetch(
        `/api/conversations/${conversationId}/comparison-reviews`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            promptMessageId: setup.promptMessageId,
            assistantMessageIds: setup.assistantMessageIds,
            reviewMode: mode,
            includeSynthesis,
          }),
        }
      );
      const data = (await response.json().catch(() => ({}))) as
        | ComparisonReview
        | { error?: string; traceId?: string };
      if (!response.ok || !("result" in data)) {
        const trace = "traceId" in data && data.traceId ? ` (${data.traceId})` : "";
        throw new Error(
          `${"error" in data && data.error ? data.error : t("chat.aiReviewFailed")}${trace}`
        );
      }
      setReview(data);
      trackProductEvent(
        "comparison_review_completed",
        setup.responses?.length || 0,
        {
          review_mode: mode,
          cached: data.cached,
          usage_credits: data.usageCredits,
        }
      );
    } catch (runError) {
      trackProductEvent(
        "comparison_review_failed",
        setup.responses?.length || 0,
        { review_mode: mode }
      );
      setError(
        runError instanceof Error ? runError.message : t("chat.aiReviewFailed")
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[85] flex items-end justify-center bg-black/65 p-0 backdrop-blur-sm sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="comparison-review-title"
    >
      <div className="flex max-h-[calc(100dvh-env(safe-area-inset-top))] w-full flex-col overflow-hidden rounded-t-3xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 sm:max-h-[90dvh] sm:max-w-5xl sm:rounded-3xl">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800 sm:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-blue-600 dark:text-blue-300">
              <Sparkles className="h-4 w-4" />
              <span className="text-xs font-black uppercase tracking-[0.18em]">
                {t("chat.aiReviewEyebrow")}
              </span>
            </div>
            <h2
              id="comparison-review-title"
              className="mt-1 text-lg font-black text-zinc-900 dark:text-zinc-100 sm:text-xl"
            >
              {t("chat.aiReviewTitle")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-zinc-200 text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
            aria-label={t("chat.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
          {loading ? (
            <div className="flex min-h-64 flex-col items-center justify-center text-zinc-500">
              <LoaderCircle className="h-7 w-7 animate-spin text-blue-500" />
              <p className="mt-3 text-sm font-semibold">{t("chat.aiReviewPreparing")}</p>
            </div>
          ) : review ? (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-black text-emerald-600 dark:text-emerald-300">
                  {review.cached
                    ? t("chat.aiReviewCached")
                    : `${review.usageCredits} ${t("chat.aiReviewCreditsUsed")}`}
                </span>
                <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-bold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  {t("chat.aiReviewConfidence")}: {review.result.confidence}
                </span>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <ReviewList
                  title={t("chat.aiReviewConsensus")}
                  items={review.result.consensus}
                  emptyLabel={t("chat.aiReviewNoneFound")}
                />
                <ReviewList
                  title={t("chat.aiReviewContradictions")}
                  items={review.result.contradictions}
                  emptyLabel={t("chat.aiReviewNoneFound")}
                  tone="warning"
                />
              </div>

              <section className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
                <h3 className="text-sm font-black text-zinc-900 dark:text-zinc-100">
                  {t("chat.aiReviewDifferences")}
                </h3>
                {review.result.differences.length ? (
                  <div className="mt-3 space-y-3">
                    {review.result.differences.map((difference, index) => (
                      <article
                        key={`${index}:${difference.issue.slice(0, 32)}`}
                        className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800"
                      >
                        <h4 className="bg-zinc-50 px-3 py-2 text-sm font-bold dark:bg-zinc-950">
                          {difference.issue}
                        </h4>
                        <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                          {difference.positions.map((position) => (
                            <div
                              key={position.responseId}
                              className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[10rem_1fr] sm:gap-3"
                            >
                              <span className="font-black text-blue-600 dark:text-blue-300">
                                {modelNames.get(position.responseId) ||
                                  `${t("chat.aiReviewResponse")} ${position.responseId}`}
                              </span>
                              <span className="break-words leading-6 text-zinc-700 dark:text-zinc-300">
                                {position.position}
                              </span>
                            </div>
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-zinc-500">{t("chat.aiReviewNoneFound")}</p>
                )}
              </section>

              <div className="grid gap-4 md:grid-cols-2">
                <ReviewList
                  title={t("chat.aiReviewMissingPoints")}
                  items={review.result.missingPoints}
                  emptyLabel={t("chat.aiReviewNoneFound")}
                />
                <ReviewList
                  title={t("chat.aiReviewVerificationNeeded")}
                  items={review.result.verificationNeeded}
                  emptyLabel={t("chat.aiReviewNoneFound")}
                  tone="warning"
                />
              </div>

              <section className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
                <h3 className="text-sm font-black text-zinc-900 dark:text-zinc-100">
                  {t("chat.aiReviewModelAssessments")}
                </h3>
                <div className="mt-3 grid gap-3 lg:grid-cols-3">
                  {review.result.modelAssessments.map((assessment) => (
                    <article
                      key={assessment.responseId}
                      className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-950"
                    >
                      <h4 className="font-black text-blue-600 dark:text-blue-300">
                        {modelNames.get(assessment.responseId) || assessment.responseId}
                      </h4>
                      <p className="mt-2 text-xs font-black uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
                        {t("chat.aiReviewStrengths")}
                      </p>
                      <ul className="mt-1 space-y-1 text-sm leading-5 text-zinc-700 dark:text-zinc-300">
                        {assessment.strengths.map((item) => (
                          <li key={item}>• {item}</li>
                        ))}
                      </ul>
                      <p className="mt-3 text-xs font-black uppercase tracking-wide text-amber-600 dark:text-amber-300">
                        {t("chat.aiReviewCautions")}
                      </p>
                      <ul className="mt-1 space-y-1 text-sm leading-5 text-zinc-700 dark:text-zinc-300">
                        {assessment.cautions.map((item) => (
                          <li key={item}>• {item}</li>
                        ))}
                      </ul>
                    </article>
                  ))}
                </div>
              </section>

              {review.result.synthesis && (
                <section className="rounded-2xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-900/60 dark:bg-blue-950/20">
                  <h3 className="text-sm font-black text-blue-900 dark:text-blue-100">
                    {t("chat.aiReviewSynthesis")}
                  </h3>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-blue-950/80 dark:text-blue-100/80">
                    {review.result.synthesis}
                  </p>
                </section>
              )}

              <ReviewList
                title={t("chat.aiReviewLimitations")}
                items={review.result.limitations}
                emptyLabel={review.disclaimer}
                tone="warning"
              />
              <button
                type="button"
                onClick={() => setReview(null)}
                className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 px-4 py-2 text-sm font-bold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                <RefreshCw className="h-4 w-4" />
                {t("chat.aiReviewChangeCriteria")}
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                {t("chat.aiReviewDescription")}
              </p>

              {setup?.available ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {modeKeys.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setMode(item.id)}
                        className={`rounded-2xl border p-4 text-left transition-colors ${
                          mode === item.id
                            ? "border-blue-500 bg-blue-50 ring-2 ring-blue-500/15 dark:bg-blue-950/30"
                            : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-950"
                        }`}
                      >
                        <span className="flex items-center gap-2 text-sm font-black">
                          {mode === item.id && <CheckCircle2 className="h-4 w-4 text-blue-500" />}
                          {t(item.label)}
                        </span>
                        <span className="mt-2 block text-xs leading-5 text-zinc-500">
                          {t(item.description)}
                        </span>
                      </button>
                    ))}
                  </div>

                  <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
                    <input
                      type="checkbox"
                      checked={includeSynthesis}
                      onChange={(event) => setIncludeSynthesis(event.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-zinc-300"
                    />
                    <span>
                      <span className="block text-sm font-black">{t("chat.aiReviewIncludeSynthesis")}</span>
                      <span className="mt-1 block text-xs leading-5 text-zinc-500">
                        {t("chat.aiReviewIncludeSynthesisDescription")}
                      </span>
                    </span>
                  </label>

                  <div className="rounded-2xl bg-zinc-50 p-4 dark:bg-zinc-950">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">
                          {t("chat.aiReviewEstimatedCost")}
                        </p>
                        <p className="mt-1 text-lg font-black">
                          {setup.estimatedCredits} {t("chat.aiReviewCredits")}
                        </p>
                      </div>
                      <div className="text-right text-xs leading-5 text-zinc-500">
                        <p>{setup.reviewerClass} reviewer</p>
                        {setup.freeMonthlyReviews ? (
                          <p>
                            Free: {setup.freeMonthlyReviews} {t("chat.aiReviewPerMonth")}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                  <p className="text-sm leading-6">
                    {setup?.reason || t("chat.aiReviewResponsesRequired")}
                  </p>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="mt-5 flex gap-3 rounded-2xl border border-red-300 bg-red-50 p-4 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
              <p className="min-w-0 break-words text-sm leading-6">{error}</p>
            </div>
          )}
        </div>

        {!loading && !review && setup?.available && (
          <footer className="shrink-0 border-t border-zinc-200 bg-white px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 dark:border-zinc-800 dark:bg-zinc-900 sm:px-6 sm:pb-4">
            <p className="mb-3 text-xs leading-5 text-zinc-500">
              {setup.disclaimer || t("chat.aiReviewDisclaimer")}
            </p>
            <button
              type="button"
              onClick={runReview}
              disabled={running}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-black text-white hover:bg-blue-500 disabled:cursor-wait disabled:opacity-60 sm:ml-auto sm:w-auto"
            >
              {running ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {running
                ? t("chat.aiReviewRunning")
                : `${t("chat.aiReviewRun")} · ${setup.estimatedCredits} ${t("chat.aiReviewCredits")}`}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

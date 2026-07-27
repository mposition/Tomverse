"use client";

import { useId, useState } from "react";
import { ChevronUp, Lock } from "lucide-react";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { FeatureHelpPopover } from "@/components/chat/FeatureHelpPopover";
import { chatHelpCopy } from "@/components/chat/chatHelpCopy";
import { chatWorkspaceGuideHref } from "@/lib/localizedHelpHref";
import { useLanguage } from "@/components/LanguageProvider";
import type { ComparisonReadiness } from "@/lib/comparisonReadiness";

/**
 * Both comparison actions operate on *completed answers*, so they belong to
 * the answers -- not to the composer, which configures the next request. This
 * renders them as their own labelled section that shares the composer's
 * alignment axis inside the bottom workflow dock, rather than as another row
 * of composer controls.
 *
 * Desktop and mobile render the same component so the two shells cannot drift
 * on what the actions are called, which answers they target, or why they are
 * unavailable.
 */

export const QUICK_SUMMARY_CREDITS = 1;
export const AI_REVIEW_CREDITS = 4;

const interpolate = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
    template
  );

type Translate = (key: string) => string;

export function comparisonRailStatusText(
  readiness: ComparisonReadiness,
  t: Translate,
  options: { isBusy?: boolean } = {}
) {
  const total = readiness.comparableCount;
  if (options.isBusy) return t("chat.comparisonRailStatusBusy");
  if (readiness.state === "generating") {
    return interpolate(t("chat.comparisonRailStatusGenerating"), {
      ready: readiness.readyCount,
      total,
      generating: readiness.generatingCount,
    });
  }
  if (readiness.state === "needsMore") {
    return interpolate(t("chat.comparisonRailStatusNeedsMore"), {
      ready: readiness.readyCount,
      total,
    });
  }
  // Ready, but say exactly which answers this will run against: a still
  // streaming panel is not in the comparison, and neither is a failed one.
  const parts = [
    interpolate(t("chat.comparisonRailStatusReady"), {
      ready: readiness.readyCount,
    }),
  ];
  if (readiness.generatingCount > 0) {
    parts.push(
      interpolate(t("chat.comparisonRailStatusGeneratingSuffix"), {
        generating: readiness.generatingCount,
      })
    );
  }
  if (readiness.excludedCount > 0) {
    parts.push(
      interpolate(t("chat.comparisonRailStatusExcludedSuffix"), {
        excluded: readiness.excludedCount,
      })
    );
  }
  return parts.join(" · ");
}

type ComparisonActionRailProps = {
  layout: "desktop" | "mobile";
  readiness: ComparisonReadiness;
  isGuestMode: boolean;
  /**
   * The visible viewport is too short for a full-height dock -- an on-screen
   * keyboard is covering it, or the phone is in landscape. The rail collapses
   * to a single row so the textarea and send button keep their space, and
   * expanding dismisses the keyboard first rather than competing with it.
   */
  isCompactViewport?: boolean;
  isCompareSummaryLoading?: boolean;
  /** A cached summary for this conversation replays at no credit cost. */
  isQuickSummaryCached?: boolean;
  /** Spendable credits, or null when unknown (guest / usage not loaded yet). */
  availableCredits?: number | null;
  onCompareSummary: () => void;
  onComparisonReview: () => void;
  onGuestSignInPrompt: () => void;
};

export function ComparisonActionRail({
  layout,
  readiness,
  isGuestMode,
  isCompactViewport = false,
  isCompareSummaryLoading = false,
  isQuickSummaryCached = false,
  availableCredits = null,
  onCompareSummary,
  onComparisonReview,
  onGuestSignInPrompt,
}: ComparisonActionRailProps) {
  const { t, lang } = useLanguage();
  const helpCopy = chatHelpCopy[lang];
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const statusId = `${baseId}-status`;
  const [isExpandedWhileCompact, setIsExpandedWhileCompact] = useState(false);
  // Expanding is scoped to one compact session: once the keyboard retracts (or
  // the phone returns to portrait) the rail is fully visible on its own, and
  // the next time space runs short it must collapse again rather than staying
  // permanently expanded because of a tap several messages ago.
  const [wasCompact, setWasCompact] = useState(isCompactViewport);
  if (wasCompact !== isCompactViewport) {
    setWasCompact(isCompactViewport);
    if (!isCompactViewport && isExpandedWhileCompact) {
      setIsExpandedWhileCompact(false);
    }
  }

  if (!readiness.isVisible) return null;

  const isMobile = layout === "mobile";
  const quickCredits = isQuickSummaryCached ? 0 : QUICK_SUMMARY_CREDITS;
  const statusText = comparisonRailStatusText(readiness, t, {
    isBusy: isCompareSummaryLoading,
  });

  const creditsShortFor = (cost: number) =>
    availableCredits !== null && cost > 0 && availableCredits < cost;
  const insufficientText = (cost: number) =>
    interpolate(t("chat.comparisonRailStatusInsufficientCredits"), {
      required: cost,
      available: Math.max(0, availableCredits ?? 0),
    });

  const quickBlocked = !readiness.canRun || creditsShortFor(quickCredits);
  const reviewBlocked = !readiness.canRun || creditsShortFor(AI_REVIEW_CREDITS);
  const quickReason = !readiness.canRun
    ? statusText
    : creditsShortFor(quickCredits)
      ? insufficientText(quickCredits)
      : null;
  const reviewReason = !readiness.canRun
    ? statusText
    : creditsShortFor(AI_REVIEW_CREDITS)
      ? insufficientText(AI_REVIEW_CREDITS)
      : null;

  const quickCostLabel = isQuickSummaryCached
    ? t("chat.aiReviewCached")
    : interpolate(t("chat.quickDifferenceSummaryApproximateCost"), {
        credits: QUICK_SUMMARY_CREDITS,
      });
  const quickAccessibleName = [
    t("chat.quickDifferenceSummary"),
    statusText,
    quickCostLabel,
  ].join(" · ");
  const reviewAccessibleName = [
    t("chat.aiReviewButton"),
    statusText,
    `${AI_REVIEW_CREDITS} ${t("chat.aiReviewCredits")}`,
  ].join(" · ");

  // Collapsed only while the visible viewport genuinely cannot afford the full
  // rail; the expand control dismisses the keyboard rather than competing with
  // it for the same rows.
  const isCollapsed = isMobile && isCompactViewport && !isExpandedWhileCompact;

  const sectionClassName = isMobile
    ? `w-full shrink-0 border-t border-zinc-200 bg-white px-2 pt-1.5 dark:border-zinc-800 dark:bg-zinc-950 ${
        isCollapsed ? "pb-1.5" : ""
      }`
    : "w-full shrink-0 border-t border-zinc-200 bg-white px-4 pt-2 dark:border-zinc-800 dark:bg-zinc-950 md:px-6";

  return (
    <section
      data-testid="comparison-action-rail"
      data-layout={layout}
      data-state={readiness.state}
      data-collapsed={isCollapsed ? "true" : "false"}
      data-ready-count={readiness.readyCount}
      data-comparable-count={readiness.comparableCount}
      data-excluded-count={readiness.excludedCount}
      aria-labelledby={titleId}
      className={sectionClassName}
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-1.5">
        <h2 id={titleId} className="sr-only">
          {t("chat.comparisonRailTitle")}
        </h2>
        {isCollapsed ? (
          <button
            type="button"
            data-testid="comparison-action-rail-disclosure"
            aria-expanded={false}
            aria-describedby={statusId}
            onClick={() => {
              // Give the textarea's keyboard a chance to retract before the
              // actions take their rows back.
              const active = document.activeElement;
              if (active instanceof HTMLElement) active.blur();
              setIsExpandedWhileCompact(true);
            }}
            className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 text-[11px] font-black text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
          >
            <span className="min-w-0 truncate">
              {interpolate(t("chat.comparisonRailExpand"), {
                ready: readiness.readyCount,
              })}
            </span>
            <ChevronUp className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
          </button>
        ) : (
          <div
            className={
              isMobile
                ? "grid grid-cols-2 gap-2"
                : "flex flex-wrap items-center gap-2"
            }
          >
            <button
              type="button"
              data-testid="quick-comparison-button"
              onClick={() => {
                if (quickBlocked) return;
                onCompareSummary();
              }}
              aria-disabled={quickBlocked}
              aria-label={quickAccessibleName}
              aria-describedby={statusId}
              className={`flex min-h-11 w-full items-center justify-between gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3 text-[11px] font-black text-blue-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200 md:w-auto md:text-xs ${
                quickBlocked
                  ? "cursor-not-allowed opacity-50"
                  : "hover:bg-blue-100 dark:hover:bg-blue-950"
              }`}
            >
              <span className="min-w-0 truncate">
                {isMobile
                  ? t("chat.quickDifferenceSummaryShort")
                  : t("chat.quickDifferenceSummary")}
              </span>
              <CreditCostBadge
                credits={quickCredits}
                size="xs"
                approximate={!isQuickSummaryCached}
                label={quickCostLabel}
                testId="quick-comparison-credit-cost"
              />
            </button>

            {isGuestMode ? (
              <button
                type="button"
                data-testid="ai-review-guest-locked"
                onClick={onGuestSignInPrompt}
                className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 px-3 text-[11px] font-black text-zinc-600 transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 md:w-auto md:text-xs"
              >
                <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">
                  {t("chat.aiReviewLoginToUnlock")}
                </span>
              </button>
            ) : (
              <div className="flex min-w-0 items-center gap-0.5">
                <button
                  type="button"
                  data-testid="ai-review-button"
                  onClick={() => {
                    if (reviewBlocked) return;
                    onComparisonReview();
                  }}
                  aria-disabled={reviewBlocked}
                  aria-label={reviewAccessibleName}
                  aria-describedby={statusId}
                  className={`flex min-h-11 min-w-0 flex-1 items-center justify-between gap-1.5 rounded-xl bg-blue-600 px-3 text-[11px] font-black text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 md:text-xs ${
                    reviewBlocked ? "cursor-not-allowed opacity-50" : "hover:bg-blue-500"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-br from-cyan-300 via-white to-purple-300"
                    />
                    <span className="min-w-0 truncate">
                      {isMobile
                        ? t("chat.aiReviewButtonShort")
                        : t("chat.aiReviewButton")}
                    </span>
                  </span>
                  <CreditCostBadge
                    credits={AI_REVIEW_CREDITS}
                    size="xs"
                    tone="onColor"
                    label={`${AI_REVIEW_CREDITS} ${t("chat.aiReviewCredits")}`}
                    testId="ai-review-entry-credit-cost"
                    className="border-0 bg-white/20"
                  />
                </button>
                <FeatureHelpPopover
                  title={helpCopy.aiReviewTitle}
                  description={helpCopy.aiReviewDescription}
                  buttonLabel={helpCopy.helpAboutAiReview}
                  learnMoreLabel={helpCopy.learnMore}
                  topic="ai_review"
                  href={chatWorkspaceGuideHref(lang, "ai-review")}
                  mobile={isMobile}
                  align="right"
                  testId={isMobile ? "ai-review-help-mobile" : "ai-review-help"}
                />
              </div>
            )}
          </div>
        )}
        {/*
          One status line for both actions -- the disabled reason, the number
          of answers being compared and any excluded answer all live here
          instead of in a `title` no keyboard or screen-reader user can reach.
        */}
        <p
          id={statusId}
          data-testid="comparison-action-rail-status"
          // A live region rather than role="status": behaviourally identical
          // for assistive tech (polite + atomic is what role=status maps to),
          // but this is a persistent description of the rail, not a transient
          // status message, so it must not be picked up as one.
          aria-live="polite"
          aria-atomic="true"
          // Collapsed, the status goes visually hidden rather than away: the
          // disclosure's own label already carries the answer count, and the
          // whole point of collapsing is to hand those rows back to the
          // composer -- but the description must still be there to be read.
          className={
            isCollapsed
              ? "sr-only"
              : "px-0.5 pb-1.5 text-[10px] font-semibold leading-4 text-zinc-500 dark:text-zinc-400 md:text-[11px]"
          }
        >
          {quickReason ?? reviewReason ?? statusText}
        </p>
      </div>
    </section>
  );
}

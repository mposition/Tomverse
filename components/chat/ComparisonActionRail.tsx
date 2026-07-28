"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronUp, Lock } from "lucide-react";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { FeatureHelpPopover } from "@/components/chat/FeatureHelpPopover";
import { chatHelpCopy } from "@/components/chat/chatHelpCopy";
import { chatWorkspaceGuideHref } from "@/lib/localizedHelpHref";
import { useLanguage } from "@/components/LanguageProvider";
import {
  isComparisonRailSteadyState,
  shouldShowVisualStatus,
  type ComparisonReadiness,
} from "@/lib/comparisonReadiness";

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

/**
 * The cross-review action and its help control. On desktop they stay a tightly
 * coupled pair inside their own box, exactly as before. On mobile they become
 * two siblings of the rail's single row, so the row can divide its width
 * between three items instead of squeezing a 44px help button inside the
 * action's own share of it.
 */
function ReviewActionGroup({
  isMobile,
  children,
}: {
  isMobile: boolean;
  children: ReactNode;
}) {
  if (isMobile) return <>{children}</>;
  return <div className="flex min-w-0 items-center gap-0.5">{children}</div>;
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
  /**
   * The shell's guest-verification surface. Rendered as the last item of the
   * action row, so the real Cloudflare widget sits immediately to the right of
   * the cross-review action -- and after it in DOM and screen-reader order.
   * It renders nothing at all unless verification is actually running.
   */
  verificationSlot?: ReactNode;
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
  verificationSlot = null,
  onCompareSummary,
  onComparisonReview,
  onGuestSignInPrompt,
}: ComparisonActionRailProps) {
  const { t, lang } = useLanguage();
  const helpCopy = chatHelpCopy[lang];
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const statusId = `${baseId}-status`;
  // The two actions cost different numbers of credits, so a single shared
  // description made "not enough credits" read against whichever button the
  // sentence happened to be written for. Each action now owns a description
  // that names its own comparison target, its own price and its own reason for
  // being unavailable.
  const quickDescriptionId = `${baseId}-quick-description`;
  const reviewDescriptionId = `${baseId}-review-description`;
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
  // The accessible *name* is now the action alone. Scope, price and blocked
  // reason live in the description instead of being concatenated into the
  // name, so a screen reader no longer reads the same sentence twice (once as
  // the button's name, once as its description).
  const quickAccessibleName = t("chat.quickDifferenceSummary");
  const reviewAccessibleName = t("chat.aiReviewButton");
  const describeAction = (costLabel: string, reason: string | null) => {
    const parts = [statusText, costLabel];
    if (reason && reason !== statusText) parts.push(reason);
    return parts.join(" · ");
  };
  const quickDescription = describeAction(quickCostLabel, quickReason);
  const reviewDescription = describeAction(
    `${AI_REVIEW_CREDITS} ${t("chat.aiReviewCredits")}`,
    reviewReason
  );

  const isAnyActionUnaffordable =
    creditsShortFor(quickCredits) || creditsShortFor(AI_REVIEW_CREDITS);
  const isSteadyState = isComparisonRailSteadyState({
    readiness,
    isBusy: isCompareSummaryLoading,
    isAnyActionUnaffordable,
  });
  // A short, per-action sentence for the one blocked reason the shared status
  // text cannot express: two prices, one balance. "AI cross-review · 4 credits
  // needed · 2 available" beats a generic "not enough credits" that leaves the
  // 1-credit action looking equally unaffordable.
  const creditShortfallNotes = [
    creditsShortFor(quickCredits)
      ? interpolate(t("chat.comparisonRailStatusInsufficientCreditsFor"), {
          action: t("chat.quickDifferenceSummaryShort"),
          required: quickCredits,
          available: Math.max(0, availableCredits ?? 0),
        })
      : null,
    creditsShortFor(AI_REVIEW_CREDITS)
      ? interpolate(t("chat.comparisonRailStatusInsufficientCreditsFor"), {
          action: t("chat.aiReviewButtonShort"),
          required: AI_REVIEW_CREDITS,
          available: Math.max(0, availableCredits ?? 0),
        })
      : null,
  ].filter((note): note is string => note !== null);
  const visibleStatusText =
    readiness.canRun && creditShortfallNotes.length > 0
      ? creditShortfallNotes.join(" · ")
      : statusText;
  // Only genuinely *changing* progress is announced. The steady description is
  // a persistent property of each button, reachable on focus, and announcing it
  // as a live update every time the rail re-renders is noise.
  const liveAnnouncement =
    readiness.state === "generating" || isCompareSummaryLoading ? statusText : "";

  // Collapsed only while the visible viewport genuinely cannot afford the full
  // rail; the expand control dismisses the keyboard rather than competing with
  // it for the same rows.
  const isCollapsed = isMobile && isCompactViewport && !isExpandedWhileCompact;
  // One policy, both shells (docs/ui-contracts/comparison-action-rail.md).
  // Desktop having the vertical budget for the sentence is not a reason to
  // keep repeating what the panels and the two buttons already say; when the
  // sentence has something to act on, both shells show it.
  const isStatusVisuallyHidden = !shouldShowVisualStatus({
    readiness,
    isBusy: isCompareSummaryLoading,
    isAnyActionUnaffordable,
    isCollapsed,
  });

  // With the sentence gone the action row is the last thing in the rail, so
  // the bottom padding the sentence used to carry moves onto the section --
  // the buttons must not sit flush against the composer, and the rail must
  // not keep an empty row's worth of height either.
  const sectionClassName = isMobile
    ? `w-full shrink-0 border-t border-zinc-200 bg-white px-2 pt-1.5 dark:border-zinc-800 dark:bg-zinc-950 ${
        isStatusVisuallyHidden ? "pb-1.5" : ""
      }`
    : `w-full shrink-0 border-t border-zinc-200 bg-white px-4 pt-2 dark:border-zinc-800 dark:bg-zinc-950 md:px-6 ${
        isStatusVisuallyHidden ? "pb-2" : ""
      }`;

  return (
    <section
      data-testid="comparison-action-rail"
      data-layout={layout}
      data-state={readiness.state}
      data-collapsed={isCollapsed ? "true" : "false"}
      data-steady={isSteadyState ? "true" : "false"}
      data-status-hidden={isStatusVisuallyHidden ? "true" : "false"}
      data-ready-count={readiness.readyCount}
      data-comparable-count={readiness.comparableCount}
      data-excluded-count={readiness.excludedCount}
      aria-labelledby={titleId}
      className={sectionClassName}
    >
      {/*
        No `gap` on this column: the status sentence goes `sr-only` (absolutely
        positioned, out of flow) in the steady state, and a flex gap would keep
        charging the rail for a row that is no longer painted.
      */}
      <div className="mx-auto flex w-full max-w-4xl flex-col">
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
                // One compact row: two actions plus the help control, each
                // sharing the width evenly. The help control is a sibling
                // rather than a passenger inside the cross-review button --
                // sharing a cell with it used to cost that button 44 of its
                // 148 pixels at 320px and truncate its label to "AI ...".
                ? "flex items-center gap-1.5"
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
              aria-describedby={quickDescriptionId}
              className={`flex min-h-11 items-center justify-between gap-1.5 rounded-xl border border-blue-200 bg-blue-50 text-[11px] font-black text-blue-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200 ${
                isMobile ? "min-w-0 flex-1 px-2.5" : "w-full px-3 text-xs md:w-auto"
              } ${
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
                className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 text-[11px] font-black text-zinc-600 transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 ${
                  isMobile ? "min-w-0 flex-1 px-2.5" : "w-full px-3 text-xs md:w-auto"
                }`}
              >
                <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">
                  {t("chat.aiReviewLoginToUnlock")}
                </span>
              </button>
            ) : (
              // Mobile lays the action and its help control out as two
              // siblings of the row; desktop keeps the tight pair it had.
              <ReviewActionGroup isMobile={isMobile}>
                <button
                  type="button"
                  data-testid="ai-review-button"
                  onClick={() => {
                    if (reviewBlocked) return;
                    onComparisonReview();
                  }}
                  aria-disabled={reviewBlocked}
                  aria-label={reviewAccessibleName}
                  aria-describedby={reviewDescriptionId}
                  className={`flex min-h-11 min-w-0 flex-1 items-center justify-between gap-1.5 rounded-xl bg-blue-600 text-[11px] font-black text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${
                    isMobile ? "px-2.5" : "px-3 text-xs"
                  } ${
                    reviewBlocked ? "cursor-not-allowed opacity-50" : "hover:bg-blue-500"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {/* Decoration only, and the first thing to give way: at
                        320px it costs the label the 12px it needs to stay
                        whole. */}
                    {!isMobile && (
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-br from-accent-ai-review-start-300 via-white to-accent-ai-review-end-300"
                      />
                    )}
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
              </ReviewActionGroup>
            )}
            {verificationSlot}
          </div>
        )}
        {/*
          The status line for both actions -- how many answers are in scope,
          what is still generating and what was excluded. It stays in the DOM
          in every state and in both shells; it goes visually hidden (never
          removed) once there is nothing left to act on, because the two
          buttons already carry the same information in their own labels,
          badges and descriptions, and the panels above name the models.
        */}
        <p
          id={statusId}
          data-testid="comparison-action-rail-status"
          data-visually-hidden={isStatusVisuallyHidden ? "true" : "false"}
          className={
            isStatusVisuallyHidden
              ? "sr-only"
              : "mt-1.5 px-0.5 pb-1.5 text-[10px] font-semibold leading-4 text-zinc-500 dark:text-zinc-400 md:text-[11px]"
          }
        >
          {visibleStatusText}
        </p>
        {/*
          Each action's own description: its comparison target, its own price
          and its own reason for being unavailable -- never the other action's.
          Referenced by aria-describedby, so it is reachable on focus without
          costing a row, and never depends on a `title` attribute.
        */}
        <p id={quickDescriptionId} data-testid="quick-comparison-description" className="sr-only">
          {quickDescription}
        </p>
        <p id={reviewDescriptionId} data-testid="ai-review-description" className="sr-only">
          {reviewDescription}
        </p>
        {/*
          Only progress that actually changes under the user gets announced.
          The descriptions above are persistent properties of their buttons,
          so announcing them politely on every re-render would be noise.
        */}
        <p
          data-testid="comparison-action-rail-live"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {liveAnnouncement}
        </p>
      </div>
    </section>
  );
}

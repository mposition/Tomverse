"use client";

import { ArrowRight, Sparkles } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { getLandingCopy } from "./landingContent";
import { ConditionLine, SectionHeading } from "./landingPrimitives";

/**
 * The first feature section: what the product actually does on a normal turn,
 * and the two ways to make sense of the answers it produces.
 *
 * It owns the `how-it-works` anchor the marketing header's "Features" item
 * points at, because this is where the feature run now begins. Moving the
 * anchor here rather than leaving it on the walkthrough is what lets the
 * differentiators sit above the walkthrough without the nav skipping them.
 */
export function ComparisonBasicsSection() {
  const { lang } = useLanguage();
  const content = getLandingCopy(lang);
  const copy = content.compare;
  const models = ["GPT", "Claude", "Gemini"] as const;

  return (
    <section
      id="how-it-works"
      aria-labelledby="landing-compare-heading"
      data-testid="landing-compare-section"
      className="border-b border-zinc-200 py-16 dark:border-zinc-800 sm:py-20"
    >
      <div className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow={copy.eyebrow}
          title={copy.title}
          description={copy.description}
          lang={lang}
          headingId="landing-compare-heading"
        />

        <div className="mt-10 border-y border-zinc-300 dark:border-zinc-700">
          <div className="grid divide-y divide-zinc-200 dark:divide-zinc-800 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {models.map((model, index) => (
              <article
                key={model}
                data-testid={`landing-editorial-model-${model.toLowerCase()}`}
                className="min-w-0 px-[4px] py-[24px] sm:px-[20px] sm:first:pl-0 sm:last:pr-0 lg:px-[32px]"
              >
                <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-600 dark:text-blue-400">
                  {model}
                </p>
                <h3 className="mt-5 break-words text-xl font-black leading-tight sm:text-2xl">
                  {content.preview.answers[index]}
                </h3>
                <div aria-hidden="true" className="mt-6 space-y-2.5">
                  <div className="h-1.5 w-full rounded-full bg-zinc-200 dark:bg-zinc-800" />
                  <div className="h-1.5 w-5/6 rounded-full bg-zinc-200 dark:bg-zinc-800" />
                  <div className="h-1.5 w-2/3 rounded-full bg-zinc-100 dark:bg-zinc-900" />
                </div>
              </article>
            ))}
          </div>
        </div>

        <article
          data-testid="landing-quick-summary-card"
          className="mt-6 min-w-0 overflow-hidden rounded-2xl border border-tomverse-review-border bg-tomverse-review-surface"
        >
          <div className="h-1 bg-blue-600" />
          <div className="grid gap-7 p-[20px] sm:p-[28px] lg:grid-cols-[1fr_auto] lg:items-center">
            <div className="max-w-3xl">
              <p className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-tomverse-review-selected-text dark:text-blue-200">
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                {content.preview.reviewTitle}
              </p>
              <h3 className="mt-4 break-words text-xl font-black text-tomverse-review-selected-text dark:text-white sm:text-2xl">
                {copy.quickSummary.title}
              </h3>
              <p className="mt-3 break-words text-sm leading-6 text-zinc-700 dark:text-zinc-300">
                {copy.quickSummary.description}
              </p>
              {copy.quickSummary.condition && (
                <ConditionLine testId="landing-quick-summary-condition">
                  {copy.quickSummary.condition}
                </ConditionLine>
              )}
            </div>

            <div
              data-testid="landing-editorial-review-items"
              className="grid w-full grid-cols-2 gap-2 lg:w-[310px]"
            >
              {content.preview.reviewItems.map((item) => (
                <span
                  key={item}
                  className="min-w-0 break-words rounded-lg border border-tomverse-review-selected-border/30 bg-white/60 px-[10px] py-[9px] text-center text-[11px] font-bold text-tomverse-review-selected-text dark:bg-black/20 dark:text-zinc-200"
                >
                  {item}
                </span>
              ))}
            </div>
          </div>
          <p className="flex gap-2 border-t border-tomverse-review-selected-border/20 px-[20px] py-[16px] text-sm font-semibold leading-6 text-zinc-700 dark:text-zinc-200 sm:px-[28px]">
            <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
            {copy.aiReviewBridge}
          </p>
        </article>

        <div className="mt-10 grid gap-5 border-t border-zinc-200 pt-8 dark:border-zinc-800 lg:grid-cols-[220px_1fr]">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
            {copy.stepsLabel}
          </p>
          <ol className="grid gap-5 sm:grid-cols-3">
            {copy.steps.map((step, index) => (
              <li key={step} className="min-w-0">
                <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">
                  0{index + 1}
                </span>
                <p className="mt-2 break-words text-sm font-semibold leading-6 text-zinc-800 dark:text-zinc-100">
                  {step}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

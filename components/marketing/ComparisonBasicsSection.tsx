"use client";

import { ArrowRight, Layers, Zap } from "lucide-react";
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
  const copy = getLandingCopy(lang).compare;

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

        <div className="mt-9 grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
          <div className="min-w-0 rounded-3xl border border-zinc-200 bg-zinc-50 p-[20px] dark:border-zinc-800 dark:bg-zinc-900/40 sm:p-[24px]">
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              <Layers className="h-4 w-4" aria-hidden="true" />
              {copy.stepsLabel}
            </p>
            <ol className="mt-4 space-y-3">
              {copy.steps.map((step, index) => (
                <li key={step} className="flex items-start gap-3">
                  <span className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-lg bg-blue-600 text-xs font-bold text-white">
                    {index + 1}
                  </span>
                  <span className="text-sm font-semibold leading-7 text-zinc-800 dark:text-zinc-100">
                    {step}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <article
            data-testid="landing-quick-summary-card"
            className="min-w-0 flex flex-col rounded-3xl border border-zinc-200 bg-white p-[20px] shadow-sm dark:border-zinc-800 dark:bg-zinc-900/30 sm:p-[24px]"
          >
            <span className="flex h-[40px] w-[40px] items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <Zap className="h-5 w-5" aria-hidden="true" />
            </span>
            <h3 className="mt-4 text-lg font-black break-words">{copy.quickSummary.title}</h3>
            <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-300 break-words">
              {copy.quickSummary.description}
            </p>
            {copy.quickSummary.condition && (
              <ConditionLine testId="landing-quick-summary-condition">
                {copy.quickSummary.condition}
              </ConditionLine>
            )}
            <p className="mt-5 flex gap-2 border-t border-zinc-200 pt-4 text-sm font-semibold leading-6 text-zinc-700 dark:border-zinc-800 dark:text-zinc-200">
              <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
              {copy.aiReviewBridge}
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}

"use client";

import Link from "next/link";
import { ArrowRight, ShieldCheck, Sparkles } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { displayHeadingClass } from "@/lib/displayHeading";
import { getLandingCopy } from "./landingContent";
import { ConditionLine } from "./landingPrimitives";
import { AnswerRails } from "./AnswerRails";
import { ProductCapture } from "./ProductCapture";

/**
 * What the product does, told once.
 *
 * V1 split this across two sections, `ComparisonBasicsSection` and
 * `ProductProofSection`, and between them the page repeated the same
 * "one question, three answers, one review" sequence three more times after
 * the hero had already played it: a three-column model row echoing the demo,
 * a four-stage workflow diagram echoing the demo again, and a numbered step
 * list echoing the diagram. None of the three added a fact.
 *
 * So this section keeps the one thing the hero demonstration cannot show --
 * what AI Review actually produces, what it weighs, and where it stops -- and
 * states the loop itself once, as three steps beside it. The composition is
 * deliberately asymmetric: the review output is the argument, the steps are
 * the caption. Three equal cards would have said the opposite.
 *
 * The review panel is one of the two rounded surfaces the page allows (see
 * `landingPrimitives`), because it is a depiction of the product rather than
 * a piece of page furniture. Everything around it is ruled.
 *
 * It owns the `how-it-works` anchor the marketing header points at.
 */

const casePaths = ["/ai-answer-review", "/ai-for-file-analysis", "/compare-ai-models"];

function localizedPath(lang: Language, path: string) {
  return lang === "en" ? path : `/${lang}${path}`;
}

export function AiReviewLoopSection() {
  const { lang } = useLanguage();
  const content = getLandingCopy(lang);
  const copy = content.loop;
  const preview = content.preview;

  return (
    <section
      id="how-it-works"
      aria-labelledby="landing-loop-heading"
      data-testid="landing-loop-section"
      className="border-b border-zinc-200 pb-12 dark:border-zinc-800 sm:pb-24"
    >
      {/*
        The three rails arrive from the hero and merge. This is the one place
        on the page where the reserved cyan/blue/purple gradient appears: it
        marks the join, which is the moment AI Review exists for. Using it
        anywhere else would spend the product's one distinguishing mark on
        decoration.
      */}
      <AnswerRails variant="converge" />
      <div
        aria-hidden="true"
        className="h-1.5 bg-linear-to-r from-accent-ai-review-start-600 via-accent-ai-review-mid-600 to-accent-ai-review-end-600"
      />

      {/*
        The reviewed plane. Full bleed and inverted, once, because the whole
        page is built around three things becoming one here; every other
        section stays on the page's own ground so this reversal keeps meaning
        something.
      */}
      <div className="bg-zinc-950 py-14 text-white sm:py-20 dark:bg-zinc-900">
        <div className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8">
          <h2
            id="landing-loop-heading"
            className={`max-w-3xl break-words text-3xl font-black leading-[1.02] tracking-[-0.03em] sm:text-5xl ${displayHeadingClass(lang)}`}
          >
            {copy.title}
          </h2>
          <p className="mt-5 max-w-2xl break-words text-base leading-7 text-zinc-300">
            {copy.description}
          </p>

          <figure className="m-0 mt-9">
            <div className="overflow-hidden rounded-2xl bg-white shadow-2xl shadow-black/40 dark:bg-zinc-950">
              <ProductCapture
                name="review-findings"
                alt={preview.reviewAlt}
              />
            </div>
            <figcaption className="mt-3 break-words text-xs leading-5 text-zinc-400">
              {preview.disclosure}
            </figcaption>
          </figure>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-[16px] pt-12 sm:px-6 sm:pt-20 lg:px-8">
        <div className="grid gap-8 lg:grid-cols-12 lg:items-start lg:gap-10">
          {/*
            The dominant object. It is the review output rather than a picture
            of the app: every line in it is translated product copy, so it
            cannot drift out of date the way the retired workflow capture did,
            and it invents no credit figure, no percentage and no model verdict.
          */}
          <article
            data-testid="landing-review-anatomy"
            className="landing-reveal min-w-0 overflow-hidden rounded-2xl border border-tomverse-review-border bg-tomverse-review-surface lg:col-span-7"
          >
            {/*
              No gradient edge here. The convergence above owns it, and a mark
              reserved for one moment stops being a mark the second it appears
              twice on the same page.
            */}
            <div className="p-[20px] sm:p-[32px]">
              <p className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-tomverse-review-selected-text dark:text-blue-200">
                <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {preview.reviewTitle}
              </p>

              {/*
                The four findings are not listed again here. The capture in
                the band above shows them, in the product's own rendering,
                with the quotes attached -- listing them a second time in
                plain text is the retelling this redesign exists to remove.
              */}
              <p className="mt-5 break-words text-base font-semibold leading-7 text-zinc-700 dark:text-zinc-200">
                {copy.aiReviewBridge}
              </p>

              <div className="mt-7 border-t border-tomverse-review-selected-border/30 pt-6">
                <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-600 dark:text-zinc-300">
                  {copy.reviewModesLabel}
                </h3>
                <ul className="mt-4 grid gap-2.5">
                  {copy.reviewModes.map((mode) => (
                    <li
                      key={mode}
                      className="flex min-w-0 gap-3 break-words text-sm leading-6 text-zinc-700 dark:text-zinc-300"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-[11px] h-px w-3 shrink-0 bg-blue-500"
                      />
                      {mode}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-7 border-t border-tomverse-review-selected-border/30 pt-6">
                <h3 className="break-words text-lg font-black tracking-[-0.01em]">
                  {copy.dualReviewerLabel}
                </h3>
                <p className="mt-2.5 break-words text-sm leading-6 text-zinc-700 dark:text-zinc-300">
                  {copy.dualReviewer}
                </p>
                <p
                  data-testid="landing-review-terminology"
                  className="mt-4 break-words text-xs leading-5 text-zinc-600 dark:text-zinc-300"
                >
                  {copy.terminologyNote}
                </p>
              </div>
            </div>
          </article>

          <div className="min-w-0 lg:col-span-5">
            {/*
              The loop, stated once. Numbered rows hung off a rule rather than
              three tiles, because these are stages of one thing and equal
              boxes would present them as three separate features.
            */}
            <ol
              data-testid="landing-loop-steps"
              className="landing-reveal border-t-2 border-zinc-950 dark:border-zinc-100"
            >
              {copy.steps.map((step, index) => (
                <li
                  key={step.title}
                  className="grid min-w-0 grid-cols-[38px_1fr] gap-x-3 border-b border-zinc-300 py-[20px] dark:border-zinc-700"
                >
                  <span className="font-mono text-xs font-semibold tabular-nums text-blue-600 dark:text-blue-400">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="min-w-0">
                    <h3 className="break-words text-xl font-black leading-tight tracking-[-0.01em]">
                      {step.title}
                    </h3>
                    <p className="mt-2 break-words text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                      {step.description}
                    </p>
                  </div>
                </li>
              ))}
            </ol>

            <article
              data-testid="landing-quick-summary-card"
              className="landing-reveal mt-7 min-w-0 border-l-2 border-zinc-300 pl-[18px] dark:border-zinc-700"
            >
              <h3 className="break-words text-lg font-black tracking-[-0.01em]">
                {copy.quickSummary.title}
              </h3>
              <p className="mt-2 break-words text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                {copy.quickSummary.description}
              </p>
              {copy.quickSummary.condition && (
                <ConditionLine testId="landing-quick-summary-condition">
                  {copy.quickSummary.condition}
                </ConditionLine>
              )}
            </article>

            {/*
              The boundary belongs in this column, not full width below it.
              The review output on the left is the taller object, so a
              full-width strip left a hole under this column; more to the
              point, the limits read as the third thing in the same argument
              as "what a full review gives you" and "what the fast read gives
              you instead", which is where a visitor is weighing them.
            */}
            <div
              data-testid="landing-review-boundary"
              className="landing-reveal mt-7 flex min-w-0 gap-3 border-l-2 border-amber-500 bg-amber-50 p-[16px] text-xs leading-5 text-amber-950 dark:bg-amber-950/25 dark:text-amber-100"
            >
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p className="min-w-0 break-words">{copy.reviewBoundary}</p>
            </div>
          </div>
        </div>

        {/*
          Three worked examples, as a reading list rather than three tiles.
          They are entry points to pages that carry the detail; giving them
          card weight here made them compete with the review output above.
        */}
        <div className="landing-reveal mt-14 grid gap-6 lg:grid-cols-12 lg:items-start lg:gap-10">
          <div className="min-w-0 lg:col-span-4">
            <h2 className="break-words text-2xl font-black leading-tight tracking-[-0.02em] sm:text-3xl">
              {copy.casesTitle}
            </h2>
            <p className="mt-4 break-words text-sm leading-6 text-zinc-600 dark:text-zinc-400">
              {copy.casesDescription}
            </p>
          </div>
          <ul className="min-w-0 border-t-2 border-zinc-950 dark:border-zinc-100 lg:col-span-8">
            {copy.cases.map((item, index) => (
              <li
                key={item.title}
                className="border-b border-zinc-300 dark:border-zinc-700"
              >
                <Link
                  href={localizedPath(lang, casePaths[index])}
                  className="group grid min-w-0 grid-cols-[38px_1fr_auto] items-baseline gap-x-3 py-[20px] transition-colors"
                >
                  <span className="font-mono text-xs font-semibold tabular-nums text-zinc-600 transition-colors group-hover:text-blue-600 dark:text-zinc-300 dark:group-hover:text-blue-400">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0">
                    <span className="block break-words text-xl font-black leading-tight tracking-[-0.01em] transition-colors group-hover:text-blue-600 dark:group-hover:text-blue-400">
                      {item.title}
                    </span>
                    <span className="mt-2 block break-words text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                      {item.description}
                    </span>
                    {/*
                      Visible, not `sr-only`. This string is translated into
                      all seven locales, and hiding it would put it straight
                      back into the dead-copy category the 2026-07-30 audit
                      was written about. It also names where the row goes,
                      which the arrow alone does not.
                    */}
                    <span className="mt-2.5 block break-words text-sm font-bold text-blue-600 dark:text-blue-400">
                      {item.link}
                    </span>
                  </span>
                  <ArrowRight
                    className="h-4 w-4 shrink-0 translate-y-1 text-zinc-400 transition-transform group-hover:translate-x-1 group-hover:text-blue-600 dark:group-hover:text-blue-400"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

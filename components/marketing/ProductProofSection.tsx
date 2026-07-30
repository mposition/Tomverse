"use client";

import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Code2,
  FileText,
  MessagesSquare,
  Scale,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { getLandingCopy } from "./landingContent";
import { SectionHeading } from "./landingPrimitives";

/**
 * The walkthrough and the AI Review detail.
 *
 * This section used to embed `public/marketing-proof/tomverse-review-workflow.webm`
 * under a "Real product UI" label. That recording was captured on 2026-07-27
 * and still showed "4 credits used" and "Review confidence: medium" -- a cost
 * that was corrected two days later (AI_REVIEW_CREDITS is 8, because two
 * independent reviewers run) and a metric that has since been renamed to
 * source grounding. A recording is the wrong medium for either value: both
 * are server-side and change without anyone re-opening a video editor, so
 * re-recording would only reset the clock on the same defect.
 *
 * What replaces it is a code-native diagram of the same four stages. It
 * carries no cost figure and no product-metric label, is translated like
 * every other string here, costs no download, has no motion to suppress
 * under `prefers-reduced-motion`, and its disclosure says what it is -- an
 * illustration, not a capture.
 */

const casePaths = ["/ai-answer-review", "/ai-for-file-analysis", "/compare-ai-models"];
const caseIcons = [Scale, FileText, Code2];

function localizedPath(lang: Language, path: string) {
  return lang === "en" ? path : `/${lang}${path}`;
}

export function ProductProofSection() {
  const { lang } = useLanguage();
  const copy = getLandingCopy(lang).proof;

  return (
    <section
      id="ai-review"
      aria-labelledby="landing-proof-heading"
      data-testid="landing-proof-section"
      className="border-b border-zinc-200 py-16 dark:border-zinc-800 sm:py-20"
    >
      <div className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow={copy.eyebrow}
          title={copy.title}
          description={copy.description}
          lang={lang}
          headingId="landing-proof-heading"
        />

        <div className="mt-9 grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
          <article
            data-testid="landing-workflow-diagram"
            className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 text-white shadow-2xl shadow-blue-950/20"
          >
            <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3 text-xs font-bold uppercase tracking-wider text-blue-300">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              {copy.workflowLabel}
            </div>
            <ol className="grid gap-3 p-[16px] sm:grid-cols-2">
              {copy.stages.map((stage, index) => (
                <li
                  key={stage.title}
                  className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-[16px]"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-lg bg-blue-600 text-[11px] font-bold text-white">
                      {index + 1}
                    </span>
                    <span className="text-sm font-bold">{stage.title}</span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-zinc-300 break-words">{stage.caption}</p>
                </li>
              ))}
            </ol>
            <div className="border-t border-zinc-800 p-[20px]">
              <h3 className="text-xl font-black break-words">{copy.workflowTitle}</h3>
              <p className="mt-3 text-sm leading-6 text-zinc-300">{copy.workflowBody}</p>
              <p
                data-testid="landing-workflow-disclosure"
                className="mt-3 text-xs font-medium leading-5 text-zinc-400"
              >
                {copy.workflowDisclosure}
              </p>
            </div>
          </article>

          <div className="space-y-3">
            {copy.steps.map((step, index) => (
              <article
                key={step.title}
                className="min-w-0 rounded-2xl border border-zinc-200 bg-zinc-50 p-[16px] dark:border-zinc-800 dark:bg-zinc-900/40"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-lg bg-blue-600 text-xs font-bold text-white">
                    {index + 1}
                  </span>
                  <div>
                    <h3 className="font-bold break-words">{step.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-400 break-words">
                      {step.description}
                    </p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <article
            data-testid="landing-review-modes"
            className="min-w-0 rounded-2xl border border-zinc-200 bg-zinc-50 p-[20px] dark:border-zinc-800 dark:bg-zinc-900/30"
          >
            <h3 className="flex items-center gap-2 text-sm font-bold">
              <MessagesSquare className="h-4 w-4 text-blue-600 dark:text-blue-400" aria-hidden="true" />
              {copy.reviewModesLabel}
            </h3>
            <ul className="mt-3 space-y-2">
              {copy.reviewModes.map((mode) => (
                <li key={mode} className="flex gap-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300 break-words">
                  <span
                    aria-hidden="true"
                    className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500"
                  />
                  {mode}
                </li>
              ))}
            </ul>
          </article>

          <article
            data-testid="landing-dual-reviewer"
            className="min-w-0 rounded-2xl border border-zinc-200 bg-zinc-50 p-[20px] dark:border-zinc-800 dark:bg-zinc-900/30"
          >
            <h3 className="flex items-center gap-2 text-sm font-bold">
              <Users className="h-4 w-4 text-blue-600 dark:text-blue-400" aria-hidden="true" />
              {copy.dualReviewerLabel}
            </h3>
            <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-300 break-words">
              {copy.dualReviewer}
            </p>
            <p
              data-testid="landing-review-terminology"
              className="mt-4 text-xs leading-5 text-zinc-500 dark:text-zinc-400"
            >
              {copy.terminologyNote}
            </p>
          </article>
        </div>

        <div className="mt-16 max-w-3xl">
          <h2 className="break-words text-3xl font-black sm:text-4xl">{copy.casesTitle}</h2>
          <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">
            {copy.casesDescription}
          </p>
        </div>
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {copy.cases.map((item, index) => {
            const Icon = caseIcons[index];
            return (
              <article
                key={item.title}
                className="min-w-0 flex flex-col rounded-2xl border border-zinc-200 bg-zinc-50 p-[20px] dark:border-zinc-800 dark:bg-zinc-900/30"
              >
                <Icon className="h-6 w-6 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                <h3 className="mt-4 text-lg font-black break-words">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400 break-words">
                  {item.description}
                </p>
                <p className="mt-4 flex gap-2 break-words text-sm font-bold leading-6">
                  <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-status-success-500" aria-hidden="true" />
                  {item.result}
                </p>
                <Link
                  href={localizedPath(lang, casePaths[index])}
                  className="mt-5 inline-flex items-center gap-2 text-sm font-bold text-blue-600 hover:text-blue-500 dark:text-blue-400"
                >
                  {item.link}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </article>
            );
          })}
        </div>

        <div
          data-testid="landing-review-boundary"
          className="mt-6 flex gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-[16px] text-xs leading-5 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100"
        >
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{copy.reviewBoundary}</p>
        </div>
      </div>
    </section>
  );
}

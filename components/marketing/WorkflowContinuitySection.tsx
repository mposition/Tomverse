"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { getLandingCopy } from "./landingContent";
import { ConditionLine, SectionHeading } from "./landingPrimitives";

/**
 * What happens after the comparison: files, targeted follow-up, projects,
 * and sharing.
 *
 * V1 listed six items of equal weight here, and the two at the bottom --
 * Model Finder and importing guest conversations -- are helpers rather than
 * reasons to start. Six equal rows made them read as peers of "keep your
 * files" and stretched the section past the point where a visitor was still
 * reading. They are still on the page, below the four, at the weight they
 * actually carry, with their conditions intact.
 *
 * The four hang off a rule as a numbered run rather than sitting in boxes.
 * They are one continuous story about the same conversation, and four tiles
 * would present them as four unrelated features. The index is monospace
 * because it is a position in a sequence, which is the one thing here that is
 * genuinely a measurement. The icons went with the tiles: a paperclip beside
 * the word "files" was repeating the heading in a picture.
 */

export function WorkflowContinuitySection() {
  const { lang } = useLanguage();
  const copy = getLandingCopy(lang).support;

  return (
    <section
      id="after-comparison"
      aria-labelledby="landing-support-heading"
      data-testid="landing-support-section"
      className="border-b border-zinc-200 py-12 dark:border-zinc-800 sm:py-24"
    >
      <div className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8">
        <SectionHeading
          title={copy.title}
          description={copy.description}
          lang={lang}
          headingId="landing-support-heading"
        />

        <ol className="mt-10 grid border-t-2 border-zinc-950 dark:border-zinc-100 md:grid-cols-2">
          {copy.items.map((item, index) => (
            <li
              key={item.title}
              className={`landing-reveal grid min-w-0 grid-cols-[38px_1fr] gap-x-3 border-b border-zinc-300 py-[26px] dark:border-zinc-700 md:gap-x-5 ${
                index % 2 === 0 ? "md:border-r md:pr-[40px]" : "md:pl-[40px]"
              }`}
            >
              <span className="font-mono text-xs font-semibold tabular-nums text-blue-600 dark:text-blue-400">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <h3 className="break-words text-xl font-black leading-tight tracking-[-0.01em] sm:text-2xl">
                  {item.title}
                </h3>
                <p className="mt-3 break-words text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                  {item.description}
                </p>
                {item.condition && <ConditionLine>{item.condition}</ConditionLine>}
              </div>
            </li>
          ))}
        </ol>

        <ul
          data-testid="landing-support-secondary"
          className="landing-reveal grid gap-3 pt-6 sm:grid-cols-2 sm:gap-8"
        >
          {copy.secondary.map((item) => (
            <li key={item.title} className="min-w-0">
              <p className="break-words text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                <span className="font-bold text-zinc-900 dark:text-zinc-100">
                  {item.title}.
                </span>{" "}
                {item.description}
                {item.condition ? ` ${item.condition}` : ""}
              </p>
            </li>
          ))}
        </ul>

        <div className="landing-reveal mt-10 flex flex-col items-start justify-between gap-5 border-t-2 border-zinc-950 pt-8 dark:border-zinc-100 lg:flex-row lg:items-center">
          <p className="max-w-2xl break-words text-lg font-black leading-7 tracking-[-0.01em] sm:text-xl">
            {copy.accountNote}
          </p>
          <Link
            href="/auth/signin?callbackUrl=%2Fchat"
            data-testid="landing-signup-cta"
            className="inline-flex min-h-12 max-w-full shrink-0 items-center gap-2 rounded-lg bg-zinc-950 px-5 text-center text-sm font-bold text-white transition hover:bg-zinc-800 active:translate-y-px dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            {copy.cta}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}

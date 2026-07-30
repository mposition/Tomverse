"use client";

import Link from "next/link";
import {
  ArrowRight,
  Compass,
  FolderTree,
  Import,
  Paperclip,
  Share2,
  Target,
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { getLandingCopy } from "./landingContent";
import { ConditionLine, SectionHeading } from "./landingPrimitives";

/**
 * What happens after the comparison: files, targeted follow-up, projects,
 * sharing, Model Finder, and carrying guest conversations into an account.
 *
 * Every string here was already translated into all seven locales and had
 * never rendered -- see the `supportItems` row of the audit's dead-copy
 * finding. The section restores them and adds the condition each item
 * actually carries in the shipped product.
 */

const ITEM_ICONS = [Paperclip, Target, FolderTree, Share2, Compass, Import] as const;

export function WorkflowContinuitySection() {
  const { lang } = useLanguage();
  const copy = getLandingCopy(lang).support;

  return (
    <section
      id="after-comparison"
      aria-labelledby="landing-support-heading"
      data-testid="landing-support-section"
      className="border-b border-zinc-200 bg-zinc-50 py-16 dark:border-zinc-800 dark:bg-zinc-900/30 sm:py-20"
    >
      <div className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8">
        <SectionHeading
          title={copy.title}
          description={copy.description}
          lang={lang}
          headingId="landing-support-heading"
        />

        <div className="mt-9 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {copy.items.map((item, index) => {
            const Icon = ITEM_ICONS[index] ?? Paperclip;
            return (
              <article
                key={item.title}
                className="min-w-0 flex flex-col rounded-2xl border border-zinc-200 bg-white p-[20px] dark:border-zinc-800 dark:bg-zinc-950/40"
              >
                <span className="flex h-[40px] w-[40px] items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-base font-bold break-words">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-300 break-words">
                  {item.description}
                </p>
                {item.condition && <ConditionLine>{item.condition}</ConditionLine>}
              </article>
            );
          })}
        </div>

        <div className="mt-7 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-300 break-words">
            {copy.accountNote}
          </p>
          <Link
            href="/auth/signin?callbackUrl=%2Fchat"
            data-testid="landing-signup-cta"
            className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-zinc-950 px-5 text-sm font-bold text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            {copy.cta}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}

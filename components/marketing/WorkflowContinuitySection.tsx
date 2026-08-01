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

        <ol className="mt-10 border-t border-zinc-300 dark:border-zinc-700">
          {copy.items.map((item, index) => {
            const Icon = ITEM_ICONS[index] ?? Paperclip;
            return (
              <li
                key={item.title}
                className="grid min-w-0 gap-5 border-b border-zinc-300 py-[24px] dark:border-zinc-700 md:grid-cols-[64px_0.8fr_1.2fr] md:items-start md:gap-7 sm:py-[28px]"
              >
                <div className="flex items-center gap-3 md:block">
                  <span className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="text-xs font-semibold text-zinc-400 md:mt-3 md:block dark:text-zinc-600">
                    0{index + 1}
                  </span>
                </div>
                <h3 className="break-words text-lg font-black leading-7">
                  {item.title}
                </h3>
                <div className="min-w-0">
                  <p className="break-words text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                    {item.description}
                  </p>
                  {item.condition && (
                    <ConditionLine>{item.condition}</ConditionLine>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-8 flex flex-col items-start gap-5 rounded-3xl bg-zinc-950 p-[20px] text-white sm:flex-row sm:items-center sm:justify-between sm:p-[28px] dark:border dark:border-zinc-800">
          <p className="max-w-2xl break-words text-sm font-semibold leading-6 text-zinc-300">
            {copy.accountNote}
          </p>
          <Link
            href="/auth/signin?callbackUrl=%2Fchat"
            data-testid="landing-signup-cta"
            className="inline-flex min-h-11 max-w-full shrink-0 items-center gap-2 rounded-xl bg-white px-5 text-center text-sm font-bold text-zinc-950 transition hover:bg-zinc-200"
          >
            {copy.cta}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}

"use client";

import Link from "next/link";
import { ArrowRight, Compass, ExternalLink, LayoutGrid } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { PUBLIC_MODEL_PROVIDERS } from "@/lib/models";
import { formatLocalizedInteger } from "@/lib/pricingFormat";
import { getLandingCopy, interpolate } from "./landingContent";
import { ConditionLine, SectionHeading } from "./landingPrimitives";
import { statusLinkLabel, statusNewTabCopy } from "./statusLinkCopy";

/**
 * The catalogue entry point, plus the two conditions that decide what a given
 * visitor can actually select: their plan, and whether a model is up right now.
 *
 * The provider count is derived from lib/models.ts rather than written into
 * copy. The landing FAQ used to carry a fixed list of ten provider names that
 * had already fallen one behind the catalogue; a derived count cannot.
 */
export function ModelCatalogueSection() {
  const { lang } = useLanguage();
  const copy = getLandingCopy(lang).catalogue;
  const providerCount = PUBLIC_MODEL_PROVIDERS.length;

  return (
    <section
      id="model-catalogue"
      aria-labelledby="landing-catalogue-heading"
      data-testid="landing-catalogue-section"
      className="border-b border-zinc-200 py-16 dark:border-zinc-800 sm:py-20"
    >
      <div className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8">
        <SectionHeading
          title={copy.title}
          description={copy.description}
          lang={lang}
          headingId="landing-catalogue-heading"
        />

        <div className="mt-9 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <article className="min-w-0 rounded-3xl border border-zinc-200 bg-zinc-50 p-[20px] dark:border-zinc-800 dark:bg-zinc-900/40 sm:p-[24px]">
            <span className="flex h-[40px] w-[40px] items-center justify-center rounded-xl bg-accent-model-catalogue-500/10 text-accent-model-catalogue-500">
              <LayoutGrid className="h-5 w-5" aria-hidden="true" />
            </span>
            <p
              data-testid="landing-provider-count"
              className="mt-4 text-lg font-black break-words"
            >
              {interpolate(copy.providerNote, {
                count: formatLocalizedInteger(providerCount, lang),
              })}
            </p>
            <ConditionLine testId="landing-catalogue-plan-note">
              {copy.planNote}
            </ConditionLine>
            <ConditionLine testId="landing-catalogue-status-note">
              {copy.statusNote}
            </ConditionLine>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                href="/models"
                data-testid="landing-models-cta"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-zinc-950 px-5 text-sm font-bold text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
              >
                {copy.cta}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <Link
                href="/status"
                target="_blank"
                rel="noopener noreferrer"
                prefetch={false}
                aria-label={statusLinkLabel(copy.statusCta, lang)}
                title={statusNewTabCopy[lang]}
                data-testid="landing-status-cta"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-300 px-4 text-sm font-bold text-zinc-800 transition hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
              >
                {copy.statusCta}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>
          </article>

          <article className="flex flex-col justify-center rounded-3xl border border-zinc-200 bg-white p-[20px] dark:border-zinc-800 dark:bg-zinc-950/40 sm:p-[24px]">
            <span className="flex h-[40px] w-[40px] items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <Compass className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="mt-4 text-lg font-black break-words">{copy.modelFinderLead}</p>
            <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-300 break-words">
              {copy.modelFinderCta}
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}

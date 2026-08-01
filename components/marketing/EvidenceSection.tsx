"use client";

import Link from "next/link";
import { ArrowRight, Globe2, Quote, SearchCheck, Telescope } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { PUBLIC_MODEL_PROVIDERS } from "@/lib/models";
import { getLandingCopy, type LandingCard } from "./landingContent";
import { ConditionLine, SectionHeading } from "./landingPrimitives";

/**
 * Web search, Deep Research, source grounding and the per-item web check --
 * the four capabilities that make "Insight" mean something more than "several
 * answers at once", and the four the landing page did not mention at all.
 *
 * Every card carries its own condition line. These are the features whose
 * plan and credit requirements a visitor would otherwise discover only after
 * signing up, and the point of the section is lost if it advertises Deep
 * Research without saying it starts at Pro.
 *
 * Colour comes from the role tokens that already own these features in the
 * app (accent-web-search, accent-deep-research, status-success) so the
 * landing page and the composer name the same feature with the same hue.
 */

const CARD_STYLES = [
  {
    icon: Globe2,
    iconClass: "bg-accent-web-search-500/10 text-accent-web-search-500",
    edgeClass: "bg-accent-web-search-500",
    gridClass: "lg:col-span-7",
  },
  {
    icon: Telescope,
    iconClass: "bg-accent-deep-research-500/10 text-accent-deep-research-500",
    edgeClass: "bg-accent-deep-research-500",
    gridClass: "lg:col-span-5",
  },
  {
    icon: Quote,
    iconClass: "bg-status-success-500/10 text-status-success-600",
    edgeClass: "bg-status-success-500",
    gridClass: "lg:col-span-5",
  },
  {
    icon: SearchCheck,
    iconClass: "bg-accent-web-search-500/10 text-accent-web-search-500",
    edgeClass: "bg-accent-web-search-500",
    gridClass: "lg:col-span-7",
  },
] as const;

const TEST_IDS = [
  "landing-web-search-card",
  "landing-deep-research-card",
  "landing-source-grounding-card",
  "landing-item-verification-card",
] as const;

export function EvidenceSection() {
  const { lang } = useLanguage();
  const copy = getLandingCopy(lang).evidence;

  const cards: LandingCard[] = [
    copy.webSearch,
    copy.deepResearch,
    copy.sourceGrounding,
    copy.itemVerification,
  ];

  return (
    <section
      id="evidence"
      aria-labelledby="landing-evidence-heading"
      data-testid="landing-evidence-section"
      data-provider-count={PUBLIC_MODEL_PROVIDERS.length}
      className="border-b border-zinc-200 bg-zinc-50 py-16 dark:border-zinc-800 dark:bg-zinc-900/30 sm:py-20"
    >
      <div className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow={copy.eyebrow}
          title={copy.title}
          description={copy.description}
          lang={lang}
          headingId="landing-evidence-heading"
        />

        <div className="mt-10 grid gap-4 lg:grid-cols-12">
          {cards.map((card, index) => {
            const { icon: Icon, iconClass, edgeClass, gridClass } =
              CARD_STYLES[index];
            return (
              <article
                key={card.title}
                data-testid={TEST_IDS[index]}
                className={`relative min-w-0 overflow-hidden rounded-3xl border border-zinc-200 bg-white p-[20px] dark:border-zinc-800 dark:bg-zinc-950/60 sm:p-[28px] lg:min-h-[270px] ${gridClass}`}
              >
                <span
                  aria-hidden="true"
                  className={`absolute inset-x-0 top-0 h-1 ${edgeClass}`}
                />
                <div className="flex items-start justify-between gap-4">
                  <span
                    className={`flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-2xl ${iconClass}`}
                  >
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="text-xs font-semibold tracking-[0.16em] text-zinc-600 dark:text-zinc-300">
                    0{index + 1}
                  </span>
                </div>
                <div className="mt-8 max-w-2xl">
                  <h3 className="break-words text-xl font-black sm:text-2xl">
                    {card.title}
                  </h3>
                  <p className="mt-3 break-words text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                    {card.description}
                  </p>
                  {card.condition && (
                    <ConditionLine>{card.condition}</ConditionLine>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        <div className="mt-7 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            {copy.footnote}
          </p>
          <Link
            href="/pricing"
            className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-zinc-300 px-4 text-sm font-bold text-zinc-800 transition hover:bg-white dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
          >
            {copy.cta}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}

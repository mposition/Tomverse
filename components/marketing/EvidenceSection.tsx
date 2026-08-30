"use client";

import Link from "next/link";
import { ArrowRight, Globe2, Quote, SearchCheck, Telescope } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { PUBLIC_MODEL_PROVIDERS } from "@/lib/models";
import { getLandingCopy } from "./landingContent";
import { ConditionLine, SectionHeading } from "./landingPrimitives";

/**
 * Where a claim came from, and whether it still holds.
 *
 * V1 laid these four capabilities out as four rounded cards of roughly equal
 * weight, which read as a feature list and hid the relationship between them:
 * source grounding and the per-item web check are not siblings of web search
 * and Deep Research, they are things that happen *inside a review result*. So
 * the two review-side capabilities are the wide ruled pair at the top, and the
 * two ways of reaching the live web sit under them at lighter weight, each
 * marked by the role colour that owns it in the app.
 *
 * Nothing here is a card. Per the system in `landingPrimitives`, page
 * structure is ruled: a top rule, a vertical divider between the pair, and a
 * bottom rule. The only rounded surfaces on this page are the hero
 * demonstration and the AI Review output panel.
 *
 * Every capability keeps its own condition line beside its own claim. These
 * are the features whose plan and credit requirements a visitor would
 * otherwise meet only after signing up, and the section is worthless if it
 * advertises Deep Research without saying it starts at Pro.
 *
 * Colour comes from the role tokens that already own these features in the
 * app (accent-web-search, accent-deep-research, status-success) so the
 * landing page and the composer name the same feature with the same hue.
 */

const REVIEW_SIDE = [
  {
    key: "sourceGrounding",
    icon: Quote,
    testId: "landing-source-grounding-card",
    conditionTestId: "landing-source-grounding-condition",
    iconClass: "text-status-success-600",
  },
  {
    key: "itemVerification",
    icon: SearchCheck,
    testId: "landing-item-verification-card",
    conditionTestId: "landing-item-verification-condition",
    iconClass: "text-accent-web-search-500",
  },
] as const;

const LIVE_WEB = [
  {
    key: "webSearch",
    icon: Globe2,
    testId: "landing-web-search-card",
    iconClass: "text-accent-web-search-500",
    ruleClass: "bg-accent-web-search-500",
  },
  {
    key: "deepResearch",
    icon: Telescope,
    testId: "landing-deep-research-card",
    iconClass: "text-accent-deep-research-500",
    ruleClass: "bg-accent-deep-research-500",
  },
] as const;

export function EvidenceSection() {
  const { lang } = useLanguage();
  const copy = getLandingCopy(lang).evidence;

  return (
    <section
      id="evidence"
      aria-labelledby="landing-evidence-heading"
      data-testid="landing-evidence-section"
      data-provider-count={PUBLIC_MODEL_PROVIDERS.length}
      className="border-b border-zinc-200 py-12 dark:border-zinc-800 sm:py-24"
    >
      <div className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow={copy.eyebrow}
          title={copy.title}
          description={copy.description}
          lang={lang}
          headingId="landing-evidence-heading"
        />

        {/*
          What a finished review already tells you about its own evidence.
          Wide, ruled, and set at display weight, so it reads before the two
          smaller entries below it.
        */}
        <div className="landing-reveal mt-10 grid border-t-2 border-zinc-950 dark:border-zinc-100 lg:grid-cols-2">
          {REVIEW_SIDE.map(({ key, icon: Icon, testId, conditionTestId, iconClass }, index) => {
            const card = copy[key];
            return (
              <div
                key={card.title}
                data-testid={testId}
                className={`min-w-0 py-[28px] lg:py-[36px] ${
                  index === 0
                    ? "border-b border-zinc-300 dark:border-zinc-700 lg:border-b-0 lg:border-r lg:pr-[40px]"
                    : "lg:pl-[40px]"
                }`}
              >
                <h3 className="flex min-w-0 items-baseline gap-2.5 break-words text-2xl font-black leading-tight tracking-[-0.02em] sm:text-3xl">
                  <Icon
                    className={`h-5 w-5 shrink-0 translate-y-0.5 ${iconClass}`}
                    aria-hidden="true"
                  />
                  {card.title}
                </h3>
                <p className="mt-4 max-w-xl break-words text-base leading-7 text-zinc-600 dark:text-zinc-300">
                  {card.description}
                </p>
                {card.condition && (
                  <ConditionLine testId={conditionTestId}>
                    {card.condition}
                  </ConditionLine>
                )}
              </div>
            );
          })}
        </div>

        {/*
          The two ways of reaching the live web. Lighter than the pair above:
          smaller heading, no display weight, and a role-coloured rule instead
          of a bordered box.
        */}
        <div className="landing-reveal grid border-t border-zinc-300 dark:border-zinc-700 sm:grid-cols-2">
          {LIVE_WEB.map(({ key, icon: Icon, testId, iconClass, ruleClass }, index) => {
            const card = copy[key];
            return (
              <div
                key={card.title}
                data-testid={testId}
                className={`relative min-w-0 py-[24px] pl-[16px] ${
                  index === 0
                    ? "border-b border-zinc-300 dark:border-zinc-700 sm:border-b-0 sm:border-r sm:pr-[32px]"
                    : "sm:pl-[32px]"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`absolute bottom-[24px] left-0 top-[24px] w-[3px] ${ruleClass} ${
                    index === 0 ? "" : "sm:left-[16px]"
                  }`}
                />
                <h3 className="flex min-w-0 items-center gap-2 break-words text-lg font-black">
                  <Icon className={`h-4 w-4 shrink-0 ${iconClass}`} aria-hidden="true" />
                  {card.title}
                </h3>
                <p className="mt-2.5 max-w-xl break-words text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                  {card.description}
                </p>
                {card.condition && <ConditionLine>{card.condition}</ConditionLine>}
              </div>
            );
          })}
        </div>

        <div className="flex flex-col items-start gap-4 border-t border-zinc-300 pt-6 dark:border-zinc-700 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl break-words text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            {copy.footnote}
          </p>
          <Link
            href="/pricing"
            className="group inline-flex min-h-11 shrink-0 items-center gap-2 text-sm font-bold text-zinc-950 underline underline-offset-4 transition hover:text-blue-600 dark:text-zinc-100 dark:hover:text-blue-400"
          >
            {copy.cta}
            <ArrowRight
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        </div>
      </div>
    </section>
  );
}

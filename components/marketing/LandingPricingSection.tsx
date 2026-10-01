"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { displayHeadingClass } from "@/lib/displayHeading";
import { formatLocalizedInteger } from "@/lib/pricingFormat";
import { getLandingCopy, interpolate } from "./landingContent";
import { usePublicBilling } from "./usePublicBilling";

/**
 * The plans, three short answers, and the closing call to action.
 *
 * This is the only part of the landing page that needs the billing hook, so
 * it is the only part that carries it. Both halves of a plan column -- the
 * price and the monthly credit allowance -- come from that one hook, so a
 * plan changed in the admin console cannot leave the page quoting a live
 * price beside a stale allowance the way the hard-coded sentence did.
 *
 * The columns are a comparison, not three cards. `grid-rows-subgrid` puts
 * name, price, allowance and notes on the same four baselines across all
 * three, which is what makes the differences readable at a glance; V1's
 * bordered boxes let each column set its own rhythm, so comparing Pro to Max
 * meant reading both columns top to bottom. Pro is marked by a rule and by
 * weight rather than by a coloured box, because the recommendation is a
 * detail of the comparison and not a fourth thing on the page.
 *
 * Prices and allowances are set in monospace with tabular figures, so the
 * three columns align digit for digit rather than only left edge to left edge.
 */
export function LandingPricingSection({
  primaryChatHref,
  primaryCtaLabel,
  onPrimaryCtaClick,
}: {
  primaryChatHref: string;
  primaryCtaLabel: string;
  onPrimaryCtaClick: () => void;
}) {
  const { lang } = useLanguage();
  const content = getLandingCopy(lang);
  const copy = content.pricing;
  const billing = usePublicBilling();

  return (
    <section
      id="pricing"
      aria-labelledby="landing-pricing-heading"
      data-testid="landing-pricing-section"
      className="py-14 sm:py-24"
    >
      <div className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8">
        <div className="landing-reveal max-w-4xl">
          <h2
            id="landing-pricing-heading"
            className={`break-words text-3xl font-black leading-[1.02] tracking-[-0.02em] sm:text-5xl lg:text-[3.25rem] ${displayHeadingClass(lang)}`}
          >
            {copy.title}
          </h2>
          <p className="mt-5 max-w-2xl break-words text-base leading-7 text-zinc-600 dark:text-zinc-300">
            {copy.description}
          </p>
        </div>

        <div className="landing-reveal mt-10 grid border-t-2 border-zinc-950 dark:border-zinc-100 sm:grid-cols-3 sm:grid-rows-[auto_auto_auto_auto]">
          {copy.plans.map((plan, index) => {
            const limits = billing.planLimits(plan.id);
            const price = billing.formatPlanPriceOrDefault(plan.id);
            const credits = interpolate(copy.creditsLine, {
              credits: formatLocalizedInteger(limits.monthlyCredits, lang),
            });
            const recommended = plan.id === "pro";
            return (
              <article
                key={plan.id}
                data-testid={`landing-plan-${plan.id}`}
                className={`min-w-0 border-b border-zinc-300 py-[26px] dark:border-zinc-700 sm:row-span-4 sm:grid sm:grid-rows-subgrid sm:gap-0 ${
                  index < 2 ? "sm:border-r sm:pr-[28px]" : ""
                } ${index > 0 ? "sm:pl-[28px]" : ""} ${
                  recommended
                    ? "border-l-2 border-l-blue-600 pl-[16px] sm:border-l-0 sm:border-t-2 sm:border-t-blue-600 sm:-mt-[2px]"
                    : ""
                }`}
              >
                <h3 className="break-words font-mono text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500 dark:text-zinc-400">
                  {plan.title}
                </h3>
                <p className="mt-4 break-words font-mono text-4xl font-black tabular-nums tracking-[-0.03em] sm:text-5xl">
                  {price}
                  <span className="ml-1.5 font-sans text-sm font-semibold tracking-normal text-zinc-600 dark:text-zinc-400">
                    {plan.id === "free" ? "" : copy.monthly}
                  </span>
                </p>
                <p
                  data-testid={`landing-plan-${plan.id}-credits`}
                  className="mt-4 break-words text-sm font-bold leading-6 tabular-nums"
                >
                  {limits.monthlyCredits > 0 ? credits : copy.creditsUnknown}
                </p>
                <div className="mt-4">
                  <p className="break-words text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                    {plan.blurb}
                  </p>
                  {limits.dailyCredits === 0 && (
                    <p className="mt-2 break-words text-xs font-semibold leading-5 text-zinc-600 dark:text-zinc-400">
                      {copy.noDailyLimitNote}
                    </p>
                  )}
                  {recommended && (
                    <p
                      data-testid="landing-plan-pro-deep-research"
                      className="mt-2 break-words text-xs font-semibold leading-5 text-zinc-600 dark:text-zinc-400"
                    >
                      {copy.deepResearchNote}
                    </p>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        <div className="landing-reveal mt-6 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p
            data-testid="landing-daily-limit-note"
            className="max-w-2xl break-words text-xs leading-5 text-zinc-500 dark:text-zinc-400"
          >
            {copy.dailyLimitNote}
          </p>
          <Link
            href="/pricing"
            className="group inline-flex min-h-11 shrink-0 items-center gap-2 text-sm font-bold text-zinc-950 underline underline-offset-4 transition hover:text-blue-600 dark:text-zinc-100 dark:hover:text-blue-400"
          >
            {copy.detailsCta}
            <ArrowRight
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        </div>

        {/*
          Three answers, open. V1 collapsed them behind `<details>`, which
          hides the guest allowance -- the one condition a visitor most needs
          before starting -- behind a click nobody makes on a marketing page.
        */}
        <div className="landing-reveal mt-14 grid gap-6 lg:grid-cols-12 lg:items-start lg:gap-10">
          <h2
            className={`min-w-0 break-words text-2xl font-black leading-tight tracking-[-0.02em] sm:text-3xl lg:col-span-4 ${displayHeadingClass(lang)}`}
          >
            {content.faqTitle}
          </h2>
          <dl className="min-w-0 border-t-2 border-zinc-950 dark:border-zinc-100 lg:col-span-8">
            {content.faqs.map((item) => (
              <div
                key={item.question}
                className="min-w-0 border-b border-zinc-300 py-[20px] dark:border-zinc-700"
              >
                <dt className="break-words text-lg font-black leading-tight tracking-[-0.01em]">
                  {item.question}
                </dt>
                <dd className="mt-2.5 max-w-3xl break-words text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                  {item.answer}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {/*
        The close is a full-bleed band rather than a rounded box on a light
        page. Per the system in `landingPrimitives` the page's structure is
        ruled and banded, and a floating dark rectangle at the end was the last
        piece of the card language left standing.

        FINAL-F001 precedent: the padding is decoration, not customer text, so
        it is frozen in px. As `p-7 sm:p-9` it doubled at a 200% root font size
        and left roughly 144px of content width at 320px, which pushed the
        heading past the viewport. The label inside still scales.
      */}
      <div className="mt-14 bg-blue-600 py-[36px] text-white sm:py-[56px]">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-7 px-[16px] sm:px-6 lg:flex-row lg:items-center lg:px-8">
          <div className="min-w-0 max-w-3xl">
            <h2
              className={`break-words text-2xl font-black leading-[1.05] tracking-[-0.02em] sm:text-4xl lg:text-5xl ${displayHeadingClass(lang)}`}
            >
              {content.ctaTitle}
            </h2>
            <p className="mt-4 break-words text-base leading-7 text-blue-50">
              {content.ctaDescription}
            </p>
          </div>
          <Link
            href={primaryChatHref}
            onClick={onPrimaryCtaClick}
            data-testid="landing-final-cta"
            // `shrink-0` plus a rem gutter made the longest locale label
            // 323px wide at a 200% root font size on a 320px viewport. It
            // keeps its fixed width on the desktop row and is allowed to fill
            // and wrap below `lg`.
            className="inline-flex min-h-12 w-full min-w-0 items-center justify-center gap-2 rounded-lg bg-white px-[24px] text-center text-sm font-bold text-blue-700 transition hover:bg-blue-50 active:translate-y-px lg:w-auto lg:shrink-0"
          >
            {primaryCtaLabel}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}

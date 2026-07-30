"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { displayHeadingClass } from "@/lib/displayHeading";
import { formatLocalizedInteger } from "@/lib/pricingFormat";
import { getLandingCopy, interpolate } from "./landingContent";
import { usePublicBilling } from "./usePublicBilling";

/**
 * The plan cards, the FAQ and the closing call to action.
 *
 * This is the only part of the landing page that needs the billing hook, so
 * it is the only part that carries it. Both halves of a plan card -- the
 * price and the monthly credit allowance -- now come from that one hook, so a
 * plan changed in the admin console cannot leave the page quoting a live
 * price beside a stale allowance the way the hard-coded sentence did.
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
      className="border-y border-zinc-200 bg-zinc-50 py-16 dark:border-zinc-800 dark:bg-zinc-900/30 sm:py-20"
    >
      <div className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <h2
            id="landing-pricing-heading"
            className={`break-words text-3xl font-black sm:text-4xl ${displayHeadingClass(lang)}`}
          >
            {copy.title}
          </h2>
          <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">
            {copy.description}
          </p>
        </div>

        <div className="mt-9 grid gap-4 md:grid-cols-3">
          {copy.plans.map((plan) => {
            const limits = billing.planLimits(plan.id);
            const price = billing.formatPlanPriceOrDefault(plan.id);
            const credits = interpolate(copy.creditsLine, {
              credits: formatLocalizedInteger(limits.monthlyCredits, lang),
            });
            return (
              <article
                key={plan.id}
                data-testid={`landing-plan-${plan.id}`}
                className={`rounded-2xl border p-[20px] ${
                  plan.id === "pro"
                    ? "border-blue-500 bg-blue-50/70 dark:bg-blue-950/20"
                    : "border-zinc-200 dark:border-zinc-800"
                }`}
              >
                <h3 className="text-lg font-black break-words">{plan.title}</h3>
                <p className="mt-4 break-words text-3xl font-black">
                  {price}
                  <span className="ml-1 text-sm font-semibold text-zinc-600 dark:text-zinc-400">
                    {plan.id === "free" ? "" : copy.monthly}
                  </span>
                </p>
                <p
                  data-testid={`landing-plan-${plan.id}-credits`}
                  className="mt-4 text-sm font-bold leading-6"
                >
                  {limits.monthlyCredits > 0 ? credits : copy.creditsUnknown}
                </p>
                <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400 break-words">
                  {plan.blurb}
                </p>
                {limits.dailyCredits === 0 && (
                  <p className="mt-3 text-xs font-semibold leading-5 text-zinc-600 dark:text-zinc-400">
                    {copy.noDailyLimitNote}
                  </p>
                )}
                {plan.id === "pro" && (
                  <p
                    data-testid="landing-plan-pro-deep-research"
                    className="mt-3 text-xs font-semibold leading-5 text-zinc-600 dark:text-zinc-400"
                  >
                    {copy.deepResearchNote}
                  </p>
                )}
              </article>
            );
          })}
        </div>

        <p
          data-testid="landing-daily-limit-note"
          className="mt-5 text-xs leading-5 text-zinc-500 dark:text-zinc-400"
        >
          {copy.dailyLimitNote}
        </p>

        <Link
          href="/pricing"
          className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-xl bg-zinc-950 px-5 text-sm font-bold text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          {copy.detailsCta}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>

        <h2
          className={`mt-16 break-words text-3xl font-bold sm:text-4xl ${displayHeadingClass(lang)}`}
        >
          {content.faqTitle}
        </h2>
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {content.faqs.map((item) => (
            <details
              key={item.question}
              className="group rounded-2xl border border-zinc-200 p-[20px] dark:border-zinc-800"
            >
              <summary className="cursor-pointer list-none break-words font-bold">
                {item.question}
              </summary>
              <p className="mt-4 text-sm leading-6 text-zinc-600 dark:text-zinc-400 break-words">
                {item.answer}
              </p>
            </details>
          ))}
        </div>

        {/*
          FINAL-F001 precedent: the box's padding is decoration, not customer
          text, so it is frozen in px. As `p-7 sm:p-9` it doubled at a 200%
          root font size and left roughly 144px of content width at 320px,
          which pushed this heading past the viewport (clipped rather than
          scrolled, because `main` is `overflow-x-hidden`). The label inside
          still scales.
        */}
        <div className="mt-12 flex flex-col items-start justify-between gap-6 rounded-3xl bg-zinc-950 p-[20px] text-white sm:p-[36px] lg:flex-row lg:items-center dark:border dark:border-zinc-800">
          <div className="max-w-2xl">
            <h2 className={`break-words text-2xl font-bold sm:text-3xl ${displayHeadingClass(lang)}`}>
              {content.ctaTitle}
            </h2>
            <p className="mt-3 break-words leading-7 text-zinc-300">{content.ctaDescription}</p>
          </div>
          <Link
            href={primaryChatHref}
            onClick={onPrimaryCtaClick}
            // `shrink-0` plus a rem gutter made the longest locale label
            // ("Commencer à discuter gratuitement") 323px wide at a 200% root
            // font size on a 320px viewport. It keeps its fixed width on the
            // desktop row and is allowed to fill and wrap below `lg`.
            className="inline-flex min-h-12 w-full min-w-0 items-center justify-center gap-2 rounded-xl bg-white px-[24px] text-center text-sm font-bold text-zinc-950 hover:bg-zinc-200 lg:w-auto lg:shrink-0"
          >
            {primaryCtaLabel}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}

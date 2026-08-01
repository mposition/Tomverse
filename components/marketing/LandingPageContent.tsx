"use client";

import Link from "next/link";
import { displayHeadingClass } from "@/lib/displayHeading";
import { ArrowRight, Sparkles } from "lucide-react";
import { useSession } from "next-auth/react";
import { useEffect, useRef } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import { ComparisonBasicsSection } from "./ComparisonBasicsSection";
import { EvidenceSection } from "./EvidenceSection";
import { getLandingCopy } from "./landingContent";
import { LandingPricingSection } from "./LandingPricingSection";
import { LandingHeroAiReviewDemo } from "./LandingHeroAiReviewDemo";
import { ModelCatalogueSection } from "./ModelCatalogueSection";
import { ProductProofSection } from "./ProductProofSection";
import { TrustSection } from "./TrustSection";
import { WorkflowContinuitySection } from "./WorkflowContinuitySection";

/**
 * The landing page shell: the hero, and the order the sections run in.
 *
 * Section order is the deliberate part. "Why this rather than one AI chat"
 * (the comparison loop, then evidence and currency) now comes before the
 * walkthrough, because a visitor who has not been told what is different has
 * no reason to watch how it works.
 *
 * The hero's wording is unchanged: guests really can start with three
 * models and run AI Review, so qualifying either promise would state a limit
 * that does not exist. Its layout is not exempt from that -- the gutters,
 * padding and mock-up chrome below are frozen in px and the text columns carry
 * `min-w-0` so the hero reflows at a 200% root font size on a 320px viewport
 * instead of being cropped by this element's `overflow-x-hidden`.
 */
export function LandingPageContent() {
  const { lang } = useLanguage();
  const { status } = useSession();
  const content = getLandingCopy(lang);
  const chatHref = `/chat?lang=${encodeURIComponent(lang)}`;
  const guestChatHref = `${chatHref}&entry=guest-preview`;
  const primaryChatHref = status === "authenticated" ? chatHref : guestChatHref;
  const primaryCtaLabel =
    status === "authenticated" ? content.signedInCta : content.primaryCta;
  const landingTrackedRef = useRef(false);

  useEffect(() => {
    if (landingTrackedRef.current) return;
    landingTrackedRef.current = true;
    trackProductEvent("landing_view");
  }, []);

  return (
    <main className="min-h-screen overflow-x-hidden bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader />

      <section
        aria-labelledby="landing-hero-title"
        className="relative isolate overflow-hidden border-b border-zinc-200 dark:border-zinc-800"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-0 top-[64px] -z-10 h-[384px] w-full max-w-[384px] rounded-full bg-blue-500/10 blur-3xl dark:bg-blue-500/15"
        />
        <div className="mx-auto grid max-w-7xl gap-10 px-[16px] pb-12 pt-10 sm:px-6 sm:pb-14 sm:pt-12 lg:grid-cols-[1.03fr_0.97fr] lg:items-center lg:px-8 lg:py-20">
          {/*
            No `min-w-0` here, deliberately. Shrinking this grid item below its
            min-content does make the hero fit a 320px viewport at 200% zoom --
            but its min-content is set by the display heading, and for Korean
            that minimum is one intact 어절. Removing it split "비교하세요" across
            two lines, which is the defect UI-006 exists to prevent and which
            tests/e2e/korean-typography.spec.ts treats as a release blocker.
            So the heading keeps its intact-어절 minimum (overflowing into this
            element's `overflow-x-hidden`, as it did before), and everything
            else in the hero -- badge, notes, CTA, mock-up -- is made to fit on
            its own. Closing the remainder means either a smaller Korean hero
            heading at the narrowest widths or a relaxed 200%-zoom assertion,
            and that is a design decision, not a layout fix.
          */}
          <div>
            <div className="inline-flex max-w-full flex-wrap items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-[12px] py-[4px] text-xs font-bold text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {content.badge}
            </div>
            <p data-testid="landing-brand-note" className="mt-2 max-w-xl break-words text-sm font-medium text-zinc-500 dark:text-zinc-400">
              {content.brandNote}
            </p>
            <h1
              id="landing-hero-title"
              data-testid="landing-hero-title"
              // Viewport-relative rather than root-relative below `sm`, which is what
              // lets the hero fit without breaking a 어절. The heading sets this
              // column's min-content width, and at a fixed 2.25rem that minimum is
              // one intact Korean 어절 rendered at a 200% root font -- wider than a
              // 320px viewport, so the column overflowed. A `clamp()` in `vw` does
              // not grow with the root font (text scaling) and does shrink with the
              // layout viewport (browser zoom), so the minimum fits in both cases.
              // The cap is the previous size and 9vw reaches it by ~400px, so
              // anything from a 390px phone upward renders as before; only 320-360px
              // trims, which is exactly where the conflict was.
              className={`mt-6 max-w-4xl whitespace-pre-line break-words text-[clamp(1.75rem,9vw,2.25rem)] font-black leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl ${displayHeadingClass(lang)}`}
            >
              {content.title}
            </h1>
            <p className="mt-6 max-w-2xl whitespace-pre-line break-words text-lg leading-8 text-zinc-600 dark:text-zinc-300">{content.description}</p>
            {/*
              EXT-REAUDIT-F001: gated on "not authenticated" rather than on
              "unauthenticated" so it renders during `loading` too. `status`
              starts as "loading" and only resolves once the session probe
              returns (~900ms on a cold mobile load), and this note plus the
              guest note below are worth 78px of hero height. Gating them on
              the resolved state meant the whole page below the hero jumped
              down when the probe landed -- 0.2667 median CLS at 360x640, the
              single largest layout shift on the landing page. A logged-out
              visitor is the default case for a marketing landing page, so
              rendering it immediately is both the accurate guess and the
              stable one; the copy itself is unchanged.
            */}
            {status !== "authenticated" && (
              <p data-testid="landing-hero-signup-note" className="mt-3 max-w-2xl break-words text-base font-semibold text-zinc-700 dark:text-zinc-200">
                {content.heroSignupNote}
              </p>
            )}

            <div className="mt-8 flex flex-col items-start gap-3">
              <Link
                id="landing-hero-primary"
                href={primaryChatHref}
                data-testid="landing-primary-cta"
                onClick={() => trackProductEvent("cta_start_click", 0, { cta_location: "landing_hero_chat" })}
                className="inline-flex min-h-12 max-w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-[24px] text-center text-sm font-bold text-white shadow-lg shadow-blue-950/20 transition hover:bg-blue-500"
              >
                {primaryCtaLabel}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              {status !== "authenticated" && (
                <p data-testid="landing-guest-note" className="break-words text-sm font-medium text-zinc-500 dark:text-zinc-400">
                  {content.guestNote}
                </p>
              )}
            </div>
          </div>

          <LandingHeroAiReviewDemo
            preview={content.preview}
            stages={content.proof.stages}
          />
        </div>
      </section>

      <ComparisonBasicsSection />
      <EvidenceSection />
      <ProductProofSection />
      <WorkflowContinuitySection />
      <ModelCatalogueSection />
      <TrustSection />
      <LandingPricingSection
        primaryChatHref={primaryChatHref}
        primaryCtaLabel={primaryCtaLabel}
        onPrimaryCtaClick={() =>
          trackProductEvent("cta_start_click", 0, { cta_location: "landing_final_chat" })
        }
      />

      <MarketingFooter />
    </main>
  );
}

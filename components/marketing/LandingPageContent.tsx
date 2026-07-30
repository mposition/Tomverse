"use client";

import Link from "next/link";
import { displayHeadingClass } from "@/lib/displayHeading";
import { ArrowRight, Bot, Sparkles } from "lucide-react";
import { useSession } from "next-auth/react";
import { useEffect, useRef } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import { ComparisonBasicsSection } from "./ComparisonBasicsSection";
import { EvidenceSection } from "./EvidenceSection";
import { getLandingCopy } from "./landingContent";
import { LandingPricingSection } from "./LandingPricingSection";
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
 * The hero itself is unchanged. Its guest-start note and its AI Review
 * promise are owned by a separate platform change that is extending guest
 * access, so this page must not qualify either of them.
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
        className="relative border-b border-zinc-200 dark:border-zinc-800"
      >
        <div className="mx-auto grid max-w-7xl gap-10 px-4 pb-12 pt-10 sm:px-6 sm:pb-14 sm:pt-12 lg:grid-cols-[1.03fr_0.97fr] lg:items-center lg:px-8 lg:py-16">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {content.badge}
            </div>
            <p data-testid="landing-brand-note" className="mt-2 max-w-xl text-sm font-medium text-zinc-500 dark:text-zinc-400">
              {content.brandNote}
            </p>
            <h1
              id="landing-hero-title"
              data-testid="landing-hero-title"
              className={`mt-6 max-w-4xl whitespace-pre-line text-4xl font-black leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl ${displayHeadingClass(lang)}`}
            >
              {content.title}
            </h1>
            <p className="mt-6 max-w-2xl whitespace-pre-line text-lg leading-8 text-zinc-600 dark:text-zinc-300">{content.description}</p>
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
              <p data-testid="landing-hero-signup-note" className="mt-3 max-w-2xl text-base font-semibold text-zinc-700 dark:text-zinc-200">
                {content.heroSignupNote}
              </p>
            )}

            <div className="mt-8 flex flex-col items-start gap-3">
              <Link
                id="landing-hero-primary"
                href={primaryChatHref}
                data-testid="landing-primary-cta"
                onClick={() => trackProductEvent("cta_start_click", 0, { cta_location: "landing_hero_chat" })}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 text-sm font-bold text-white shadow-lg shadow-blue-950/20 transition hover:bg-blue-500"
              >
                {primaryCtaLabel}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              {status !== "authenticated" && (
                <p data-testid="landing-guest-note" className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                  {content.guestNote}
                </p>
              )}
            </div>
          </div>

          {/*
            The mock-up is decorative -- its bars and chips carry no text a
            screen reader can make sense of -- so the group is labelled once
            with a sentence describing what it depicts, and the shapes inside
            stay hidden rather than being read out as stray fragments.
          */}
          <div
            role="img"
            aria-label={content.preview.srDescription}
            className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 p-2 shadow-2xl shadow-zinc-300/60 dark:shadow-black/50 md:p-3"
          >
            <div className="rounded-[1.25rem] border border-zinc-800 bg-zinc-950 text-white">
              <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                <span className="flex items-center gap-2 text-xs font-bold text-zinc-300"><Bot className="h-4 w-4 text-blue-400" aria-hidden="true" />{content.preview.title}</span>
                <span className="rounded-full bg-status-success-500/10 px-2 py-1 text-[11px] font-bold text-status-success-300">{content.preview.count}</span>
              </div>
              <div className="grid gap-2 p-3 sm:grid-cols-3">
                {["GPT", "Claude", "Gemini"].map((model, index) => (
                  <article key={model} className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-3">
                    <div className="flex items-center justify-between"><span className="text-sm font-bold">{model}</span><span aria-hidden="true" className="h-2 w-2 rounded-full bg-zinc-500" /></div>
                    <div aria-hidden="true" className="mt-4 space-y-2"><div className="h-2 w-4/5 rounded-full bg-zinc-700" /><div className="h-2 w-full rounded-full bg-zinc-800" /></div>
                    <p className="mt-4 rounded-xl border border-zinc-700 bg-zinc-800 p-2.5 text-xs font-bold leading-5 text-zinc-200">{content.preview.answers[index]}</p>
                  </article>
                ))}
              </div>
              <div className="mx-3 mb-3 rounded-2xl border border-blue-500/30 bg-blue-500/10 p-3">
                <div className="flex items-center gap-2 text-xs font-bold text-blue-200"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{content.preview.reviewTitle}</div>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {content.preview.reviewItems.map((item, index) => (
                    <span key={item} className="flex items-center gap-1.5 rounded-lg bg-black/20 px-2 py-2 text-[11px] font-bold text-zinc-200">
                      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${index === 1 || index === 3 ? "bg-amber-400" : "bg-status-success-300"}`} />{item}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
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

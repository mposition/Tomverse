"use client";

import Link from "next/link";
import { displayHeadingClass } from "@/lib/displayHeading";
import { ArrowRight } from "lucide-react";
import { useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import { AiReviewLoopSection } from "./AiReviewLoopSection";
import { EvidenceSection } from "./EvidenceSection";
import { getLandingCopy } from "./landingContent";
import { LandingPricingSection } from "./LandingPricingSection";
import { AnswerRails } from "./AnswerRails";
import { ProductCapture } from "./ProductCapture";
import { TrustSection } from "./TrustSection";
import { WorkflowContinuitySection } from "./WorkflowContinuitySection";
import {
  chatProductDestination,
  workspaceDestination,
} from "@/lib/productEntryDestination";
import { chatProductUiCopy } from "@/lib/chatProductUiCopy";
import { startLandingChatCapabilityRead } from "@/lib/landingChatCapabilityClient";

/**
 * The landing page shell: the hero, and the order the sections run in.
 *
 * ## What V2 changed, and why
 *
 * This page introduces Tomverse Review. Tomverse is the brand, Tomverse Chat
 * is the conversational product, and AI Review is a comparison feature inside
 * Tomverse Review. Product choices keep their names and entry points distinct.
 *
 * The hero now names both product jobs once. Its primary guest action still
 * starts Review, while Chat has a distinct single-model guest trial entry and
 * server-owned authenticated availability boundary.
 *
 * Eight sections became five. Three of the eight were retellings of the hero
 * demonstration rather than new facts, and two more pairs were answering one
 * question in two scroll stops each. See the section components for the
 * per-section reasoning.
 *
 * The hero's layout constraints are unchanged and deliberate: the gutters,
 * padding and mock-up chrome are frozen in px and the text columns carry
 * `min-w-0`, so the hero reflows at a 200% root font size on a 320px viewport
 * instead of being cropped by this element's `overflow-x-hidden`.
 */
export function LandingPageContent({
  guestTrialAvailable = false,
}: {
  /** Public static trial entry, not an account, Auto or Refiner capability. */
  guestTrialAvailable?: boolean;
} = {}) {
  const { data: session, status } = useSession();
  const isAuthenticated = status === "authenticated";
  const accountUserId = isAuthenticated && typeof session?.user?.id === "string"
    && session.user.id.length > 0 ? session.user.id : null;
  const landingTrackedRef = useRef(false);

  useEffect(() => {
    if (landingTrackedRef.current) return;
    landingTrackedRef.current = true;
    trackProductEvent("landing_view");
  }, []);

  return (
    <LandingPageContentForIdentity
      // A new resolved identity starts unavailable in the same render. A late
      // capability response cannot repaint another account, even A-to-B-to-A.
      key={`${status}:${accountUserId ?? ""}`}
      accountUserId={accountUserId}
      isAuthenticated={isAuthenticated}
      guestTrialAvailable={guestTrialAvailable}
    />
  );
}

function LandingPageContentForIdentity({
  accountUserId,
  isAuthenticated,
  guestTrialAvailable,
}: {
  accountUserId: string | null;
  isAuthenticated: boolean;
  guestTrialAvailable: boolean;
}) {
  const { lang } = useLanguage();
  const [chatSurfaceAvailable, setChatSurfaceAvailable] = useState(false);
  useEffect(() => startLandingChatCapabilityRead({
    accountUserId,
    onResolved: setChatSurfaceAvailable,
  }), [accountUserId]);
  const content = getLandingCopy(lang);
  const productCopy = chatProductUiCopy[lang];
  const reviewHref = workspaceDestination({
    chatSurfaceAvailable: false,
    lang,
    isAuthenticated,
  });
  // This page introduces Review; Chat has its separate capability-gated card.
  const primaryChatHref = reviewHref;
  const primaryCtaLabel = isAuthenticated ? content.signedInCta : content.primaryCta;
  const chatProductHref = chatProductDestination({
    chatSurfaceAvailable,
    guestTrialAvailable,
    lang,
    isAuthenticated,
  });
  const isGuestChatTrial = !isAuthenticated && guestTrialAvailable;

  return (
    <main className="min-h-screen overflow-x-hidden bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader variant="launch" />

      <section
        aria-labelledby="landing-hero-title"
        className="relative isolate"
      >
        {/*
          No ruled background and no gradient blob. Both were decoration
          standing in for structure; the three rails below the comparison are
          the structure, and they are drawn from something the page actually
          claims rather than sprinkled behind the copy.
        */}
        <div className="mx-auto max-w-7xl px-[16px] pb-10 pt-10 sm:px-6 sm:pt-14 lg:px-8 lg:pb-12 lg:pt-20">
          {/*
            No `min-w-0` here, deliberately. Shrinking this grid item below its
            min-content does make the hero fit a 320px viewport at 200% zoom --
            but its min-content is set by the display heading, and for Korean
            that minimum is one intact 어절. Removing it split "비교하세요" across
            two lines, which is the defect UI-006 exists to prevent and which
            tests/e2e/korean-typography.spec.ts treats as a release blocker.
            So the heading keeps its intact-어절 minimum (overflowing into this
            element's `overflow-x-hidden`, as it did before), and everything
            else in the hero -- product label, note, CTA, mock-up -- is made to
            fit on its own.
          */}
          <div>
            {/*
              One product identity statement, not two. The brand is the first
              line, the product it opens onto is the second. V1 spent a pill
              badge and a separate paragraph saying this, and the pill said
              "Tomverse Review · Multi-AI Comparison & Review" -- a label that
              repeated the H1 directly underneath it.
            */}
            <p
              data-testid="landing-brand-note"
              className="max-w-xl break-words border-l-2 border-blue-600 pl-[14px] text-sm leading-6"
            >
              <span className="font-mono text-xs font-semibold uppercase tracking-[0.24em] text-blue-600 dark:text-blue-400">
                {content.badge}
              </span>
              <span className="mt-1.5 block font-medium text-zinc-500 dark:text-zinc-400">
                {content.brandNote}
              </span>
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
              // `lg:text-7xl` is affordable again because the headline spans
              // the container rather than sharing a row with a mock-up. At
              // 60px in the old half-width column the English headline set
              // four lines when its copy asks for two; at 72px across the full
              // width it sets the two the copy wrote. Still inside the Korean
              // desktop assertion in tests/e2e/korean-typography.spec.ts,
              // which requires at least 48px and at most three lines at
              // 1440px.
              className={`mt-6 max-w-5xl whitespace-pre-line break-words text-[clamp(1.75rem,9vw,2.25rem)] font-black leading-[1.02] tracking-[-0.035em] sm:text-6xl lg:text-7xl ${displayHeadingClass(lang)}`}
            >
              {content.title}
            </h1>
            <p className="mt-5 max-w-2xl whitespace-pre-line break-words text-lg leading-8 text-zinc-600 dark:text-zinc-300">
              {content.description}
            </p>
            <p
              data-testid="landing-product-intro"
              className="mt-3 max-w-2xl text-sm leading-6 text-zinc-500 dark:text-zinc-400"
            >
              {productCopy.landingIntro}
            </p>

            <div
              data-testid="landing-product-choices"
              className="mt-7 grid max-w-4xl gap-3 md:grid-cols-2"
            >
              <article className="flex min-w-0 flex-col rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                  {productCopy.chat.feature}
                </p>
                <h2 className="mt-1 text-lg font-black">{productCopy.chat.name}</h2>
                <p
                  data-testid="landing-chat-product-description"
                  className="mt-2 flex-1 text-sm leading-6 text-zinc-600 dark:text-zinc-300"
                >
                  {isGuestChatTrial
                    ? productCopy.guestChatDescription
                    : productCopy.chat.description}
                </p>
                {chatProductHref ? (
                  <Link
                    href={chatProductHref}
                    data-testid="landing-chat-product-cta"
                    className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl border border-blue-600 px-4 text-sm font-bold text-blue-700 transition hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/40"
                  >
                    {isGuestChatTrial
                      ? productCopy.tryGuestChat
                      : isAuthenticated
                        ? productCopy.chat.open
                        : productCopy.signInToOpenChat}
                  </Link>
                ) : (
                  <p
                    data-testid="landing-chat-unavailable"
                    className="mt-4 rounded-xl bg-zinc-100 px-3 py-2 text-sm font-semibold text-zinc-600 dark:bg-zinc-950 dark:text-zinc-300"
                  >
                    {productCopy.unavailable}
                  </p>
                )}
              </article>

              <article className="flex min-w-0 flex-col rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                  {productCopy.review.feature}
                </p>
                <h2 className="mt-1 text-lg font-black">{productCopy.review.name}</h2>
                <p className="mt-2 flex-1 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                  {productCopy.review.description}
                </p>
                <Link
                  href={reviewHref}
                  data-testid="landing-review-product-cta"
                  className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl border border-zinc-300 px-4 text-sm font-bold text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
                >
                  {productCopy.review.open}
                </Link>
              </article>
            </div>

            <div className="mt-7 flex flex-col items-start gap-3">
              <div className="flex w-full min-w-0 flex-wrap items-center gap-x-6 gap-y-3">
                <Link
                  id="landing-hero-primary"
                  href={primaryChatHref}
                  data-testid="landing-primary-cta"
                  onClick={() => trackProductEvent("cta_start_click", 0, { cta_location: "landing_hero_chat" })}
                  className="inline-flex min-h-12 max-w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-[24px] text-center text-sm font-bold text-white shadow-lg shadow-blue-950/20 transition hover:bg-blue-500 active:translate-y-px"
                >
                  {primaryCtaLabel}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
                {/*
                  The one secondary action, as a text link rather than a
                  second button: it goes to the section directly below, so
                  giving it button weight would have set it against the CTA
                  that actually starts the product.
                */}
                <Link
                  href="#how-it-works"
                  data-testid="landing-secondary-cta"
                  className="inline-flex min-h-12 max-w-full items-center gap-1.5 break-words text-sm font-bold text-zinc-700 underline underline-offset-4 transition hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                >
                  {content.secondaryCta}
                </Link>
              </div>
              {/*
                EXT-REAUDIT-F001: gated on "not authenticated" rather than on
                "unauthenticated" so it renders during `loading` too. `status`
                starts as "loading" and only resolves once the session probe
                returns, and gating this note on the resolved state made the
                whole page below the hero jump down when the probe landed. A
                logged-out visitor is the default case for a marketing landing
                page, so rendering it immediately is both the accurate guess
                and the stable one.

                V1 rendered this promise twice, once above the CTA and once
                below it, in near-identical words. One line, one place.
              */}
              {!isAuthenticated && (
                <p
                  data-testid="landing-hero-signup-note"
                  className="max-w-2xl break-words text-sm font-semibold text-zinc-700 dark:text-zinc-200"
                >
                  {content.heroSignupNote}
                </p>
              )}
            </div>
          </div>

        </div>

        {/*
          The evidence, and the only thing in the hero that is not type: the
          real comparison, three answers to one question, captured from the
          current interface.

          It replaces a product mock-up built out of styled divs. That mock-up
          was the page's most recognisable machine-generated tell, and it was
          also the weaker argument: a drawing of the product proves nothing a
          visitor could not have drawn themselves.
        */}
        <div className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8">
          <figure className="m-0">
            <div className="overflow-hidden rounded-2xl border border-zinc-200 shadow-2xl shadow-zinc-300/50 dark:border-zinc-800 dark:shadow-black/60">
              <ProductCapture
                name="comparison"
                priority
                alt={content.preview.srDescription}
              />
            </div>
            <figcaption
              data-testid="landing-workflow-disclosure"
              className="mt-3 break-words text-xs leading-5 text-zinc-500 dark:text-zinc-400"
            >
              {content.preview.disclosure}
            </figcaption>
          </figure>
        </div>

        {/* Three answers leave the comparison and carry down the page. */}
        <AnswerRails variant="descend" />
      </section>

      <AiReviewLoopSection />
      <EvidenceSection />
      <WorkflowContinuitySection />
      <TrustSection />
      <LandingPricingSection
        primaryChatHref={primaryChatHref}
        primaryCtaLabel={primaryCtaLabel}
        onPrimaryCtaClick={() =>
          trackProductEvent("cta_start_click", 0, { cta_location: "landing_final_chat" })
        }
      />

      <MarketingFooter variant="launch" />
    </main>
  );
}

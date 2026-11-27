"use client";

import Link from "next/link";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { CreditPackPurchaseButton } from "@/components/billing/CreditPackPurchaseButton";
import { PlanChangeDialog } from "@/components/billing/PlanChangeDialog";
import { purchaseCtaCopy } from "@/components/billing/purchaseCopy";
import { UpgradeInterestButton } from "@/components/marketing/UpgradeInterestButton";
import { usePricingAccount } from "@/components/marketing/usePricingAccount";
import { usePublicBilling } from "@/components/marketing/usePublicBilling";
import {
  billingCurrencyFractionDigits,
  billingMinorToMajor,
  formatBillingAmount,
  formatBillingMinor,
  type BillingCurrency,
} from "@/lib/billingMarkets";
import type { Language } from "@/lib/language";
import { MODEL_USAGE_CREDIT_WEIGHTS, canUseModelWithPlan, type ModelTier } from "@/lib/models";
import { formatBillingPeriodLabel, formatCountedUnit, formatPriceWithPeriod } from "@/lib/pricingFormat";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { REVIEW_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";
import {
  PRICING_CREDIT_PACKS_ANCHOR,
  PRICING_PLANS_ANCHOR,
  buildPlanChangeSupportHref,
  resolvePlanCtaState,
  shouldHideFreePlanCta,
  type AccountPlanTier,
  type PurchaseCreditPackId,
} from "@/lib/purchaseIntent";
import { localizedPath } from "@/lib/seo";
import { MarketingFooter, MarketingHeader } from "../../MarketingChrome";
import { useMarketingChatEntry } from "../../MarketingChatAvailability";
import { CreditCalculator } from "./CreditCalculator";
import { PlanModelsDialog } from "./PlanModelsDialog";
import { pricingPageContent } from "./pricingPageContent";
import { annualDiscountPercent, commonDiscountPercent, displayablePromotion, joinPlanNames, promotionAppliesToPlan, promotionPeriodPhrase, promotionPlanNames } from "./pricingPromotion";
import { usePricingPurchaseFlow } from "./usePricingPurchaseFlow";
import "../v2-pages.css";
import "./pricing-page.css";

/** What a paid plan card shows for its price until the live market price loads. */
const PRICE_PENDING = "—";

// Pricing page (approved concept, owner 2026-11-20). Only the layout and wording are new:
// prices, credits and packs come from the billing config, the plan buttons and the purchase
// flow are the previous page's (usePricingPurchaseFlow, UpgradeInterestButton,
// PlanChangeDialog, CreditPackPurchaseButton), and every call to them is unchanged.

const REVIEW_SIGN_IN_HREF = `/auth/signin?callbackUrl=${encodeURIComponent(REVIEW_WORKSPACE_PATH)}`;

const PLAN_IDS = ["free", "pro", "max"] as const;
type PlanId = (typeof PLAN_IDS)[number];
const PLAN_NAME: Record<PlanId, ModelTier> = { free: "Free", pro: "Pro", max: "Max" };
const PLAN_ORDER: Record<AccountPlanTier, number> = { Free: 0, Pro: 1, Max: 2 };
const CREDIT_PACK_PLACEHOLDER_KEYS = ["starter_500", "project_1500", "power_4000"] as const;

const NUMBER_LOCALE: Record<Language, string> = {
  en: "en-AU",
  ko: "ko-KR",
  zh: "zh-CN",
  "zh-Hant": "zh-TW",
  fr: "fr-FR",
  de: "de-DE",
  es: "es-ES",
  pt: "pt-BR",
};

// The billing-cycle selector exists in Korean only, as on the previous page: it is the one
// place a cycle is chosen before checkout, and only the Korean sign-in round trip and
// checkout dialog take it over. Other languages choose the cycle in the checkout dialog.
const KO_BILLING = {
  legend: "신규 구독 결제 주기",
  monthly: "월간 결제",
  annual: "연간 결제",
  currency: (currency: string) => `표시 통화: ${currency}.`,
  annualTotal: (price: string) => `연 ${price} 일괄 결제`,
  promotionPeriod: (period: string, price: string) => `${period} ${price} 결제`,
  month: (price: string) => `월 ${price} 결제`,
  confirm: "할인 적용과 최종 결제 조건은 다음 확인창에서 확인하세요.",
};

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));

/** Replaces `{name}` tokens in a sentence with the given nodes. */
function Linked({ text, links }: { text: string; links: Record<string, ReactNode> }) {
  return <>{text.split(/(\{\w+\})/).map((part, i) => {
    const token = /^\{(\w+)\}$/.exec(part)?.[1];
    return token && links[token] ? <Fragment key={i}>{links[token]}</Fragment> : part;
  })}</>;
}

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduce(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduce;
}

export function PricingPage() {
  const { lang, t } = useLanguage();
  const copy = pricingPageContent[lang] ?? pricingPageContent.en;
  const billing = usePublicBilling();
  const account = usePricingAccount();
  const ctaText = purchaseCtaCopy[lang] ?? purchaseCtaCopy.en;
  const {
    pageIntent,
    starterLabelKey,
    subscriptionInterval,
    setSubscriptionInterval,
    billingOutcome,
    creditModal,
    setCreditModal,
    planChangeTarget,
    setPlanChangeTarget,
    planChangeTriggerRef,
    resumedSubscriptionPlan,
    creditPackCtaRef,
    creditPackReturnTo,
    creditPackSignInHref,
    planSignInHref,
    trackCreditPackCtaClick,
  } = usePricingPurchaseFlow(lang, account);
  const { publicModels } = useModelCatalog();
  const { chatHref, isAuthenticated, guestTrialAvailable } = useMarketingChatEntry();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [motionPaused, setMotionPaused] = useState(false);
  const reduce = prefersReducedMotion || motionPaused;
  const [modelsPlan, setModelsPlan] = useState<PlanId | null>(null);

  const numberFormatter = new Intl.NumberFormat(NUMBER_LOCALE[lang]);
  const formatCredits = (count: number) =>
    formatCountedUnit(count, copy.plans.creditUnit, lang, (value) => numberFormatter.format(value));
  const featuredPromotion = displayablePromotion(billing.config?.featuredPromotion);
  const publicCreditPacks = billing.config?.creditPacks ?? [];
  const catalog = publicModels.filter((model) => model.enabled);
  const limits = Object.fromEntries(PLAN_IDS.map((id) => [id, billing.planLimits(id)])) as Record<PlanId, ReturnType<typeof billing.planLimits>>;
  const dailyText = (id: PlanId) => limits[id].dailyCredits === 0 ? copy.plans.dailyNone : formatCredits(limits[id].dailyCredits);
  const planModelCount = (id: PlanId) =>
    fill(copy.plans.modelCount, {
      n: numberFormatter.format(catalog.filter((model) => canUseModelWithPlan(PLAN_NAME[id], model)).length),
      total: numberFormatter.format(catalog.length),
    });

  const withCurrencyCode = (price: string, currency: string) => lang === "ko" ? `${price} ${currency}` : price;
  const planPriceCurrency = (planId: PlanId, interval: "monthly" | "annual") => {
    const plan = billing.config?.plans.find((item) => item.id === planId);
    const displayAmount = interval === "annual" ? plan?.displayAnnualPriceAmount : plan?.displayMonthlyPriceAmount;
    return plan?.displayCurrency && typeof displayAmount === "number" ? plan.displayCurrency : plan?.currency || "USD";
  };
  // A sale price only from the live market price: before /api/billing/config answers, or when
  // it fails, there is no price to discount, so no sale price is shown.
  const formatSalePrice = (planId: PlanId, discountPercent: number) => {
    const plan = billing.config?.plans.find((item) => item.id === planId);
    if (!plan) return null;
    const discountMultiplier = 1 - discountPercent / 100;
    if (plan.displayCurrency && typeof plan.displayMonthlyPriceAmount === "number") {
      const digits = billingCurrencyFractionDigits(plan.displayCurrency as BillingCurrency);
      return withCurrencyCode(
        formatBillingAmount(plan.displayMonthlyPriceAmount * discountMultiplier, plan.displayCurrency as BillingCurrency, undefined, digits),
        plan.displayCurrency
      );
    }
    const currency = (plan.currency || "USD") as BillingCurrency;
    return withCurrencyCode(
      formatBillingAmount(billingMinorToMajor(plan.monthlyPriceCents, currency) * discountMultiplier, currency),
      currency
    );
  };
  const promotionEndDate = featuredPromotion
    ? new Intl.DateTimeFormat(NUMBER_LOCALE[lang], { year: "numeric", month: "long", day: "numeric", timeZone: "Australia/Brisbane" })
        .format(new Date(new Date(featuredPromotion.endsAt).getTime() - 1))
    : null;
  const percent = featuredPromotion ? numberFormatter.format(featuredPromotion.discountPercent) : "";
  const discountLabel = fill(copy.plans.promo.discount, { percent });
  // How long the promotion lasts and which plans it is for come from the promotion itself.
  const promotionPlans = joinPlanNames(promotionPlanNames(featuredPromotion), copy.plans.promo.or);
  const promotionPeriod = featuredPromotion
    ? promotionPeriodPhrase(copy.plans.promo.period, featuredPromotion.durationMonths, (value) => numberFormatter.format(value))
    : "";
  const promotionValues = { percent, period: promotionPeriod, plans: promotionPlans };
  const saleDuration = fill(copy.plans.sale.duration, promotionValues);
  // A plan's annual saving is worked out from its own prices; the page names none it cannot back.
  // Like the prices, a saving is named only from the live market price.
  const annualPercent = (planId: PlanId) => annualDiscountPercent(billing.config?.plans.find((item) => item.id === planId));
  const saveLabel = (value: number | null) => value === null ? null : fill(copy.plans.save, { percent: numberFormatter.format(value) });
  const selectorSave = saveLabel(commonDiscountPercent((["pro", "max"] as const).map(annualPercent)));

  const modelsHref = localizedPath(lang, "/models");
  const reviewHref = localizedPath(lang, "/products/review");
  const linkStyle = { color: "var(--brand-hi)" };
  const packDisplayName = (packId: PurchaseCreditPackId | null) => packId ? copy.packs.packNames[packId] : copy.packs.title;
  const koIntervalSelector = lang === "ko" && (account.status === "unauthenticated" || (account.status === "authenticated" && !account.hasActiveSubscription));

  /** The add-on CTA, in whichever of its three states applies. */
  const renderCreditPackCta = ({ packId, ctaLocation, variant, testId }: {
    packId: PurchaseCreditPackId | null;
    ctaLocation: string;
    variant: "primary" | "secondary";
    testId: string;
  }) => {
    const className = variant === "primary" ? "btn" : "btn ghost";
    // The section CTA keeps its general label even when it is armed with a pack to resume:
    // "Buy this pack" belongs on a pack card, next to the pack it names.
    const label = variant === "secondary" ? ctaText.buyThisPack : ctaText.buyCredits;
    if (account.status === "loading") {
      return <span data-testid={testId} data-cta-state="loading" aria-busy="true" className={`${className} is-busy`}>{ctaText.ctaLoading}</span>;
    }
    if (account.status === "unauthenticated") {
      return <Link href={creditPackSignInHref(packId, ctaLocation)} data-testid={testId} data-cta-state="signed_out"
        onClick={() => trackCreditPackCtaClick(packId, ctaLocation)} className={className}>{ctaText.signInToBuyCredits}</Link>;
    }
    return <button type="button" data-testid={testId} data-cta-state="authenticated"
      onClick={() => {
        trackCreditPackCtaClick(packId, ctaLocation);
        setCreditModal({ open: true, packId, ctaLocation });
      }} className={className}>{label}</button>;
  };

  const planButtonClass = (highlighted: boolean) => highlighted ? "btn" : "btn ghost";

  const renderPlanCard = (planId: PlanId, index: 0 | 1 | 2) => {
    const name = PLAN_NAME[planId];
    const cardPlan: AccountPlanTier = name;
    const highlighted = planId === "pro";
    const publicPlan = billing.config?.plans.find((item) => item.id === planId);
    const ctaState = resolvePlanCtaState({
      sessionStatus: account.status,
      currentPlan: account.plan,
      cardPlan,
      hasActiveSubscription: account.hasActiveSubscription,
      // A change always happens on the interval the subscription already bills on.
      currentBillingInterval: account.billingInterval,
    });
    // The card the visitor asked for when they clicked "Upgrade" elsewhere. It is marked with a
    // ring and a named region, so the identification is not carried by colour alone.
    const isRequestedTarget = planId !== "free" && pageIntent?.targetPlan === planId;
    const paid = planId !== "free";
    const annualSelected = paid && koIntervalSelector && subscriptionInterval === "annual";
    // A paid price is stated only from the live market price; until it loads (or when it fails)
    // the card shows a dash rather than a built-in default that may not be what checkout charges.
    const livePrice = planId === "free" || Boolean(publicPlan);
    const monthlyPrice = livePrice ? withCurrencyCode(billing.formatPlanPriceOrDefault(planId), planPriceCurrency(planId, "monthly")) : PRICE_PENDING;
    const annualPrice = livePrice ? withCurrencyCode(billing.formatPlanPriceOrDefault(planId, "annual"), planPriceCurrency(planId, "annual")) : PRICE_PENDING;
    const annualMonthlyEquivalent = publicPlan
      ? publicPlan.displayCurrency && typeof publicPlan.displayAnnualPriceAmount === "number"
        ? formatBillingAmount(publicPlan.displayAnnualPriceAmount / 12, publicPlan.displayCurrency as BillingCurrency)
        : formatBillingAmount(billingMinorToMajor(publicPlan.annualPriceCents, publicPlan.currency as BillingCurrency) / 12, publicPlan.currency as BillingCurrency)
      : null;
    const promotionEligible = promotionAppliesToPlan(featuredPromotion, planId);
    const salePrice = promotionEligible && featuredPromotion ? formatSalePrice(planId, featuredPromotion.discountPercent) : null;
    const period = copy.plans.period;
    const bigPrice = annualSelected ? annualPrice : monthlyPrice;
    const bigPeriod = annualSelected ? copy.plans.periodYear : period;
    const ctaClass = planButtonClass(highlighted);
    const ticks = copy.plans.ticks[planId];
    const planSave = saveLabel(annualPercent(planId));
    const ctaHidden = planId === "free" && shouldHideFreePlanCta(account.status, account.plan);

    return <article key={planId} className={`plan${highlighted ? " rec" : ""}${isRequestedTarget ? " requested" : ""}`}
      data-testid={`pricing-plan-card-${planId}`} data-cta-state={ctaState}
      data-requested-target={isRequestedTarget ? "true" : undefined} aria-labelledby={`pricing-plan-name-${planId}`}>
      {isRequestedTarget ? <p className="sr-only">{ctaText.upgradeTo(name)}</p> : null}
      {highlighted ? <span className="tag chip blue">{copy.plans.recommended}</span> : null}
      <div className="plan-head">
        <h3 id={`pricing-plan-name-${planId}`}>{name}</h3>
        <p className="who">{copy.plans.who[index]}</p>
      </div>
      {promotionEligible && salePrice && !annualSelected ? <div data-testid="pricing-sale-block" className="sale-block">
        <div className="sale-top">
          <span className="chip amber">{copy.plans.sale.badge}</span>
          <span data-testid="pricing-discount-badge" className="sale-discount">{discountLabel}</span>
        </div>
        {/* The sale is spoken once as a sentence, with the visual row hidden from assistive tech. */}
        <span className="sr-only">{`${formatPriceWithPeriod(salePrice ?? monthlyPrice, period, lang)}. ${copy.plans.sale.regular}: ${formatPriceWithPeriod(monthlyPrice, period, lang)}.`}</span>
        <div aria-hidden="true" className="price sale-price">
          <span className="big-num">{salePrice}</span>
          <small>{formatBillingPeriodLabel(period, lang)}</small>
          <s>{monthlyPrice}</s>
        </div>
        <p className="price-sub">{saleDuration}. {copy.plans.sale.regular}: {monthlyPrice} {formatBillingPeriodLabel(period, lang)}.</p>
      </div> : <div className="price-block">
        {/* The price and its period are separate spans so they can differ in size; the phrase is
            spoken once here and the visual pair is hidden, so it is never read as "$15per month". */}
        <span className="sr-only">{formatPriceWithPeriod(bigPrice, bigPeriod, lang)}</span>
        <div aria-hidden="true" className="price">
          <span data-testid="pricing-plan-price" className="big-num">{bigPrice}</span>
          <small>{formatBillingPeriodLabel(bigPeriod, lang)}</small>
        </div>
      </div>}
      {paid ? <div className="annual-box">
        <div className="annual-top">
          <span>{copy.plans.annual}</span>
          {planSave ? <span className="chip blue">{planSave}</span> : null}
        </div>
        {annualSelected ? null : <div className="annual-price">{formatPriceWithPeriod(annualPrice, copy.plans.periodYear, lang)}</div>}
        {annualMonthlyEquivalent ? <p className="annual-eq" data-testid={`pricing-annual-equivalent-${planId}`}>
          {fill(copy.plans.equivalent, { amount: annualMonthlyEquivalent })}
        </p> : null}
        <p data-testid="pricing-annual-checkout-note" className="annual-note">
          {lang === "ko" ? `${KO_BILLING.currency(planPriceCurrency(planId, "annual"))} ${copy.plans.checkout}` : copy.plans.checkout}
        </p>
      </div> : <div aria-hidden="true" data-testid="pricing-annual-placeholder" className="annual-slot" />}
      <div className="credits-line" data-testid="pricing-plan-usage">
        <span>{copy.plans.creditsLabel}</span><b>{numberFormatter.format(limits[planId].monthlyCredits)}</b>
      </div>
      <div className="credits-line" data-testid={`pricing-plan-daily-${planId}`}>
        <span>{copy.plans.dailyLabel}</span><b>{dailyText(planId)}</b>
      </div>
      <ul className="ticks">
        {ticks.map((tick, tickIndex) => <li key={tick}><span>{tick}{planId === "free" && tickIndex === 0 ? <small>{copy.plans.lockedNote}</small> : null}</span></li>)}
      </ul>
      <button type="button" className="plan-models" aria-haspopup="dialog" aria-describedby={`pricing-plan-name-${planId}`}
        data-testid={`pricing-models-${planId}`} onClick={() => setModelsPlan(planId)}>
        <span>{copy.plans.viewModels}</span><b>{planModelCount(planId)}</b>
      </button>
      {/* The plan CTA is chosen by resolvePlanCtaState(), not by the card's own name: a Pro subscriber
          is never offered Pro again, and a plan change goes to the change screen, not to a checkout
          the server would refuse. */}
      <div data-testid={`pricing-cta-${planId}`} data-cta-state={ctaHidden ? "hidden" : ctaState} className="plan-cta">
        {ctaHidden ? null : ctaState === "loading" ? (
          <span aria-busy="true" className={`${ctaClass} is-busy`}>{ctaText.ctaLoading}</span>
        ) : ctaState === "current_plan" ? (
          <button type="button" disabled aria-current="true" className={ctaClass}>{ctaText.currentPlan}</button>
        ) : ctaState === "change_plan" ? (
          <button ref={planChangeTriggerRef} type="button" data-testid={`pricing-change-plan-${planId}`}
            onClick={() => {
              trackProductEvent("plan_selected", 0, {
                plan_id: planId,
                target_plan: planId,
                cta_location: `pricing_plan_card_change_${planId}`,
                authentication_state: "authenticated",
                ...(account.plan ? { current_plan: account.plan.toLowerCase() as "free" | "pro" | "max" } : {}),
              });
              setPlanChangeTarget(cardPlan === "Max" ? "Max" : "Pro");
            }} className={ctaClass}>
            {account.plan && PLAN_ORDER[cardPlan] > PLAN_ORDER[account.plan] ? ctaText.upgradeTo(name) : ctaText.changePlanTo(name)}
          </button>
        ) : ctaState === "manage_plan" ? (
          <Link href={buildPlanChangeSupportHref(lang)}
            onClick={() => trackProductEvent("plan_selected", 0, {
              plan_id: planId,
              target_plan: planId,
              cta_location: "pricing_plan_card_manage",
              authentication_state: "authenticated",
              ...(account.plan ? { current_plan: account.plan.toLowerCase() as "free" | "pro" | "max" } : {}),
            })} className={ctaClass}>{ctaText.managePlan}</Link>
        ) : planId === "free" ? (
          <Link href={REVIEW_SIGN_IN_HREF}
            onClick={() => trackProductEvent("plan_selected", 0, {
              plan_id: "free",
              target_plan: "free",
              cta_location: "pricing_plan_card",
              authentication_state: "unauthenticated",
            })} className={ctaClass}>{copy.plans.cta[0]}</Link>
        ) : ctaState === "signed_out" ? (
          <Link href={planSignInHref(planId)}
            onClick={() => {
              trackProductEvent("plan_selected", 0, {
                plan_id: planId,
                target_plan: planId,
                cta_location: `pricing_plan_card_${planId}`,
                authentication_state: "unauthenticated",
              });
              trackProductEvent("authentication_required", 0, {
                cta_location: `pricing_plan_card_${planId}`,
                purchase_type: "subscription",
                target_plan: planId,
                authentication_state: "unauthenticated",
              });
            }} className={ctaClass}>{ctaText.signInAndStart(name)}</Link>
        ) : (
          <UpgradeInterestButton plan={name === "Max" ? "Max" : "Pro"}
            initialBillingInterval={lang === "ko" ? subscriptionInterval : undefined}
            trigger={pageIntent?.trigger || undefined}
            autoOpen={resumedSubscriptionPlan === planId}
            className={ctaClass}>{copy.plans.cta[index]}</UpgradeInterestButton>
        )}
        {lang === "ko" && paid && (ctaState === "signed_out" || ctaState === "upgrade") ? (
          <p data-testid={`pricing-selected-billing-${planId}`} className="cta-note">
            {subscriptionInterval === "annual" ? KO_BILLING.annualTotal(annualPrice) : (salePrice ? KO_BILLING.promotionPeriod(promotionPeriod, salePrice) : KO_BILLING.month(monthlyPrice))}
            <span>{KO_BILLING.confirm}</span>
          </p>
        ) : null}
        {lang !== "ko" && paid && (ctaState === "signed_out" || ctaState === "upgrade") ? (
          <p className="cta-note" data-testid={`pricing-billing-choice-${planId}`}>
            {ctaState === "signed_out" ? copy.plans.billingChoiceSignedOut : copy.plans.billingChoice}
          </p>
        ) : null}
        {ctaState === "manage_plan" && !ctaHidden ? <p className="cta-note">{ctaText.managePlanHint}</p> : null}
      </div>
    </article>;
  };

  const calcLink = <a href="#calc" style={linkStyle}>{copy.faq.calcLink}</a>;
  const longContextNote = billing.config?.appLongContext === true && billing.config.appInputTokenLimit
    ? fill(copy.calc.longContextNote, { tokens: numberFormatter.format(billing.config.appInputTokenLimit) })
    : null;
  const inputLimitNote = billing.config?.appInputTokenLimit && billing.config.appLongContext !== true
    ? fill(copy.calc.inputLimitNote, { tokens: numberFormatter.format(billing.config.appInputTokenLimit) })
    : null;
  const filesCell = (id: PlanId) => billing.config?.plans.find((plan) => plan.id === id)?.allowAttachments === false
    ? copy.compare.attachmentsOff : copy.compare.files[id];
  const modelsListButton = (id: PlanId) => <button type="button" className="plan-models inline" data-testid={`pricing-models-table-${id}`}
    aria-haspopup="dialog" onClick={() => setModelsPlan(id)}><span>{copy.compare.list}</span></button>;
  const dialogPlan = modelsPlan;

  return <div className="tv-page" lang={lang} data-testid="pricing-page" data-motion={reduce ? "paused" : "running"}>
    <MarketingHeader variant="launch" maxWidth="max-w-[1440px]" chatHref={chatHref} reviewInfoHref={reviewHref} />
    <main id="top">
      <section className="page-hero dark-zone" aria-labelledby="pricing-title">
        <div className="hero-media" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/marketing/v2/pricing-hero.jpg" alt="" className="drift" />
        </div>
        <div className="wrap">
          <p className="crumb"><Link href={localizedPath(lang, "/")}>Tomverse</Link> / <b>{copy.crumb}</b></p>
          <h1 id="pricing-title" data-testid="pricing-title">{copy.hero.title[0]}<br /><em>{copy.hero.title[1]}</em></h1>
          {starterLabelKey ? <p data-testid="pricing-starter-notice" className="hero-note">{copy.plans.starterPrefix}{t(starterLabelKey)}</p> : null}
          <p className="hero-lede">{fill(copy.hero.body, { standard: formatCredits(MODEL_USAGE_CREDIT_WEIGHTS.standard) })}</p>
          <div className="hero-actions">
            <Link href={chatHref} className="btn" data-testid="pricing-primary-cta"><span>{copy.hero.primary}</span><span aria-hidden="true">↗</span></Link>
            <a href="#calc" className="btn ghost"><span>{copy.hero.secondary}</span><span aria-hidden="true">↓</span></a>
          </div>
          {!prefersReducedMotion && <button type="button" className="motion-toggle" data-testid="pricing-motion-toggle" aria-pressed={motionPaused}
            onClick={() => setMotionPaused((paused) => !paused)}>
            <span className="icon" aria-hidden="true">{motionPaused ? "▶" : "❚❚"}</span>{motionPaused ? copy.hero.motionOn : copy.hero.motionOff}
          </button>}
        </div>
      </section>

      <section className="chapter points-chapter" aria-label={copy.points.items[0][0]}>
        <div className="wrap">
          <div className="sig-points" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))", marginBottom: 0 }}>
            {copy.points.items.map(([title, body]) => <div key={title}><b>{title}</b><span>{body}</span></div>)}
          </div>
          <p className="note">{fill(copy.points.note, { daily: dailyText("free") })}</p>
        </div>
      </section>

      <section className="chapter plans-chapter" aria-labelledby="pricing-plans-title">
        <div className="wrap">
          <h2 id="pricing-plans-title" className="sr-only">{copy.plans.heading}</h2>
          {billingOutcome?.status === "cancelled" ? <div role="status" data-testid="pricing-subscription-cancelled" className="outcome">
            {ctaText.purchaseCancelledTitle}{" — "}{ctaText.purchaseCancelledBody(billingOutcome.planId === "max" ? "Max" : "Pro")}
          </div> : null}
          {/* One page-level status region rather than one per card: three announcements of
              "Checking your account" are noise, and the neutral buttons are already labelled. */}
          {account.status === "loading" ? <p role="status" className="sr-only">{ctaText.ctaLoadingStatus}</p> : null}
          {featuredPromotion && promotionPlans ? <div className="promo-banner">
            <div className="promo-top">
              <span className="chip amber">{copy.plans.sale.badge}</span>
              <b className="promo-discount">{discountLabel}</b>
              <span className="promo-duration">{saleDuration}</span>
            </div>
            <p>{fill(copy.plans.promo.billingNote, promotionValues)}</p>
            <div className="promo-chips">
              <span className="chip blue">{copy.plans.promo.code}: {featuredPromotion.code}</span>
              <span className="chip">{fill(copy.plans.promo.eligibility, promotionValues)}</span>
              <span className="chip">{copy.plans.promo.ends}: {promotionEndDate} · {copy.plans.promo.timezone}</span>
            </div>
          </div> : null}
          {koIntervalSelector ? <fieldset className="bill">
            <legend className="sr-only">{KO_BILLING.legend}</legend>
            <div className="seg">
              {(["monthly", "annual"] as const).map((interval) => <label key={interval} className={subscriptionInterval === interval ? "on" : ""}>
                <input type="radio" name="subscription-billing-interval" value={interval} checked={subscriptionInterval === interval}
                  onChange={() => setSubscriptionInterval(interval)} />
                <span>{interval === "annual" ? KO_BILLING.annual : KO_BILLING.monthly}</span>
              </label>)}
            </div>
            {selectorSave ? <span className="chip blue">{selectorSave}</span> : null}
          </fieldset> : null}
          <div id={PRICING_PLANS_ANCHOR} className="plans3">
            {PLAN_IDS.map((planId, index) => renderPlanCard(planId, index as 0 | 1 | 2))}
          </div>
          <p className="note">{copy.plans.note}</p>
          {/* One change screen for the page, opened by whichever card offers a change: a subscriber
              has exactly one subscription to change, and two dialogs would be two focus traps. */}
          {planChangeTarget ? <PlanChangeDialog open
            onOpenChange={(open) => setPlanChangeTarget(open ? planChangeTarget : null)}
            targetTier={planChangeTarget} billingInterval={account.billingInterval} lang={lang}
            returnFocusToRef={planChangeTriggerRef} /> : null}
        </div>
      </section>

      {dialogPlan ? <PlanModelsDialog plan={PLAN_NAME[dialogPlan]} planIndex={PLAN_IDS.indexOf(dialogPlan) as 0 | 1 | 2} copy={copy.models}
        models={catalog} dailyLabel={dailyText(dialogPlan)} catalogHref={modelsHref}
        onClose={() => setModelsPlan(null)} /> : null}

      <section id="calc" className="chapter signature-chapter" aria-labelledby="calc-title" data-testid="pricing-calculator">
        <div className="wrap">
          <span className="eyebrow">{copy.calc.eyebrow}</span>
          <h2 id="calc-title" className="section-title">{copy.calc.title[0]}<br /><em>{copy.calc.title[1]}</em></h2>
          <CreditCalculator copy={copy.calc} numberFormat={numberFormatter} formatCredits={formatCredits}
            plans={PLAN_IDS.map((id) => ({ id, name: PLAN_NAME[id], monthlyCredits: limits[id].monthlyCredits }))}
            longContextNote={longContextNote} inputLimitNote={inputLimitNote}
            higherNote={<Linked text={copy.calc.higher} links={{ models: <Link href={modelsHref} style={linkStyle}>{copy.calc.modelsLink}</Link> }} />} />
        </div>
      </section>

      <section id={PRICING_CREDIT_PACKS_ANCHOR} className="chapter" data-testid="pricing-credit-packs" aria-labelledby="packs-title">
        <div className="wrap">
          {billingOutcome?.status === "credits-success" || billingOutcome?.status === "credits-cancelled" ? <div role="status"
            data-testid="pricing-credit-outcome" data-outcome={billingOutcome.status}
            className={`outcome${billingOutcome.status === "credits-success" ? " ok" : ""}`}>
            <p><b>{billingOutcome.status === "credits-success" ? ctaText.purchaseSuccessTitle : ctaText.purchaseCancelledTitle}</b></p>
            <p>{billingOutcome.status === "credits-success"
              ? ctaText.purchaseSuccessBody(packDisplayName(billingOutcome.packId))
              : ctaText.purchaseCancelledBody(packDisplayName(billingOutcome.packId))}</p>
          </div> : null}
          <div className="chapter-head">
            <div><span className="eyebrow">{copy.packs.eyebrow}</span><h2 id="packs-title">{copy.packs.title}</h2></div>
            <div>
              <p>{copy.packs.description}</p>
              <div ref={creditPackCtaRef} className="pack-section-cta">
                {renderCreditPackCta({
                  // Only a cancelled purchase re-arms the section button with the pack that was
                  // abandoned. After a completed one there is nothing to resume.
                  packId: billingOutcome?.status === "credits-cancelled" ? billingOutcome.packId : null,
                  ctaLocation: "pricing_credit_pack_section",
                  variant: "primary",
                  testId: "credit-pack-section-cta",
                })}
              </div>
            </div>
          </div>
          <div className="packs">
            {publicCreditPacks.length === 0 ? <>
              <p className="sr-only" role="status">{copy.packs.loading}</p>
              {CREDIT_PACK_PLACEHOLDER_KEYS.map((key) => <div key={key} aria-hidden="true" data-testid="credit-pack-placeholder" className="card pack skeleton">
                <i /><i /><i /><i />
              </div>)}
            </> : publicCreditPacks.map((pack) => <article key={pack.id} data-pack-id={pack.id} className="card pack">
              <span className="k">{copy.packs.packNames[pack.id]}</span>
              <span className="pack-plans">{copy.packs.availableFor}: {pack.allowedPlans.join(" / ")}</span>
              <span className="big-num">{numberFormatter.format(pack.credits)}</span>
              <p className="pack-credits">{copy.packs.credits} · {withCurrencyCode(formatBillingMinor(pack.priceMinor, pack.currency as BillingCurrency, NUMBER_LOCALE[lang]), pack.currency)}</p>
              <p>{copy.packs.packDescriptions[pack.id]}</p>
              <p className="foot-note">{copy.packs.oneTime} · {fill(copy.packs.validity, { days: pack.validityDays })}</p>
              <div className="pack-cta">
                {renderCreditPackCta({
                  packId: pack.id,
                  ctaLocation: "pricing_credit_pack_card",
                  variant: "secondary",
                  testId: `credit-pack-card-cta-${pack.id}`,
                })}
              </div>
            </article>)}
          </div>
          <h3 className="packs-policy-title">{copy.packs.policyTitle}</h3>
          <ul className="ticks packs-policy">
            {copy.packs.policies.map((policy) => <li key={policy}><span>{policy}</span></li>)}
          </ul>
          <p className="note">{copy.packs.guidance}</p>
          {/* One modal for the whole section, opened by the section button, by any pack card or by a
              purchase resumed after sign-in. One per button would mean several fetches of the same
              catalogue and several focus traps competing for the page. */}
          <CreditPackPurchaseButton hideTrigger open={creditModal.open}
            onOpenChange={(open) => setCreditModal((current) => ({ ...current, open }))}
            initialPackId={creditModal.packId} ctaLocation={creditModal.ctaLocation}
            returnTo={creditPackReturnTo} trigger={pageIntent?.trigger || "proactive"} />
        </div>
      </section>

      <section className="chapter" style={{ paddingTop: 24 }} aria-labelledby="compare-title">
        <div className="wrap">
          <span className="eyebrow">{copy.compare.eyebrow}</span>
          <h2 id="compare-title" className="section-title">{copy.compare.title}</h2>
          {/* A scrollable region needs to be focusable and named, so a keyboard visitor can reach the Max column. */}
          <div className="tbl-wrap" role="region" aria-label={copy.compare.scrollLabel} tabIndex={0}>
            <table className="tbl">
              <thead><tr>{copy.compare.headers.map((heading) => <th key={heading}>{heading}</th>)}</tr></thead>
              <tbody>
                <tr><td>{copy.compare.creditsLabel}</td>{PLAN_IDS.map((id) => <td key={id}>{numberFormatter.format(limits[id].monthlyCredits)}</td>)}</tr>
                <tr><td>{copy.compare.daily}</td>{PLAN_IDS.map((id) => <td key={id}>{dailyText(id)}</td>)}</tr>
                <tr><td>{copy.compare.models.label}</td>{PLAN_IDS.map((id) => <td key={id}>{copy.compare.models[id]} · {modelsListButton(id)}</td>)}</tr>
                <tr><td>{copy.compare.comparison.label}</td>{PLAN_IDS.map((id) => <td key={id}>{copy.compare.comparison[id]}</td>)}</tr>
                <tr><td>{copy.compare.files.label}</td>{PLAN_IDS.map((id) => <td key={id}>{filesCell(id)}</td>)}</tr>
                <tr><td>{copy.compare.sharing.label}</td>{PLAN_IDS.map((id) => <td key={id}>{copy.compare.sharing[id]}</td>)}</tr>
                <tr><td>{copy.compare.deep}</td><td>—</td><td>✓</td><td>✓</td></tr>
                <tr><td>{copy.compare.tools}</td><td>—</td><td>{copy.compare.toolsValue}</td><td>{copy.compare.toolsValue}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="chapter" style={{ paddingTop: 24 }} aria-labelledby="pricing-faq-title">
        <div className="wrap">
          <span className="eyebrow">{copy.faq.eyebrow}</span>
          <h2 id="pricing-faq-title" className="section-title">{copy.faq.title}</h2>
          <div className="faq">
            {copy.faq.items.filter((faq) => !faq.promotionOnly || (featuredPromotion && promotionPlans)).map((faq) => <details key={faq.question}>
              <summary>{faq.question}</summary>
              <p><Linked text={fill(faq.answer, promotionValues)} links={{ calc: calcLink }} /></p>
            </details>)}
          </div>
        </div>
      </section>

      <section className="chapter" style={{ paddingTop: 24 }} aria-labelledby="pricing-cta-title">
        <div className="wrap">
          <div className="cta-band">
            <div>
              <h2 id="pricing-cta-title">{copy.cta.title}</h2>
              {!isAuthenticated && guestTrialAvailable ? <p>{copy.cta.note}</p> : null}
            </div>
            <div className="hero-actions" style={{ margin: 0 }}>
              <Link href={chatHref} className="btn white"><span>{copy.cta.primary}</span><span aria-hidden="true">↗</span></Link>
              <Link href={modelsHref} className="btn ghost"><span>{copy.cta.secondary}</span><span aria-hidden="true">↗</span></Link>
            </div>
          </div>
        </div>
      </section>
    </main>
    <MarketingFooter variant="launch" maxWidth="max-w-[1440px]" />
  </div>;
}

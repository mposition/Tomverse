"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { dispatchAppToast } from "@/lib/appToast";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import {
  getBillingConfigUrl,
  type FeaturedBillingPromotion,
} from "@/components/marketing/usePublicBilling";
import {
  getAnalyticsAttributionSnapshot,
  trackProductEvent,
} from "@/lib/productAnalyticsClient";

type BillingPlan = {
  id: "free" | "pro" | "max";
  name: string;
  monthlyPriceCents: number;
  annualPriceCents: number;
  currency: string;
  baseCurrency?: string;
  baseMonthlyPriceCents?: number;
  baseAnnualPriceCents?: number;
  displayCurrency?: string;
  displayMonthlyPriceAmount?: number;
  displayAnnualPriceAmount?: number;
  displayExchangeRate?: number;
};

type BillingPromotion = {
  discountPercent: number;
  discountAmountCents?: number | null;
  durationMonths: number;
  allowAnnualStacking: boolean;
};

type BillingConfig = {
  plans: BillingPlan[];
  featuredPromotion?: FeaturedBillingPromotion | null;
  promotionPolicy?: {
    codesListed: false;
    validation: "server_only";
    annualDiscountStacking: "promotion_specific_default_denied";
  };
  displayCurrency?: string;
  baseCurrency?: "USD";
};

type BillingInterval = "monthly" | "annual";

type PromotionValidationPayload = {
  valid?: boolean;
  promotion?: BillingPromotion;
  code?: string;
  error?: string;
};

type CheckoutCopy = {
  secureCheckout: string;
  upgradeTo: (plan: string) => string;
  description: string;
  billingCycle: string;
  monthly: string;
  annual: string;
  yearly: string;
  annualOff: string;
  monthlyDescription: string;
  annualDescription: string;
  paymentMethods: string;
  paymentHint: string;
  promoLabel: string;
  promoPlaceholder: string;
  apply: string;
  promoFinePrint: string;
  invalidPromo: string;
  promoApplied: string;
  orderSummary: string;
  plan: string;
  billing: string;
  subtotal: string;
  annualSavings: string;
  availableOffer: (code: string) => string;
  appliedAtCheckout: string;
  dueToday: string;
  localPriceNote: (amount: string) => string;
  renewalNote: (interval: BillingInterval, amount: string) => string;
  continueToCheckout: string;
};

const checkoutCopy: Record<Language, CheckoutCopy> = {
  en: {
    secureCheckout: "Secure checkout",
    upgradeTo: (plan) => `Upgrade to ${plan}`,
    description:
      "Choose your billing cycle, apply a promotion code, then continue to Stripe checkout.",
    billingCycle: "Billing cycle",
    monthly: "Monthly",
    annual: "Annual",
    yearly: "Yearly",
    annualOff: "20% off",
    monthlyDescription: "Pay month to month.",
    annualDescription: "Save 20% with yearly billing.",
    paymentMethods: "Payment methods",
    paymentHint:
      "Stripe shows wallets and PayPal when available for your device, browser, region, and Stripe account settings.",
    promoLabel: "Promotion code",
    promoPlaceholder: "Optional promotion code",
    apply: "Apply",
    promoFinePrint:
      "The validated offer shows its discount period. After it ends, the subscription renews at the regular price unless cancelled.",
    invalidPromo: "Invalid promotion code.",
    promoApplied: "Promotion code applied.",
    orderSummary: "Order summary",
    plan: "Plan",
    billing: "Billing",
    subtotal: "Subtotal",
    annualSavings: "Annual savings",
    availableOffer: (code) => `Available offer: ${code}`,
    appliedAtCheckout: "Applied at checkout",
    dueToday: "Due today",
    localPriceNote: (amount) =>
      `Displayed local price is converted from ${amount}. Checkout is charged in USD.`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `Annual checkout renews every year. Base USD price: ${amount} per year.`
        : `Monthly checkout renews every month. Base USD price: ${amount} per month.`,
    continueToCheckout: "Continue to checkout",
  },
  ko: {
    secureCheckout: "보안 결제",
    upgradeTo: (plan) => `${plan}로 업그레이드`,
    description:
      "결제 주기를 선택하고 프로모션 코드를 적용한 뒤 Stripe 결제로 진행하세요.",
    billingCycle: "결제 주기",
    monthly: "월간",
    annual: "연간",
    yearly: "연간",
    annualOff: "20% 할인",
    monthlyDescription: "매월 결제됩니다.",
    annualDescription: "연간 결제로 20%를 절약하세요.",
    paymentMethods: "결제 방법",
    paymentHint:
      "Stripe는 기기, 브라우저, 지역, 계정 설정에서 지원되는 경우 지갑 결제와 PayPal을 표시합니다.",
    promoLabel: "프로모션 코드",
    promoPlaceholder: "프로모션 코드 선택 입력",
    apply: "적용",
    promoFinePrint:
      "검증된 혜택에 할인 적용 기간이 표시됩니다. 기간 종료 후에는 취소하지 않는 한 정가로 갱신됩니다.",
    invalidPromo: "유효하지 않은 프로모션 코드입니다.",
    promoApplied: "프로모션 코드가 적용되었습니다.",
    orderSummary: "주문 요약",
    plan: "플랜",
    billing: "결제",
    subtotal: "소계",
    annualSavings: "연간 절약",
    availableOffer: (code) => `사용 가능한 혜택: ${code}`,
    appliedAtCheckout: "결제 시 적용",
    dueToday: "오늘 결제 금액",
    localPriceNote: (amount) =>
      `표시된 현지 가격은 ${amount} 기준 환산 금액입니다. 실제 결제는 USD로 청구됩니다.`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `연간 결제는 매년 갱신됩니다. USD 기준 가격: 연 ${amount}.`
        : `월간 결제는 매월 갱신됩니다. USD 기준 가격: 월 ${amount}.`,
    continueToCheckout: "결제 계속하기",
  },
  zh: {
    secureCheckout: "安全结账",
    upgradeTo: (plan) => `升级到 ${plan}`,
    description: "选择计费周期，应用促销代码，然后继续前往 Stripe 结账。",
    billingCycle: "计费周期",
    monthly: "月付",
    annual: "年付",
    yearly: "年付",
    annualOff: "八折优惠",
    monthlyDescription: "按月付款。",
    annualDescription: "选择年付可节省 20%。",
    paymentMethods: "付款方式",
    paymentHint:
      "当你的设备、浏览器、地区和 Stripe 账户设置支持时，Stripe 会显示钱包付款和 PayPal。",
    promoLabel: "促销代码",
    promoPlaceholder: "可选促销代码",
    apply: "应用",
    promoFinePrint:
      "验证后的优惠会显示折扣期限。优惠结束后，如未取消，订阅将按正常价格续订。",
    invalidPromo: "促销代码无效。",
    promoApplied: "促销代码已应用。",
    orderSummary: "订单摘要",
    plan: "方案",
    billing: "计费",
    subtotal: "小计",
    annualSavings: "年付节省",
    availableOffer: (code) => `可用优惠：${code}`,
    appliedAtCheckout: "结账时应用",
    dueToday: "今日应付",
    localPriceNote: (amount) =>
      `显示的本地价格由 ${amount} 换算而来。结账时将以 USD 收费。`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `年付结账每年续订。USD 基准价格：每年 ${amount}。`
        : `月付结账每月续订。USD 基准价格：每月 ${amount}。`,
    continueToCheckout: "继续结账",
  },
  fr: {
    secureCheckout: "Paiement sécurisé",
    upgradeTo: (plan) => `Passer à ${plan}`,
    description:
      "Choisissez votre cycle de facturation, appliquez un code promotionnel, puis continuez vers le paiement Stripe.",
    billingCycle: "Cycle de facturation",
    monthly: "Mensuel",
    annual: "Annuel",
    yearly: "Annuel",
    annualOff: "-20 %",
    monthlyDescription: "Payez mois par mois.",
    annualDescription: "Économisez 20 % avec la facturation annuelle.",
    paymentMethods: "Moyens de paiement",
    paymentHint:
      "Stripe affiche les portefeuilles et PayPal lorsque votre appareil, navigateur, région et compte Stripe le permettent.",
    promoLabel: "Code promotionnel",
    promoPlaceholder: "Code promotionnel facultatif",
    apply: "Appliquer",
    promoFinePrint:
      "L'offre validée indique la durée de la remise. Ensuite, l'abonnement est renouvelé au tarif normal sauf résiliation.",
    invalidPromo: "Code promotionnel invalide.",
    promoApplied: "Code promotionnel appliqué.",
    orderSummary: "Résumé de commande",
    plan: "Offre",
    billing: "Facturation",
    subtotal: "Sous-total",
    annualSavings: "Économie annuelle",
    availableOffer: (code) => `Offre disponible : ${code}`,
    appliedAtCheckout: "Appliqué au paiement",
    dueToday: "À payer aujourd'hui",
    localPriceNote: (amount) =>
      `Le prix local affiché est converti depuis ${amount}. Le paiement est facturé en USD.`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `Le paiement annuel est renouvelé chaque année. Prix de base en USD : ${amount} par an.`
        : `Le paiement mensuel est renouvelé chaque mois. Prix de base en USD : ${amount} par mois.`,
    continueToCheckout: "Continuer vers le paiement",
  },
  de: {
    secureCheckout: "Sichere Zahlung",
    upgradeTo: (plan) => `Upgrade auf ${plan}`,
    description:
      "Wähle deinen Abrechnungszeitraum, wende einen Aktionscode an und fahre dann mit Stripe fort.",
    billingCycle: "Abrechnungszeitraum",
    monthly: "Monatlich",
    annual: "Jährlich",
    yearly: "Jährlich",
    annualOff: "20 % Rabatt",
    monthlyDescription: "Monatlich zahlen.",
    annualDescription: "Spare 20 % mit jährlicher Abrechnung.",
    paymentMethods: "Zahlungsmethoden",
    paymentHint:
      "Stripe zeigt Wallets und PayPal an, wenn sie für dein Gerät, deinen Browser, deine Region und deine Stripe-Kontoeinstellungen verfügbar sind.",
    promoLabel: "Aktionscode",
    promoPlaceholder: "Optionaler Aktionscode",
    apply: "Anwenden",
    promoFinePrint:
      "Das geprüfte Angebot zeigt die Rabattdauer. Danach verlängert sich das Abo zum regulären Preis, sofern es nicht gekündigt wird.",
    invalidPromo: "Ungültiger Aktionscode.",
    promoApplied: "Aktionscode angewendet.",
    orderSummary: "Bestellübersicht",
    plan: "Plan",
    billing: "Abrechnung",
    subtotal: "Zwischensumme",
    annualSavings: "Jährliche Ersparnis",
    availableOffer: (code) => `Verfügbares Angebot: ${code}`,
    appliedAtCheckout: "Beim Checkout angewendet",
    dueToday: "Heute fällig",
    localPriceNote: (amount) =>
      `Der angezeigte lokale Preis wird aus ${amount} umgerechnet. Die Zahlung wird in USD berechnet.`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `Der jährliche Checkout verlängert sich jedes Jahr. Basispreis in USD: ${amount} pro Jahr.`
        : `Der monatliche Checkout verlängert sich jeden Monat. Basispreis in USD: ${amount} pro Monat.`,
    continueToCheckout: "Weiter zum Checkout",
  },
  es: {
    secureCheckout: "Pago seguro",
    upgradeTo: (plan) => `Actualizar a ${plan}`,
    description:
      "Elige tu ciclo de facturación, aplica un código promocional y continúa al pago con Stripe.",
    billingCycle: "Ciclo de facturación",
    monthly: "Mensual",
    annual: "Anual",
    yearly: "Anual",
    annualOff: "20 % desc.",
    monthlyDescription: "Paga mes a mes.",
    annualDescription: "Ahorra un 20 % con la facturación anual.",
    paymentMethods: "Métodos de pago",
    paymentHint:
      "Stripe muestra billeteras y PayPal cuando están disponibles para tu dispositivo, navegador, región y configuración de cuenta de Stripe.",
    promoLabel: "Código promocional",
    promoPlaceholder: "Código promocional opcional",
    apply: "Aplicar",
    promoFinePrint:
      "La oferta validada muestra la duración del descuento. Después, la suscripción se renueva al precio normal salvo cancelación.",
    invalidPromo: "Código promocional no válido.",
    promoApplied: "Código promocional aplicado.",
    orderSummary: "Resumen del pedido",
    plan: "Plan",
    billing: "Facturación",
    subtotal: "Subtotal",
    annualSavings: "Ahorro anual",
    availableOffer: (code) => `Oferta disponible: ${code}`,
    appliedAtCheckout: "Aplicado al pagar",
    dueToday: "A pagar hoy",
    localPriceNote: (amount) =>
      `El precio local mostrado se convierte desde ${amount}. El pago se cobra en USD.`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `El pago anual se renueva cada año. Precio base en USD: ${amount} al año.`
        : `El pago mensual se renueva cada mes. Precio base en USD: ${amount} al mes.`,
    continueToCheckout: "Continuar al pago",
  },
  pt: {
    secureCheckout: "Checkout seguro",
    upgradeTo: (plan) => `Fazer upgrade para ${plan}`,
    description:
      "Escolha o ciclo de cobrança, aplique um código promocional e continue para o checkout da Stripe.",
    billingCycle: "Ciclo de cobrança",
    monthly: "Mensal",
    annual: "Anual",
    yearly: "Anual",
    annualOff: "20% off",
    monthlyDescription: "Pague mês a mês.",
    annualDescription: "Economize 20% com a cobrança anual.",
    paymentMethods: "Métodos de pagamento",
    paymentHint:
      "A Stripe mostra carteiras digitais e PayPal quando disponíveis para seu dispositivo, navegador, região e configurações da conta Stripe.",
    promoLabel: "Código promocional",
    promoPlaceholder: "Código promocional opcional",
    apply: "Aplicar",
    promoFinePrint:
      "A oferta validada mostra a duração do desconto. Depois, a assinatura renova pelo preço normal, salvo cancelamento.",
    invalidPromo: "Código promocional inválido.",
    promoApplied: "Código promocional aplicado.",
    orderSummary: "Resumo do pedido",
    plan: "Plano",
    billing: "Cobrança",
    subtotal: "Subtotal",
    annualSavings: "Economia anual",
    availableOffer: (code) => `Oferta disponível: ${code}`,
    appliedAtCheckout: "Aplicado no checkout",
    dueToday: "Valor hoje",
    localPriceNote: (amount) =>
      `O preço local exibido é convertido de ${amount}. O checkout é cobrado em USD.`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `O checkout anual renova a cada ano. Preço base em USD: ${amount} por ano.`
        : `O checkout mensal renova a cada mês. Preço base em USD: ${amount} por mês.`,
    continueToCheckout: "Continuar para o checkout",
  },
};

const promotionPolicyCopy: Record<Language, string> = {
  en: "Codes are verified by the server. Promotions do not stack with the annual-plan discount unless that specific code explicitly allows it.",
  ko: "코드는 서버에서 검증됩니다. 해당 코드에 연간 중복 할인이 명시적으로 허용된 경우가 아니면 연간 플랜 할인과 중복 적용되지 않습니다.",
  zh: "促销代码由服务器验证。除非该代码明确允许，否则不能与年付折扣叠加。",
  fr: "Les codes sont vérifiés par le serveur. Ils ne se cumulent pas avec la remise annuelle, sauf autorisation explicite du code.",
  de: "Codes werden auf dem Server geprüft. Sie sind nicht mit dem Jahresrabatt kombinierbar, außer der Code erlaubt dies ausdrücklich.",
  es: "Los códigos se validan en el servidor. No se acumulan con el descuento anual salvo que el código lo permita expresamente.",
  pt: "Os códigos são validados no servidor. Não acumulam com o desconto anual, salvo quando o código permitir explicitamente.",
};

type CheckoutLegalCopy = {
  prefix: string;
  terms: string;
  conjunction: string;
  refund: string;
  suffix: string;
};

const checkoutLegalCopy: Record<Language, CheckoutLegalCopy> = {
  en: {
    prefix: "By continuing, you agree to the ",
    terms: "Terms and Conditions",
    conjunction: " and acknowledge the ",
    refund: "Refund Policy",
    suffix:
      ", including automatic renewal and cancellation at the end of the paid period.",
  },
  ko: {
    prefix: "결제를 계속하면 ",
    terms: "이용약관",
    conjunction: "에 동의하고 ",
    refund: "환불 정책",
    suffix:
      "의 자동 갱신 및 결제 기간 말 취소 조건을 확인한 것으로 봅니다.",
  },
  zh: {
    prefix: "继续即表示你同意",
    terms: "条款与条件",
    conjunction: "并确认",
    refund: "退款政策",
    suffix: "，包括自动续订及在已付费周期结束时取消的条件。",
  },
  fr: {
    prefix: "En continuant, vous acceptez les ",
    terms: "Conditions générales",
    conjunction: " et reconnaissez la ",
    refund: "Politique de remboursement",
    suffix:
      ", y compris le renouvellement automatique et la résiliation en fin de période payée.",
  },
  de: {
    prefix: "Mit dem Fortfahren stimmst du den ",
    terms: "Nutzungsbedingungen",
    conjunction: " zu und bestätigst die ",
    refund: "Erstattungsrichtlinie",
    suffix:
      " einschließlich automatischer Verlängerung und Kündigung zum Ende des bezahlten Zeitraums.",
  },
  es: {
    prefix: "Al continuar, aceptas los ",
    terms: "Términos y condiciones",
    conjunction: " y reconoces la ",
    refund: "Política de reembolsos",
    suffix:
      ", incluida la renovación automática y la cancelación al final del periodo pagado.",
  },
  pt: {
    prefix: "Ao continuar, você concorda com os ",
    terms: "Termos e Condições",
    conjunction: " e reconhece a ",
    refund: "Política de Reembolso",
    suffix:
      ", incluindo renovação automática e cancelamento ao final do período pago.",
  },
};

const formatMoney = (
  amount: number,
  currency = "USD",
  fractionDigits = 0
) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(amount);

const formatUsdCents = (cents: number, fractionDigits = 0) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(cents / 100);

const calculateDiscountedCents = (
  cents: number,
  promotion: BillingPromotion | null | undefined
) => {
  if (!promotion) return cents;
  if (promotion.discountPercent > 0) {
    return Math.max(0, Math.round(cents * (1 - promotion.discountPercent / 100)));
  }
  return Math.max(0, cents - (promotion.discountAmountCents || 0));
};

const calculateDiscountedDisplayAmount = (
  amount: number,
  planConfig: BillingPlan | undefined,
  promotion: BillingPromotion | null | undefined
) => {
  if (!promotion) return amount;
  if (promotion.discountPercent > 0) {
    return Math.max(0, amount * (1 - promotion.discountPercent / 100));
  }
  const fixedDiscount =
    ((promotion.discountAmountCents || 0) / 100) *
    (planConfig?.displayExchangeRate || 1);
  return Math.max(0, amount - fixedDiscount);
};

const formatPrice = (
  planConfig: BillingPlan | undefined,
  billingInterval: BillingInterval
) => {
  if (!planConfig) return null;
  const displayAmount =
    billingInterval === "annual"
      ? planConfig.displayAnnualPriceAmount
      : planConfig.displayMonthlyPriceAmount;
  if (planConfig.displayCurrency && typeof displayAmount === "number") {
    return formatMoney(displayAmount, planConfig.displayCurrency);
  }
  const cents =
    billingInterval === "annual"
      ? planConfig.annualPriceCents
      : planConfig.monthlyPriceCents;
  return formatMoney(cents / 100, planConfig.currency || "USD");
};

const formatUsdPrice = (
  planConfig: BillingPlan | undefined,
  billingInterval: BillingInterval
) => {
  if (!planConfig) return null;
  const cents =
    billingInterval === "annual"
      ? planConfig.baseAnnualPriceCents ?? planConfig.annualPriceCents
      : planConfig.baseMonthlyPriceCents ?? planConfig.monthlyPriceCents;
  return formatUsdCents(cents);
};

export function UpgradeInterestButton({
  plan,
  className,
  children,
}: {
  plan: "Pro" | "Max";
  className: string;
  children: ReactNode;
}) {
  const { lang, t } = useLanguage();
  const copy = checkoutCopy[lang] || checkoutCopy.en;
  const legalCopy = checkoutLegalCopy[lang] || checkoutLegalCopy.en;
  const [isSending, setIsSending] = useState(false);
  const [isValidatingPromotion, setIsValidatingPromotion] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const [appliedPromoCode, setAppliedPromoCode] = useState<string | null>(null);
  const [appliedPromotion, setAppliedPromotion] =
    useState<BillingPromotion | null>(null);
  const [billingInterval, setBillingInterval] =
    useState<BillingInterval>("monthly");
  const [billingConfig, setBillingConfig] = useState<BillingConfig | null>(null);
  const billingIntervalRef = useRef<BillingInterval>("monthly");
  const autoPromotionRequestRef = useRef(0);
  const inputId = useId();
  const planId = plan === "Max" ? "max" : "pro";
  const planConfig = billingConfig?.plans.find((item) => item.id === planId);
  const priceLabel = formatPrice(planConfig, billingInterval);
  const monthlyPriceLabel = formatPrice(planConfig, "monthly");
  const annualPriceLabel = formatPrice(planConfig, "annual");
  const usdPriceLabel = formatUsdPrice(planConfig, billingInterval);
  const usdMonthlyPriceLabel = formatUsdPrice(planConfig, "monthly");
  const usdAnnualPriceLabel = formatUsdPrice(planConfig, "annual");
  const discountLabel = appliedPromotion?.discountPercent
    ? `-${appliedPromotion.discountPercent}%`
    : appliedPromotion?.discountAmountCents
      ? `-${formatUsdCents(appliedPromotion.discountAmountCents)}`
      : null;
  const baseCents =
    billingInterval === "annual"
      ? planConfig?.baseAnnualPriceCents ?? planConfig?.annualPriceCents ?? 0
      : planConfig?.baseMonthlyPriceCents ?? planConfig?.monthlyPriceCents ?? 0;
  const dueUsdCents = calculateDiscountedCents(baseCents, appliedPromotion);
  const dueUsdLabel = formatUsdCents(dueUsdCents, 1);
  const displayAmount =
    billingInterval === "annual"
      ? planConfig?.displayAnnualPriceAmount
      : planConfig?.displayMonthlyPriceAmount;
  const dueLabel =
    planConfig?.displayCurrency && typeof displayAmount === "number"
      ? formatMoney(
          calculateDiscountedDisplayAmount(displayAmount, planConfig, appliedPromotion),
          planConfig.displayCurrency,
          1
        )
      : dueUsdLabel;
  const displayedDueLabel = isValidatingPromotion ? "…" : dueLabel;
  const displayedDueUsdLabel = isValidatingPromotion ? null : dueUsdLabel;

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const requestPromotionValidation = useCallback(
    async (
      normalizedCode: string,
      interval: BillingInterval
    ) => {
      const response = await fetch("/api/billing/promotion/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId,
          billingInterval: interval,
          promoCode: normalizedCode,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | PromotionValidationPayload
        | null;
      if (!response.ok || !data?.valid || !data.promotion) {
        throw new Error(data?.error || copy.invalidPromo);
      }
      return data.promotion;
    },
    [copy.invalidPromo, planId]
  );

  const applyFeaturedPromotion = useCallback(async (
    featured: FeaturedBillingPromotion,
    interval: BillingInterval
  ) => {
    const normalizedFeaturedCode = featured.code.trim().toUpperCase();
    const requestId = autoPromotionRequestRef.current + 1;
    autoPromotionRequestRef.current = requestId;
    const eligible =
      featured.appliesToPlanIds.includes(planId) &&
      featured.billingIntervals.includes(interval);
    if (!eligible) {
      setPromoCode("");
      setAppliedPromoCode(null);
      setAppliedPromotion(null);
      setIsValidatingPromotion(false);
      return;
    }

    setPromoCode(normalizedFeaturedCode);
    setAppliedPromoCode(null);
    setAppliedPromotion(null);
    setIsValidatingPromotion(true);
    try {
      const promotion = await requestPromotionValidation(
        normalizedFeaturedCode,
        interval
      );
      if (autoPromotionRequestRef.current !== requestId) return;
      setAppliedPromoCode(normalizedFeaturedCode);
      setAppliedPromotion(promotion);
    } catch (error) {
      if (autoPromotionRequestRef.current !== requestId) return;
      setAppliedPromoCode(null);
      setAppliedPromotion(null);
      setPromoCode("");
      dispatchAppToast(
        error instanceof Error ? error.message : copy.invalidPromo,
        "error"
      );
    } finally {
      if (autoPromotionRequestRef.current === requestId) {
        setIsValidatingPromotion(false);
      }
    }
  }, [copy.invalidPromo, planId, requestPromotionValidation]);

  useEffect(() => {
    if (!isOpen || billingConfig) return;
    fetch(getBillingConfigUrl())
      .then((response) => (response.ok ? response.json() : null))
      .then((data: BillingConfig | null) => {
        if (!data) return;
        setBillingConfig(data);
        if (data.featuredPromotion) {
          void applyFeaturedPromotion(
            data.featuredPromotion,
            billingIntervalRef.current
          );
        }
      })
      .catch(() => undefined);
  }, [applyFeaturedPromotion, billingConfig, isOpen]);

  const submit = async () => {
    if (isSending || isValidatingPromotion) return;
    const normalizedInputCode = promoCode.trim().toUpperCase();
    let failureStage: "promotion_validation" | "checkout_session" =
      "checkout_session";
    setIsSending(true);
    try {
      let checkoutPromoCode = appliedPromoCode;
      let promotionForCheckout = appliedPromotion;
      if (
        normalizedInputCode &&
        (normalizedInputCode !== appliedPromoCode || !appliedPromotion)
      ) {
        failureStage = "promotion_validation";
        setIsValidatingPromotion(true);
        promotionForCheckout = await requestPromotionValidation(
          normalizedInputCode,
          billingInterval
        );
        checkoutPromoCode = normalizedInputCode;
        setAppliedPromoCode(normalizedInputCode);
        setAppliedPromotion(promotionForCheckout);
        dispatchAppToast(copy.promoApplied, "success");
      }

      failureStage = "checkout_session";
      const checkoutDueUsdCents = calculateDiscountedCents(
        baseCents,
        promotionForCheckout
      );
      const analytics = getAnalyticsAttributionSnapshot();
      trackProductEvent("checkout_started", 0, {
        billing_interval: billingInterval,
        plan_id: planId,
        value: checkoutDueUsdCents / 100,
        currency: "USD",
      });
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId,
          billingInterval,
          language: lang,
          promoCode: checkoutPromoCode || undefined,
          ...(analytics ? { analytics } : {}),
        }),
      });
      if (response.status === 401) {
        window.location.assign(
          `/auth/signin?callbackUrl=${encodeURIComponent(window.location.pathname)}`
        );
        return;
      }
      const data = (await response.json().catch(() => null)) as
        | { url?: string; redirectUrl?: string; success?: boolean; error?: string }
        | null;
      if (response.ok && data?.success && data.redirectUrl) {
        window.location.assign(data.redirectUrl);
        return;
      }
      if (!response.ok || !data?.url) {
        throw new Error(data?.error || "Checkout failed");
      }
      window.location.assign(data.url);
    } catch (error) {
      const errorCode =
        error instanceof TypeError
          ? "network_error"
          : failureStage === "promotion_validation"
            ? "promotion_invalid"
            : "checkout_request_failed";
      trackProductEvent("checkout_failed", 0, {
        billing_interval: billingInterval,
        plan_id: planId,
        failure_stage: failureStage,
        error_code: errorCode,
      });
      dispatchAppToast(
        error instanceof Error ? error.message : t("billing.waitlistFailed"),
        "error"
      );
    } finally {
      setIsSending(false);
      setIsValidatingPromotion(false);
    }
  };

  const applyPromotion = async () => {
    const normalizedCode = promoCode.trim().toUpperCase();
    if (!normalizedCode) {
      setAppliedPromoCode(null);
      setAppliedPromotion(null);
      return;
    }
    if (isValidatingPromotion) return;
    setIsValidatingPromotion(true);
    try {
      const promotion = await requestPromotionValidation(
        normalizedCode,
        billingInterval
      );
      setAppliedPromoCode(normalizedCode);
      setAppliedPromotion(promotion);
      dispatchAppToast(copy.promoApplied, "success");
    } catch (error) {
      setAppliedPromoCode(null);
      setAppliedPromotion(null);
      dispatchAppToast(
        error instanceof Error ? error.message : copy.invalidPromo,
        "error"
      );
    } finally {
      setIsValidatingPromotion(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          trackProductEvent("plan_selected", 0, {
            cta_location: `upgrade_${planId}`,
            plan_id: planId,
          });
          trackProductEvent("cta_start_click", 0, {
            cta_location: `upgrade_${planId}`,
            plan_id: planId,
          });
          setIsOpen(true);
          if (billingConfig?.featuredPromotion) {
            void applyFeaturedPromotion(
              billingConfig.featuredPromotion,
              billingInterval
            );
          }
        }}
        disabled={isSending}
        className={className}
      >
        {isSending ? t("billing.sending") : children}
      </button>
      {isOpen ? (
        <div
          className="fixed inset-0 z-[90] flex items-end justify-center bg-black/60 px-3 py-3 backdrop-blur-sm sm:items-center sm:py-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${inputId}-title`}
        >
          <form
            className="grid max-h-[calc(100dvh-1.5rem)] w-full max-w-4xl overflow-y-auto rounded-3xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 md:max-h-[92vh] md:grid-cols-[1.1fr_0.9fr] md:overflow-hidden"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="p-5 pb-3 sm:p-6 md:overflow-y-auto">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-600 dark:text-blue-300">
                    {copy.secureCheckout}
                  </p>
                  <h2
                    id={`${inputId}-title`}
                    className="mt-2 text-2xl font-black text-zinc-950 dark:text-white"
                  >
                    {copy.upgradeTo(plan)}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                    {copy.description}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="rounded-full border border-zinc-200 px-3 py-1 text-sm font-bold text-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-400 dark:hover:text-white"
                  aria-label={t("billing.close")}
                >
                  x
                </button>
              </div>

              <div className="mt-6">
                <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                  {copy.billingCycle}
                </p>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {([
                    ["monthly", copy.monthly, monthlyPriceLabel, copy.monthlyDescription],
                    ["annual", copy.annual, annualPriceLabel, copy.annualDescription],
                  ] as const).map(([value, label, amount, description]) => (
                    <button
                      key={value}
                      type="button"
                      disabled={isValidatingPromotion}
                      onClick={() => {
                        billingIntervalRef.current = value;
                        setBillingInterval(value);
                        if (billingConfig?.featuredPromotion) {
                          void applyFeaturedPromotion(
                            billingConfig.featuredPromotion,
                            value
                          );
                        } else {
                          setAppliedPromoCode(null);
                          setAppliedPromotion(null);
                        }
                      }}
                      className={`rounded-2xl border p-4 text-left transition ${
                        billingInterval === value
                          ? "border-blue-500 bg-blue-50 ring-4 ring-blue-500/15 dark:bg-blue-500/10"
                          : "border-zinc-200 bg-zinc-50 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/60 dark:hover:border-zinc-700"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-sm font-black text-zinc-950 dark:text-white">
                          {label}
                        </span>
                        {value === "annual" ? (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-[11px] font-black text-emerald-600 dark:text-emerald-300">
                            {copy.annualOff}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-3 block text-2xl font-black text-zinc-950 dark:text-white">
                        {amount || "-"}
                      </span>
                      <span className="mt-1 block text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                        {description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-6 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/60">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                      {copy.paymentMethods}
                    </p>
                    <p className="mt-2 text-xs font-semibold leading-5 text-zinc-500 dark:text-zinc-400">
                      {copy.paymentHint}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    {["PayPal", "GPay", "Apple Pay", "Card"].map((method) => (
                      <span
                        key={method}
                        className="rounded-full bg-zinc-200/70 px-3 py-1.5 text-[11px] font-black text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                      >
                        {method}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <label
                htmlFor={inputId}
                className="mt-6 block text-xs font-black uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400"
              >
                {copy.promoLabel}
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  id={inputId}
                  value={promoCode}
                  disabled={isValidatingPromotion}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setPromoCode(nextValue);
                    if (appliedPromoCode !== nextValue.trim().toUpperCase()) {
                      setAppliedPromoCode(null);
                      setAppliedPromotion(null);
                    }
                  }}
                  className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-base font-black uppercase text-zinc-950 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/15 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
                  placeholder={copy.promoPlaceholder}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={applyPromotion}
                  disabled={isValidatingPromotion}
                  aria-busy={isValidatingPromotion}
                  className="rounded-xl border border-zinc-200 px-4 py-3 text-sm font-black text-zinc-700 hover:bg-zinc-100 disabled:cursor-wait disabled:opacity-60 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  {copy.apply}
                </button>
              </div>
              <p className="mt-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                {copy.promoFinePrint} {promotionPolicyCopy[lang] || promotionPolicyCopy.en}
              </p>
            </div>

            <aside className="flex flex-col border-t border-zinc-200 bg-zinc-50 p-5 pb-3 dark:border-zinc-800 dark:bg-zinc-900/70 md:border-l md:border-t-0 sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                    {copy.orderSummary}
                  </p>
                  <h3 className="mt-2 text-xl font-black text-zinc-950 dark:text-white">
                    Tomverse AI {plan}
                  </h3>
                </div>
                <span className="rounded-full bg-blue-600 px-3 py-1 text-xs font-black text-white">
                  {billingInterval === "annual" ? copy.annual : copy.monthly}
                </span>
              </div>

              <div className="mt-6 space-y-4 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex justify-between gap-4 text-sm">
                  <span className="font-semibold text-zinc-500 dark:text-zinc-400">
                    {copy.plan}
                  </span>
                  <span className="font-black text-zinc-950 dark:text-white">
                    {plan}
                  </span>
                </div>
                <div className="flex justify-between gap-4 text-sm">
                  <span className="font-semibold text-zinc-500 dark:text-zinc-400">
                    {copy.billing}
                  </span>
                  <span className="font-black text-zinc-950 dark:text-white">
                    {billingInterval === "annual" ? copy.yearly : copy.monthly}
                  </span>
                </div>
                <div className="flex justify-between gap-4 text-sm">
                  <span className="font-semibold text-zinc-500 dark:text-zinc-400">
                    {copy.subtotal}
                  </span>
                  <span className="font-black text-zinc-950 dark:text-white">
                    {priceLabel || "-"}
                  </span>
                </div>
                {billingInterval === "annual" ? (
                  <div className="flex justify-between gap-4 text-sm text-emerald-600 dark:text-emerald-300">
                    <span className="font-semibold">{copy.annualSavings}</span>
                    <span className="font-black">20%</span>
                  </div>
                ) : null}
                {appliedPromotion ? (
                  <div className="flex justify-between gap-4 text-sm text-blue-600 dark:text-blue-300">
                    <span className="font-semibold">{appliedPromoCode}</span>
                    <span className="font-black">{discountLabel || copy.appliedAtCheckout}</span>
                  </div>
                ) : null}
                <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
                  <div className="flex justify-between gap-4">
                    <span className="font-black text-zinc-950 dark:text-white">
                      {copy.dueToday}
                    </span>
                    <span className="text-2xl font-black text-zinc-950 dark:text-white">
                      {displayedDueLabel || priceLabel || "-"}
                    </span>
                  </div>
                  {usdPriceLabel && displayedDueUsdLabel ? (
                    <p className="mt-2 text-xs font-semibold leading-5 text-zinc-500 dark:text-zinc-400">
                      {copy.localPriceNote(displayedDueUsdLabel || usdPriceLabel)}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-blue-500/20 bg-blue-500/10 p-4 text-xs font-semibold leading-5 text-blue-700 dark:text-blue-200">
                {copy.renewalNote(
                  billingInterval,
                  billingInterval === "annual"
                    ? usdAnnualPriceLabel || "-"
                    : usdMonthlyPriceLabel || "-"
                )}
              </div>

              <p className="mt-3 text-xs font-semibold leading-5 text-zinc-500 dark:text-zinc-400">
                {legalCopy.prefix}
                <Link
                  href="/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="font-black text-blue-700 underline underline-offset-2 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
                >
                  {legalCopy.terms}
                </Link>
                {legalCopy.conjunction}
                <Link
                  href="/refund"
                  target="_blank"
                  rel="noreferrer"
                  className="font-black text-blue-700 underline underline-offset-2 hover:text-blue-600 dark:text-blue-300 dark:hover:text-blue-200"
                >
                  {legalCopy.refund}
                </Link>
                {legalCopy.suffix}
              </p>

              <div className="mt-auto hidden flex-col gap-2 pt-6 md:flex">
                <button
                  type="submit"
                  disabled={isSending || isValidatingPromotion}
                  className="rounded-xl bg-blue-600 px-4 py-3 text-sm font-black text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSending ? t("billing.sending") : copy.continueToCheckout}
                </button>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="rounded-xl border border-zinc-200 px-4 py-3 text-sm font-black text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  {t("billing.cancel")}
                </button>
              </div>
            </aside>
            <div className="sticky bottom-0 z-20 border-t border-zinc-200 bg-white/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95 md:hidden">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
                  {copy.dueToday}
                </span>
                <span className="text-xl font-black text-zinc-950 dark:text-white">
                  {displayedDueLabel || priceLabel || "-"}
                </span>
              </div>
              <button
                type="submit"
                disabled={isSending || isValidatingPromotion}
                className="w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-black text-white shadow-lg shadow-blue-950/20 hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSending ? t("billing.sending") : copy.continueToCheckout}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

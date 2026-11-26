import type { Language } from "@/components/LanguageProvider";
import type { BillingCurrency } from "@/lib/billingMarkets";

/**
 * Purchase copy and the order-summary arithmetic shared by the web checkout
 * dialog, the credit-pack dialog and Tomverse Desktop's plan screen.
 *
 * Plain data and pure functions only, so a surface that does not run Next.js
 * can show the same renewal, refund and fair-use notices word for word.
 */

type BillingInterval = "monthly" | "annual";

export type BillingPromotion = {
  discountPercent: number;
  discountAmountCents?: number | null;
  durationMonths: number;
  fulfillmentType: "stripe_subscription" | "internal_pass";
  accessDurationDays: number | null;
  paymentMethodRequired: boolean;
  automaticRenewal: boolean;
  allowAnnualStacking: boolean;
};

export type CheckoutCopy = {
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
  promoLabel: string;
  promoPlaceholder: string;
  apply: string;
  promoFinePrint: string;
  invalidPromo: string;
  promoApplied: string;
  promotionCurrencyNotSupported: string;
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
  promotionPeriod: (months: number) => string;
  promotionRenewalNote: (months: number, discounted: string, regular: string) => string;
  continueToCheckout: string;
};

export const foundingTesterPassCopy: Record<
  Language,
  {
    title: string;
    detail: (days: number) => string;
    billingLabel: string;
    activate: string;
  }
> = {
  en: {
    title: "Founding Tester Pass",
    detail: (days) =>
      `${days} days of Pro access. No payment method, charge, or automatic renewal. Your account returns to Free when the pass ends.`,
    billingLabel: "Non-renewing pass",
    activate: "Activate Tester Pass",
  },
  ko: {
    title: "Founding Tester Pass",
    detail: (days) =>
      `${days}일 동안 Pro를 이용합니다. 결제수단 등록, 결제 및 자동 갱신이 없으며 기간 종료 후 Free 플랜으로 전환됩니다.`,
    billingLabel: "자동 갱신 없는 이용권",
    activate: "Tester Pass 활성화",
  },
  zh: {
    title: "创始测试通行证",
    detail: (days) =>
      `${days} 天 Pro 权限。无需付款方式，不收费，也不会自动续费；结束后账户恢复为 Free。`,
    billingLabel: "不自动续费的通行证",
    activate: "激活测试通行证",
  },
  "zh-Hant": {
    title: "創始測試通行證",
    detail: (days) =>
      `${days} 天 Pro 權限。無需付款方式，不收費，也不會自動續費；結束後帳戶會恢復為 Free。`,
    billingLabel: "不自動續費的通行證",
    activate: "啟用測試通行證",
  },
  fr: {
    title: "Pass testeur fondateur",
    detail: (days) =>
      `${days} jours d’accès Pro, sans moyen de paiement, prélèvement ni renouvellement automatique. Le compte repasse ensuite à Free.`,
    billingLabel: "Pass sans renouvellement",
    activate: "Activer le pass testeur",
  },
  de: {
    title: "Founding Tester Pass",
    detail: (days) =>
      `${days} Tage Pro-Zugang ohne Zahlungsmethode, Belastung oder automatische Verlängerung. Danach wird das Konto auf Free zurückgesetzt.`,
    billingLabel: "Pass ohne Verlängerung",
    activate: "Tester Pass aktivieren",
  },
  es: {
    title: "Pase Founding Tester",
    detail: (days) =>
      `${days} días de acceso Pro sin método de pago, cargo ni renovación automática. Después, la cuenta vuelve a Free.`,
    billingLabel: "Pase sin renovación",
    activate: "Activar pase de prueba",
  },
  pt: {
    title: "Passe Founding Tester",
    detail: (days) =>
      `${days} dias de acesso Pro sem método de pagamento, cobrança ou renovação automática. Depois, a conta volta para o Free.`,
    billingLabel: "Passe sem renovação",
    activate: "Ativar passe de teste",
  },
};

export const checkoutCopy: Record<Language, CheckoutCopy> = {
  en: {
    secureCheckout: "Secure checkout",
    upgradeTo: (plan) => `Upgrade to ${plan}`,
    description:
      "Choose a billing cycle and add a promotion code if you have one. Check your total and renewal terms, then continue to payment.",
    billingCycle: "Billing cycle",
    monthly: "Monthly",
    annual: "Annual",
    yearly: "Yearly",
    annualOff: "20% off",
    monthlyDescription: "Pay month to month.",
    annualDescription: "Save 20% with yearly billing.",
    promoLabel: "Promotion code",
    promoPlaceholder: "Optional promotion code",
    apply: "Apply",
    promoFinePrint:
      "The validated offer shows its discount period. After it ends, the subscription renews at the regular price unless cancelled.",
    invalidPromo: "Invalid promotion code.",
    promoApplied: "Promotion code applied.",
    promotionCurrencyNotSupported:
      "Fixed-amount promotion codes currently work only with USD checkout. Use a percentage code for local-currency billing.",
    orderSummary: "Order summary",
    plan: "Plan",
    billing: "Billing",
    subtotal: "Subtotal",
    annualSavings: "Annual savings",
    availableOffer: (code) => `Available offer: ${code}`,
    appliedAtCheckout: "Applied at checkout",
    dueToday: "Due today",
    localPriceNote: (amount) =>
      `Checkout is charged at the fixed local price shown: ${amount}.`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `Annual checkout renews every year at ${amount} per year.`
        : `Monthly checkout renews every month at ${amount} per month.`,
    promotionPeriod: (months) => (months === 1 ? "for 1 month" : `for ${months} months`),
    promotionRenewalNote: (months, discounted, regular) =>
      `${discounted}/month for your first ${months === 1 ? "month" : `${months} months`}, then ${regular}/month until you cancel.`,
    continueToCheckout: "Continue to checkout",
  },
  ko: {
    secureCheckout: "보안 결제",
    upgradeTo: (plan) => `${plan}로 업그레이드`,
    description:
      "결제 주기를 선택하고 필요한 경우 프로모션 코드를 입력하세요. 주문 금액과 갱신 조건을 확인한 뒤 결제로 진행할 수 있습니다.",
    billingCycle: "결제 주기",
    monthly: "월간",
    annual: "연간",
    yearly: "연간",
    annualOff: "20% 할인",
    monthlyDescription: "매월 결제됩니다.",
    annualDescription: "연간 결제로 20%를 절약하세요.",
    promoLabel: "프로모션 코드",
    promoPlaceholder: "프로모션 코드 선택 입력",
    apply: "적용",
    promoFinePrint:
      "검증된 혜택에 할인 적용 기간이 표시됩니다. 기간 종료 후에는 취소하지 않는 한 정가로 갱신됩니다.",
    invalidPromo: "유효하지 않은 프로모션 코드입니다.",
    promoApplied: "프로모션 코드가 적용되었습니다.",
    promotionCurrencyNotSupported:
      "고정 금액 프로모션 코드는 현재 USD 결제에서만 사용할 수 있습니다. 현지 통화 결제에는 정률 할인 프로모션을 사용해 주세요.",
    orderSummary: "주문 요약",
    plan: "플랜",
    billing: "결제",
    subtotal: "소계",
    annualSavings: "연간 절약",
    availableOffer: (code) => `사용 가능한 혜택: ${code}`,
    appliedAtCheckout: "결제 시 적용",
    dueToday: "오늘 결제 금액",
    localPriceNote: (amount) =>
      `표시 금액: ${amount}. 최종 결제 통화와 금액은 결제 화면에서 확인하세요.`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `연간 결제는 연 ${amount}로 매년 갱신됩니다.`
        : `월간 결제는 월 ${amount}로 매월 갱신됩니다.`,
    promotionPeriod: (months) => `${months}개월간`,
    promotionRenewalNote: (months, discounted, regular) =>
      `처음 ${months}개월은 월 ${discounted}, 이후에는 월 ${regular}로 매월 갱신됩니다.`,
    continueToCheckout: "결제 계속하기",
  },
  zh: {
    secureCheckout: "安全结账",
    upgradeTo: (plan) => `升级到 ${plan}`,
    description: "选择计费周期，有促销代码时可输入。确认总金额和续费条件后，再继续付款。",
    billingCycle: "计费周期",
    monthly: "月付",
    annual: "年付",
    yearly: "年付",
    annualOff: "八折优惠",
    monthlyDescription: "按月付款。",
    annualDescription: "选择年付可节省 20%。",
    promoLabel: "促销代码",
    promoPlaceholder: "可选促销代码",
    apply: "应用",
    promoFinePrint:
      "验证后的优惠会显示折扣期限。优惠结束后，如未取消，订阅将按正常价格续订。",
    invalidPromo: "促销代码无效。",
    promoApplied: "促销代码已应用。",
    promotionCurrencyNotSupported:
      "固定金额促销代码目前仅支持美元结账。本地货币结算请使用按比例折扣的促销代码。",
    orderSummary: "订单摘要",
    plan: "方案",
    billing: "计费",
    subtotal: "小计",
    annualSavings: "年付节省",
    availableOffer: (code) => `可用优惠：${code}`,
    appliedAtCheckout: "结账时应用",
    dueToday: "今日应付",
    localPriceNote: (amount) =>
      `结账时将收取所显示的本地固定价格 ${amount}。`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `年付方案按每年 ${amount} 自动续订。`
        : `月付方案按每月 ${amount} 自动续订。`,
    promotionPeriod: (months) => `${months} 个月`,
    promotionRenewalNote: (months, discounted, regular) =>
      `前 ${months} 个月每月 ${discounted}，之后每月 ${regular} 自动续费。`,
    continueToCheckout: "继续结账",
  },
  "zh-Hant": {
    secureCheckout: "安全結帳",
    upgradeTo: (plan) => `升級到 ${plan}`,
    description: "選擇計費週期，有促銷代碼時可以輸入。確認總金額和續約條件後，再繼續付款。",
    billingCycle: "計費週期",
    monthly: "月付",
    annual: "年付",
    yearly: "年付",
    annualOff: "八折優惠",
    monthlyDescription: "按月付款。",
    annualDescription: "選擇年付可節省 20%。",
    promoLabel: "促銷代碼",
    promoPlaceholder: "選填的促銷代碼",
    apply: "套用",
    promoFinePrint:
      "驗證後的優惠會顯示折扣期限。優惠結束後，若未取消，訂閱將依正常價格續訂。",
    invalidPromo: "促銷代碼無效。",
    promoApplied: "促銷代碼已套用。",
    promotionCurrencyNotSupported:
      "固定金額的促銷代碼目前僅支援以美元結帳。當地貨幣結算請使用依比例折扣的促銷代碼。",
    orderSummary: "訂單摘要",
    plan: "方案",
    billing: "計費",
    subtotal: "小計",
    annualSavings: "年付節省",
    availableOffer: (code) => `可用優惠：${code}`,
    appliedAtCheckout: "結帳時套用",
    dueToday: "今日應付",
    localPriceNote: (amount) =>
      `結帳時將收取所顯示的當地固定價格 ${amount}。`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `年付方案將依每年 ${amount} 自動續訂。`
        : `月付方案將依每月 ${amount} 自動續訂。`,
    promotionPeriod: (months) => `${months} 個月`,
    promotionRenewalNote: (months, discounted, regular) =>
      `前 ${months} 個月每月 ${discounted}，之後每月 ${regular} 自動續訂。`,
    continueToCheckout: "繼續結帳",
  },
  fr: {
    secureCheckout: "Paiement sécurisé",
    upgradeTo: (plan) => `Passer à ${plan}`,
    description:
      "Choisissez un cycle de facturation et saisissez un code promotionnel si vous en avez un. Vérifiez le total et les conditions de renouvellement, puis passez au paiement.",
    billingCycle: "Cycle de facturation",
    monthly: "Mensuel",
    annual: "Annuel",
    yearly: "Annuel",
    annualOff: "-20 %",
    monthlyDescription: "Payez mois par mois.",
    annualDescription: "Économisez 20 % avec la facturation annuelle.",
    promoLabel: "Code promotionnel",
    promoPlaceholder: "Code promotionnel facultatif",
    apply: "Appliquer",
    promoFinePrint:
      "L'offre validée indique la durée de la remise. Ensuite, l'abonnement est renouvelé au tarif normal sauf résiliation.",
    invalidPromo: "Code promotionnel invalide.",
    promoApplied: "Code promotionnel appliqué.",
    promotionCurrencyNotSupported:
      "Les codes promotionnels à montant fixe ne fonctionnent actuellement qu\u2019avec un paiement en USD. Utilisez un code en pourcentage pour la facturation en devise locale.",
    orderSummary: "Résumé de commande",
    plan: "Offre",
    billing: "Facturation",
    subtotal: "Sous-total",
    annualSavings: "Économie annuelle",
    availableOffer: (code) => `Offre disponible : ${code}`,
    appliedAtCheckout: "Appliqué au paiement",
    dueToday: "À payer aujourd'hui",
    localPriceNote: (amount) =>
      `Le paiement est facturé au prix local fixe affiché : ${amount}.`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `Le paiement annuel est renouvelé à ${amount} par an.`
        : `Le paiement mensuel est renouvelé à ${amount} par mois.`,
    promotionPeriod: (months) => `pendant ${months} mois`,
    promotionRenewalNote: (months, discounted, regular) =>
      `${discounted}/mois ${months === 1 ? "le premier mois" : `les ${months} premiers mois`}, puis ${regular}/mois jusqu’à résiliation.`,
    continueToCheckout: "Continuer vers le paiement",
  },
  de: {
    secureCheckout: "Sichere Zahlung",
    upgradeTo: (plan) => `Upgrade auf ${plan}`,
    description:
      "Wählen Sie einen Abrechnungszeitraum und geben Sie bei Bedarf einen Aktionscode ein. Prüfen Sie Gesamtbetrag und Verlängerungsbedingungen und fahren Sie dann zur Zahlung fort.",
    billingCycle: "Abrechnungszeitraum",
    monthly: "Monatlich",
    annual: "Jährlich",
    yearly: "Jährlich",
    annualOff: "20 % Rabatt",
    monthlyDescription: "Monatlich zahlen.",
    annualDescription: "Sparen Sie 20 % mit jährlicher Abrechnung.",
    promoLabel: "Aktionscode",
    promoPlaceholder: "Optionaler Aktionscode",
    apply: "Anwenden",
    promoFinePrint:
      "Das geprüfte Angebot zeigt die Rabattdauer. Danach verlängert sich das Abo zum regulären Preis, sofern es nicht gekündigt wird.",
    invalidPromo: "Ungültiger Aktionscode.",
    promoApplied: "Aktionscode angewendet.",
    promotionCurrencyNotSupported:
      "Aktionscodes mit festem Betrag funktionieren derzeit nur bei Zahlung in USD. Verwenden Sie für die Abrechnung in Landeswährung einen Prozentcode.",
    orderSummary: "Bestellübersicht",
    plan: "Plan",
    billing: "Abrechnung",
    subtotal: "Zwischensumme",
    annualSavings: "Jährliche Ersparnis",
    availableOffer: (code) => `Verfügbares Angebot: ${code}`,
    appliedAtCheckout: "Beim Checkout angewendet",
    dueToday: "Heute fällig",
    localPriceNote: (amount) =>
      `Beim Checkout wird der angezeigte lokale Festpreis von ${amount} berechnet.`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `Der Jahresplan verlängert sich zu ${amount} pro Jahr.`
        : `Der Monatsplan verlängert sich zu ${amount} pro Monat.`,
    promotionPeriod: (months) => (months === 1 ? "für 1 Monat" : `für ${months} Monate`),
    promotionRenewalNote: (months, discounted, regular) =>
      `${discounted}/Monat ${months === 1 ? "im ersten Monat" : `in den ersten ${months} Monaten`}, danach ${regular}/Monat bis zur Kündigung.`,
    continueToCheckout: "Weiter zum Checkout",
  },
  es: {
    secureCheckout: "Pago seguro",
    upgradeTo: (plan) => `Actualizar a ${plan}`,
    description:
      "Elige un ciclo de facturación e introduce un código promocional si tienes uno. Revisa el total y las condiciones de renovación antes de continuar al pago.",
    billingCycle: "Ciclo de facturación",
    monthly: "Mensual",
    annual: "Anual",
    yearly: "Anual",
    annualOff: "20 % desc.",
    monthlyDescription: "Paga mes a mes.",
    annualDescription: "Ahorra un 20 % con la facturación anual.",
    promoLabel: "Código promocional",
    promoPlaceholder: "Código promocional opcional",
    apply: "Aplicar",
    promoFinePrint:
      "La oferta validada muestra la duración del descuento. Después, la suscripción se renueva al precio normal salvo cancelación.",
    invalidPromo: "Código promocional no válido.",
    promoApplied: "Código promocional aplicado.",
    promotionCurrencyNotSupported:
      "Los códigos promocionales de importe fijo solo funcionan por ahora con pagos en USD. Usa un código de porcentaje para la facturación en moneda local.",
    orderSummary: "Resumen del pedido",
    plan: "Plan",
    billing: "Facturación",
    subtotal: "Subtotal",
    annualSavings: "Ahorro anual",
    availableOffer: (code) => `Oferta disponible: ${code}`,
    appliedAtCheckout: "Aplicado al pagar",
    dueToday: "A pagar hoy",
    localPriceNote: (amount) =>
      `Se cobra el precio local fijo mostrado: ${amount}.`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `El pago anual se renueva a ${amount} al año.`
        : `El pago mensual se renueva a ${amount} al mes.`,
    promotionPeriod: (months) => (months === 1 ? "durante 1 mes" : `durante ${months} meses`),
    promotionRenewalNote: (months, discounted, regular) =>
      `${discounted}/mes ${months === 1 ? "el primer mes" : `los primeros ${months} meses`} y después ${regular}/mes hasta que canceles.`,
    continueToCheckout: "Continuar al pago",
  },
  pt: {
    secureCheckout: "Checkout seguro",
    upgradeTo: (plan) => `Fazer upgrade para ${plan}`,
    description:
      "Escolha um ciclo de cobrança e insira um código promocional, se tiver. Confira o total e as condições de renovação antes de continuar para o pagamento.",
    billingCycle: "Ciclo de cobrança",
    monthly: "Mensal",
    annual: "Anual",
    yearly: "Anual",
    annualOff: "20% de desconto",
    monthlyDescription: "Pague mês a mês.",
    annualDescription: "Economize 20% com a cobrança anual.",
    promoLabel: "Código promocional",
    promoPlaceholder: "Código promocional opcional",
    apply: "Aplicar",
    promoFinePrint:
      "A oferta validada mostra a duração do desconto. Depois, a assinatura renova pelo preço normal, salvo cancelamento.",
    invalidPromo: "Código promocional inválido.",
    promoApplied: "Código promocional aplicado.",
    promotionCurrencyNotSupported:
      "Códigos promocionais de valor fixo funcionam apenas com pagamento em USD por enquanto. Use um código percentual para cobrança em moeda local.",
    orderSummary: "Resumo do pedido",
    plan: "Plano",
    billing: "Cobrança",
    subtotal: "Subtotal",
    annualSavings: "Economia anual",
    availableOffer: (code) => `Oferta disponível: ${code}`,
    appliedAtCheckout: "Aplicado no checkout",
    dueToday: "Valor hoje",
    localPriceNote: (amount) =>
      `O preço local fixo exibido é cobrado no checkout: ${amount}.`,
    renewalNote: (interval, amount) =>
      interval === "annual"
        ? `O plano anual renova por ${amount} ao ano.`
        : `O plano mensal renova por ${amount} ao mês.`,
    promotionPeriod: (months) => (months === 1 ? "durante 1 mês" : `durante ${months} meses`),
    promotionRenewalNote: (months, discounted, regular) =>
      `${discounted}/mês ${months === 1 ? "no primeiro mês" : `nos primeiros ${months} meses`} e depois ${regular}/mês até cancelar.`,
    continueToCheckout: "Continuar para o checkout",
  },
};

export const promotionPolicyCopy: Record<Language, string> = {
  en: "Promotions do not normally combine with the annual-plan discount. They can be combined only when the offer details for your code explicitly allow it.",
  ko: "연간 플랜 할인과는 원칙적으로 중복 적용되지 않습니다. 입력한 코드의 혜택 안내에서 중복 적용이 명시적으로 허용된 경우만 함께 사용할 수 있습니다.",
  zh: "促销优惠通常不可与年付折扣叠加。仅当该代码的优惠说明明确允许时，才可同时使用。",
  "zh-Hant": "促銷優惠通常不可與年付折扣疊加。僅當該代碼的優惠說明明確允許時，才可同時使用。",
  fr: "Les promotions ne se cumulent normalement pas avec la remise annuelle. Le cumul est possible uniquement si les conditions du code l’autorisent explicitement.",
  de: "Aktionen sind grundsätzlich nicht mit dem Jahresrabatt kombinierbar. Eine Kombination ist nur möglich, wenn die Angebotsdetails Ihres Codes sie ausdrücklich erlauben.",
  es: "Las promociones no se combinan normalmente con el descuento anual. Solo se pueden combinar si los detalles del código lo permiten expresamente.",
  pt: "As promoções normalmente não acumulam com o desconto anual. A combinação só é possível quando os detalhes do código permitem isso expressamente.",
};

export type CheckoutLegalCopy = {
  prefix: string;
  terms: string;
  conjunction: string;
  refund: string;
  suffix: string;
};

export const checkoutLegalCopy: Record<Language, CheckoutLegalCopy> = {
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
  "zh-Hant": {
    prefix: "繼續即表示你同意",
    terms: "條款與條件",
    conjunction: "並確認",
    refund: "退款政策",
    suffix: "，包括自動續訂，以及在已付費週期結束時取消的條件。",
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

/**
 * Whether this promotion can be shown as a discount against this currency.
 *
 * The same rule the server decides with, restated for the summary. It is not
 * the authority -- validation refuses these codes before they are ever applied
 * -- but the summary must not be able to quote a discount even if one reaches
 * this state some other way: a stale promotion left over from a currency
 * change, a response that arrived after the market moved.
 *
 * A percentage applies to whatever the local price is. A fixed amount is stored
 * in USD cents and means nothing against another currency.
 */
export const promotionAppliesToCurrency = (
  promotion: BillingPromotion | null | undefined,
  currency: BillingCurrency
) => {
  if (!promotion) return false;
  if (promotion.fulfillmentType === "internal_pass") return true;
  if (promotion.discountPercent > 0) return true;
  if (!promotion.discountAmountCents) return false;
  return currency === "USD";
};

/**
 * The local amount left to charge.
 *
 * This used to convert a USD fixed discount into a ratio of the USD price and
 * apply that ratio to the local one: $14 off a $15 plan became 93.3% off, and
 * A$20.00 was displayed as A$1.33 due today. No such AUD discount was ever
 * approved -- not in the database, not in Stripe -- and Checkout refused the
 * purchase a click later. A discount that cannot be charged is not shown.
 */
export const calculateDiscountedDisplayMinor = (
  amountMinor: number,
  promotion: BillingPromotion | null | undefined,
  currency: BillingCurrency
) => {
  if (!promotionAppliesToCurrency(promotion, currency)) return amountMinor;
  if (promotion!.discountPercent > 0) {
    return Math.max(
      0,
      Math.round(amountMinor * (1 - promotion!.discountPercent / 100))
    );
  }
  // USD only, guarded above: the stored amount is USD cents and `amountMinor`
  // is the same unit, so it is an exact subtraction rather than a conversion.
  return Math.max(0, amountMinor - (promotion!.discountAmountCents || 0));
};

export const creditPackCopy: Record<Language, { title: string; body: string; notice: string; buy: string; close: string; loading: string; expiry: string; error: string; selected: string }> = {
  en: { title: "Buy additional credits", body: "One-time credits for extra work this month.", notice: "Purchased credits remain usable after the plan’s daily credit guardrail is reached. They do not change model access, plan features, rate or concurrency limits, provider budgets, or fair-use safeguards.", buy: "Buy", close: "Close", loading: "Loading…", expiry: "Valid for {days} days", error: "Credit packs could not be loaded.", selected: "Selected" },
  ko: { title: "추가 크레딧 구매", body: "이번 달에만 작업량이 많을 때 사용하는 일회성 크레딧입니다.", notice: "구매 크레딧은 플랜의 일일 크레딧 가드레일을 넘어 사용할 수 있습니다. 모델 접근 권한, 플랜 기능, 분당·동시 요청 제한, 공급자 예산 및 공정사용 안전장치는 변경되지 않습니다.", buy: "구매", close: "닫기", loading: "불러오는 중…", expiry: "{days}일 유효", error: "크레딧 팩을 불러오지 못했습니다.", selected: "선택됨" },
  zh: { title: "购买额外积分", body: "用于本月额外工作的单次积分。", notice: "达到套餐每日积分保护额度后，已购买积分仍可使用。模型权限、套餐功能、请求频率与并发限制、供应商预算及公平使用保护不会改变。", buy: "购买", close: "关闭", loading: "加载中…", expiry: "有效期 {days} 天", error: "无法加载积分包。", selected: "已选择" },
  "zh-Hant": { title: "購買額外點數", body: "用於本月額外工作的單次點數。", notice: "達到方案每日點數保護額度後，已購買的點數仍可使用。模型權限、方案功能、請求頻率與並行限制、供應商預算及公平使用保護不會改變。", buy: "購買", close: "關閉", loading: "載入中…", expiry: "有效期 {days} 天", error: "無法載入點數包。", selected: "已選取" },
  fr: { title: "Acheter des crédits supplémentaires", body: "Crédits ponctuels pour un besoin supplémentaire ce mois-ci.", notice: "Les crédits achetés restent utilisables après la limite quotidienne du forfait. Ils ne modifient ni l’accès aux modèles, ni les fonctions, ni les limites de fréquence et de concurrence, ni les budgets fournisseur ou les protections d’usage équitable.", buy: "Acheter", close: "Fermer", loading: "Chargement…", expiry: "Valable {days} jours", error: "Impossible de charger les packs.", selected: "Sélectionné" },
  de: { title: "Zusätzliche Credits kaufen", body: "Einmalige Credits für zusätzlichen Bedarf in diesem Monat.", notice: "Gekaufte Credits bleiben nach Erreichen des täglichen Planlimits nutzbar. Modellzugriff, Planfunktionen, Raten- und Parallelitätslimits, Anbieterbudgets und Fair-Use-Schutz bleiben unverändert.", buy: "Kaufen", close: "Schließen", loading: "Laden…", expiry: "{days} Tage gültig", error: "Credit-Pakete konnten nicht geladen werden.", selected: "Ausgewählt" },
  es: { title: "Comprar créditos adicionales", body: "Créditos de un solo pago para trabajo adicional este mes.", notice: "Los créditos comprados siguen disponibles después del límite diario del plan. No cambian el acceso a modelos, las funciones, los límites de frecuencia o concurrencia, los presupuestos de proveedores ni las protecciones de uso justo.", buy: "Comprar", close: "Cerrar", loading: "Cargando…", expiry: "Válido {days} días", error: "No se pudieron cargar los paquetes.", selected: "Seleccionado" },
  pt: { title: "Comprar créditos adicionais", body: "Créditos avulsos para trabalho extra neste mês.", notice: "Créditos comprados continuam disponíveis após o limite diário do plano. Eles não alteram acesso a modelos, recursos, limites de taxa ou simultaneidade, orçamentos de provedores nem proteções de uso justo.", buy: "Comprar", close: "Fechar", loading: "Carregando…", expiry: "Válido por {days} dias", error: "Não foi possível carregar os pacotes.", selected: "Selecionado" },
};

export const creditUnit: Record<Language, string> = {
  en: "credits",
  ko: "크레딧",
  zh: "积分",
  "zh-Hant": "點數",
  fr: "crédits",
  de: "Credits",
  es: "créditos",
  pt: "créditos",
};

import type { Language } from "@/components/LanguageProvider";
import type { BillingErrorCode } from "@/lib/purchaseIntent";

/**
 * Customer-facing copy for the purchase funnel, in one place.
 *
 * The pricing page and the credit-pack modal are two surfaces of a single
 * flow, and they used to disagree about it: the pricing page told everyone to
 * "Sign in to buy credits" while the modal already knew who they were. Sharing
 * the strings is what keeps the two halves of one sentence from drifting.
 *
 * Server error text is never shown as-is. Each failure maps to a code, and each
 * code has a message that says what the visitor can do next -- retry, sign in
 * again, or contact support -- because "Credit packs could not be loaded"
 * covered all three and helped with none of them.
 */

export type PurchaseCtaCopy = {
  /** Shown while the session is still resolving. Neutral on purpose. */
  ctaLoading: string;
  /** Accessible status announced with the neutral CTA. */
  ctaLoadingStatus: string;
  signInToBuyCredits: string;
  buyCredits: string;
  buyThisPack: string;
  currentPlan: string;
  upgradeTo: (plan: string) => string;
  signInAndStart: (plan: string) => string;
  managePlan: string;
  managePlanHint: string;
  startFree: string;
  retry: string;
  signInAgain: string;
  contactSupport: string;
  purchaseSuccessTitle: string;
  purchaseSuccessBody: (pack: string) => string;
  purchaseCancelledTitle: string;
  purchaseCancelledBody: (pack: string) => string;
  dismiss: string;
};

export const purchaseCtaCopy: Record<Language, PurchaseCtaCopy> = {
  en: {
    ctaLoading: "Checking your account…",
    ctaLoadingStatus: "Checking your sign-in status before showing purchase options.",
    signInToBuyCredits: "Sign in to buy credits",
    buyCredits: "Buy additional credits",
    buyThisPack: "Buy this pack",
    currentPlan: "Current plan",
    upgradeTo: (plan) => `Upgrade to ${plan}`,
    signInAndStart: (plan) => `Sign in to start ${plan}`,
    managePlan: "Manage plan",
    managePlanHint:
      "Plan changes for an active subscription are handled in account settings.",
    startFree: "Start free",
    retry: "Try again",
    signInAgain: "Sign in again",
    contactSupport: "Contact support",
    purchaseSuccessTitle: "Credits added",
    purchaseSuccessBody: (pack) =>
      `${pack} was purchased. The credits are available in your account now.`,
    purchaseCancelledTitle: "Purchase cancelled",
    purchaseCancelledBody: (pack) =>
      `${pack} was not purchased and you were not charged. You can start again below.`,
    dismiss: "Dismiss",
  },
  ko: {
    ctaLoading: "계정 확인 중…",
    ctaLoadingStatus: "구매 옵션을 표시하기 전에 로그인 상태를 확인하고 있습니다.",
    signInToBuyCredits: "로그인하고 크레딧 구매",
    buyCredits: "추가 크레딧 구매",
    buyThisPack: "이 팩 구매",
    currentPlan: "현재 플랜",
    upgradeTo: (plan) => `${plan}로 업그레이드`,
    signInAndStart: (plan) => `로그인하고 ${plan} 시작`,
    managePlan: "플랜 관리",
    managePlanHint:
      "이용 중인 구독의 플랜 변경은 계정 설정에서 진행합니다.",
    startFree: "무료로 시작",
    retry: "다시 시도",
    signInAgain: "다시 로그인",
    contactSupport: "고객지원 문의",
    purchaseSuccessTitle: "크레딧이 추가되었습니다",
    purchaseSuccessBody: (pack) =>
      `${pack} 구매가 완료되었습니다. 크레딧은 지금 바로 사용할 수 있습니다.`,
    purchaseCancelledTitle: "구매가 취소되었습니다",
    purchaseCancelledBody: (pack) =>
      `${pack} 구매가 완료되지 않았으며 결제도 진행되지 않았습니다. 아래에서 다시 시작할 수 있습니다.`,
    dismiss: "닫기",
  },
  zh: {
    ctaLoading: "正在确认账户…",
    ctaLoadingStatus: "正在确认登录状态，然后显示购买选项。",
    signInToBuyCredits: "登录后购买积分",
    buyCredits: "购买额外积分",
    buyThisPack: "购买此积分包",
    currentPlan: "当前方案",
    upgradeTo: (plan) => `升级到 ${plan}`,
    signInAndStart: (plan) => `登录后开通 ${plan}`,
    managePlan: "管理方案",
    managePlanHint: "有效订阅的方案变更请在账户设置中进行。",
    startFree: "免费开始",
    retry: "重试",
    signInAgain: "重新登录",
    contactSupport: "联系支持",
    purchaseSuccessTitle: "积分已到账",
    purchaseSuccessBody: (pack) => `${pack} 已购买成功，积分现在即可使用。`,
    purchaseCancelledTitle: "购买已取消",
    purchaseCancelledBody: (pack) =>
      `${pack} 未完成购买，也未产生扣款。你可以在下方重新开始。`,
    dismiss: "关闭",
  },
  fr: {
    ctaLoading: "Vérification du compte…",
    ctaLoadingStatus:
      "Vérification de votre connexion avant d'afficher les options d'achat.",
    signInToBuyCredits: "Se connecter pour acheter",
    buyCredits: "Acheter des crédits supplémentaires",
    buyThisPack: "Acheter ce pack",
    currentPlan: "Formule actuelle",
    upgradeTo: (plan) => `Passer à ${plan}`,
    signInAndStart: (plan) => `Se connecter pour démarrer ${plan}`,
    managePlan: "Gérer la formule",
    managePlanHint:
      "Les changements de formule d'un abonnement actif se font dans les paramètres du compte.",
    startFree: "Commencer gratuitement",
    retry: "Réessayer",
    signInAgain: "Se reconnecter",
    contactSupport: "Contacter le support",
    purchaseSuccessTitle: "Crédits ajoutés",
    purchaseSuccessBody: (pack) =>
      `${pack} a été acheté. Les crédits sont disponibles dès maintenant.`,
    purchaseCancelledTitle: "Achat annulé",
    purchaseCancelledBody: (pack) =>
      `${pack} n'a pas été acheté et aucun montant n'a été prélevé. Vous pouvez recommencer ci-dessous.`,
    dismiss: "Fermer",
  },
  de: {
    ctaLoading: "Konto wird geprüft…",
    ctaLoadingStatus:
      "Anmeldestatus wird geprüft, bevor Kaufoptionen angezeigt werden.",
    signInToBuyCredits: "Anmelden und Credits kaufen",
    buyCredits: "Zusätzliche Credits kaufen",
    buyThisPack: "Dieses Paket kaufen",
    currentPlan: "Aktueller Tarif",
    upgradeTo: (plan) => `Auf ${plan} upgraden`,
    signInAndStart: (plan) => `Anmelden und ${plan} starten`,
    managePlan: "Tarif verwalten",
    managePlanHint:
      "Tarifwechsel bei einem aktiven Abo erfolgen in den Kontoeinstellungen.",
    startFree: "Kostenlos starten",
    retry: "Erneut versuchen",
    signInAgain: "Erneut anmelden",
    contactSupport: "Support kontaktieren",
    purchaseSuccessTitle: "Credits gutgeschrieben",
    purchaseSuccessBody: (pack) =>
      `${pack} wurde gekauft. Die Credits stehen ab sofort zur Verfügung.`,
    purchaseCancelledTitle: "Kauf abgebrochen",
    purchaseCancelledBody: (pack) =>
      `${pack} wurde nicht gekauft und es wurde nichts belastet. Unten kann der Kauf neu gestartet werden.`,
    dismiss: "Schließen",
  },
  es: {
    ctaLoading: "Comprobando la cuenta…",
    ctaLoadingStatus:
      "Comprobando tu sesión antes de mostrar las opciones de compra.",
    signInToBuyCredits: "Inicia sesión para comprar",
    buyCredits: "Comprar créditos adicionales",
    buyThisPack: "Comprar este paquete",
    currentPlan: "Plan actual",
    upgradeTo: (plan) => `Actualizar a ${plan}`,
    signInAndStart: (plan) => `Inicia sesión para empezar con ${plan}`,
    managePlan: "Gestionar plan",
    managePlanHint:
      "Los cambios de plan de una suscripción activa se hacen en los ajustes de la cuenta.",
    startFree: "Empezar gratis",
    retry: "Reintentar",
    signInAgain: "Inicia sesión de nuevo",
    contactSupport: "Contactar con soporte",
    purchaseSuccessTitle: "Créditos añadidos",
    purchaseSuccessBody: (pack) =>
      `${pack} se ha comprado. Los créditos ya están disponibles en tu cuenta.`,
    purchaseCancelledTitle: "Compra cancelada",
    purchaseCancelledBody: (pack) =>
      `${pack} no se compró y no se realizó ningún cargo. Puedes empezar de nuevo abajo.`,
    dismiss: "Cerrar",
  },
  pt: {
    ctaLoading: "Verificando a conta…",
    ctaLoadingStatus:
      "Verificando seu login antes de mostrar as opções de compra.",
    signInToBuyCredits: "Entrar para comprar créditos",
    buyCredits: "Comprar créditos adicionais",
    buyThisPack: "Comprar este pacote",
    currentPlan: "Plano atual",
    upgradeTo: (plan) => `Fazer upgrade para ${plan}`,
    signInAndStart: (plan) => `Entrar para começar no ${plan}`,
    managePlan: "Gerenciar plano",
    managePlanHint:
      "Mudanças de plano em uma assinatura ativa são feitas nas configurações da conta.",
    startFree: "Começar grátis",
    retry: "Tentar de novo",
    signInAgain: "Entrar novamente",
    contactSupport: "Falar com o suporte",
    purchaseSuccessTitle: "Créditos adicionados",
    purchaseSuccessBody: (pack) =>
      `${pack} foi comprado. Os créditos já estão disponíveis na sua conta.`,
    purchaseCancelledTitle: "Compra cancelada",
    purchaseCancelledBody: (pack) =>
      `${pack} não foi comprado e nada foi cobrado. Você pode recomeçar abaixo.`,
    dismiss: "Fechar",
  },
};

const billingErrorMessages: Record<
  Language,
  Record<BillingErrorCode, string>
> = {
  en: {
    AUTHENTICATION_REQUIRED: "Sign in to continue this purchase.",
    SESSION_EXPIRED:
      "Your session has expired. Sign in again to continue this purchase.",
    PACK_NOT_AVAILABLE_FOR_PLAN:
      "This credit pack is not available on your current plan. Choose another pack.",
    CHECKOUT_CONFIGURATION_ERROR:
      "Checkout is temporarily unavailable. Nothing was charged. Please contact support if this continues.",
    BILLING_MARKET_MISMATCH:
      "The billing currency for your region could not be confirmed. Reload the page and try again.",
    ACTIVE_SUBSCRIPTION_EXISTS:
      "This account already has an active subscription. Manage your plan in account settings.",
    PLAN_CHANGE_NOT_SUPPORTED:
      "This plan change is handled in account settings, not at checkout.",
    CHECKOUT_RATE_LIMITED:
      "Too many purchase attempts. Wait a moment and try again.",
    NETWORK_ERROR: "The network request failed. Check your connection and try again.",
    UNKNOWN_ERROR: "The purchase could not be started. Please try again.",
  },
  ko: {
    AUTHENTICATION_REQUIRED: "구매를 계속하려면 로그인하세요.",
    SESSION_EXPIRED:
      "세션이 만료되었습니다. 다시 로그인하면 구매를 계속할 수 있습니다.",
    PACK_NOT_AVAILABLE_FOR_PLAN:
      "현재 플랜에서는 구매할 수 없는 크레딧 팩입니다. 다른 팩을 선택하세요.",
    CHECKOUT_CONFIGURATION_ERROR:
      "결제를 일시적으로 시작할 수 없습니다. 결제된 금액은 없습니다. 문제가 계속되면 고객지원에 문의하세요.",
    BILLING_MARKET_MISMATCH:
      "지역별 결제 통화를 확인하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도하세요.",
    ACTIVE_SUBSCRIPTION_EXISTS:
      "이미 이용 중인 구독이 있습니다. 계정 설정에서 플랜을 관리하세요.",
    PLAN_CHANGE_NOT_SUPPORTED:
      "이 플랜 변경은 결제가 아니라 계정 설정에서 진행합니다.",
    CHECKOUT_RATE_LIMITED:
      "구매 시도가 너무 많습니다. 잠시 후 다시 시도하세요.",
    NETWORK_ERROR: "네트워크 요청이 실패했습니다. 연결을 확인한 뒤 다시 시도하세요.",
    UNKNOWN_ERROR: "구매를 시작하지 못했습니다. 다시 시도해 주세요.",
  },
  zh: {
    AUTHENTICATION_REQUIRED: "请登录后继续购买。",
    SESSION_EXPIRED: "登录状态已过期。重新登录后即可继续购买。",
    PACK_NOT_AVAILABLE_FOR_PLAN: "当前方案无法购买该积分包，请选择其他积分包。",
    CHECKOUT_CONFIGURATION_ERROR:
      "结账暂时不可用，未产生任何扣款。若问题持续，请联系支持。",
    BILLING_MARKET_MISMATCH: "未能确认你所在地区的结算货币。请刷新页面后重试。",
    ACTIVE_SUBSCRIPTION_EXISTS: "该账户已有有效订阅，请在账户设置中管理方案。",
    PLAN_CHANGE_NOT_SUPPORTED: "此方案变更请在账户设置中进行，而不是在结账页。",
    CHECKOUT_RATE_LIMITED: "购买尝试过于频繁，请稍后再试。",
    NETWORK_ERROR: "网络请求失败。请检查网络连接后重试。",
    UNKNOWN_ERROR: "无法开始购买，请重试。",
  },
  fr: {
    AUTHENTICATION_REQUIRED: "Connectez-vous pour poursuivre cet achat.",
    SESSION_EXPIRED:
      "Votre session a expiré. Reconnectez-vous pour poursuivre cet achat.",
    PACK_NOT_AVAILABLE_FOR_PLAN:
      "Ce pack n'est pas disponible avec votre formule actuelle. Choisissez-en un autre.",
    CHECKOUT_CONFIGURATION_ERROR:
      "Le paiement est momentanément indisponible. Rien n'a été débité. Contactez le support si cela persiste.",
    BILLING_MARKET_MISMATCH:
      "La devise de facturation de votre région n'a pas pu être confirmée. Rechargez la page et réessayez.",
    ACTIVE_SUBSCRIPTION_EXISTS:
      "Ce compte possède déjà un abonnement actif. Gérez votre formule dans les paramètres du compte.",
    PLAN_CHANGE_NOT_SUPPORTED:
      "Ce changement de formule se fait dans les paramètres du compte, pas au paiement.",
    CHECKOUT_RATE_LIMITED: "Trop de tentatives d'achat. Patientez et réessayez.",
    NETWORK_ERROR:
      "La requête réseau a échoué. Vérifiez votre connexion et réessayez.",
    UNKNOWN_ERROR: "L'achat n'a pas pu démarrer. Veuillez réessayer.",
  },
  de: {
    AUTHENTICATION_REQUIRED: "Melde dich an, um den Kauf fortzusetzen.",
    SESSION_EXPIRED:
      "Deine Sitzung ist abgelaufen. Melde dich erneut an, um den Kauf fortzusetzen.",
    PACK_NOT_AVAILABLE_FOR_PLAN:
      "Dieses Credit-Paket ist in deinem aktuellen Tarif nicht verfügbar. Wähle ein anderes Paket.",
    CHECKOUT_CONFIGURATION_ERROR:
      "Der Checkout ist vorübergehend nicht verfügbar. Es wurde nichts belastet. Kontaktiere den Support, falls das anhält.",
    BILLING_MARKET_MISMATCH:
      "Die Abrechnungswährung für deine Region konnte nicht bestätigt werden. Lade die Seite neu und versuche es erneut.",
    ACTIVE_SUBSCRIPTION_EXISTS:
      "Dieses Konto hat bereits ein aktives Abo. Verwalte deinen Tarif in den Kontoeinstellungen.",
    PLAN_CHANGE_NOT_SUPPORTED:
      "Dieser Tarifwechsel erfolgt in den Kontoeinstellungen, nicht im Checkout.",
    CHECKOUT_RATE_LIMITED:
      "Zu viele Kaufversuche. Warte einen Moment und versuche es erneut.",
    NETWORK_ERROR:
      "Die Netzwerkanfrage ist fehlgeschlagen. Prüfe deine Verbindung und versuche es erneut.",
    UNKNOWN_ERROR: "Der Kauf konnte nicht gestartet werden. Bitte erneut versuchen.",
  },
  es: {
    AUTHENTICATION_REQUIRED: "Inicia sesión para continuar con esta compra.",
    SESSION_EXPIRED:
      "Tu sesión ha caducado. Inicia sesión de nuevo para continuar con esta compra.",
    PACK_NOT_AVAILABLE_FOR_PLAN:
      "Este paquete no está disponible en tu plan actual. Elige otro paquete.",
    CHECKOUT_CONFIGURATION_ERROR:
      "El pago no está disponible temporalmente. No se ha realizado ningún cargo. Contacta con soporte si continúa.",
    BILLING_MARKET_MISMATCH:
      "No se ha podido confirmar la moneda de facturación de tu región. Recarga la página e inténtalo de nuevo.",
    ACTIVE_SUBSCRIPTION_EXISTS:
      "Esta cuenta ya tiene una suscripción activa. Gestiona tu plan en los ajustes de la cuenta.",
    PLAN_CHANGE_NOT_SUPPORTED:
      "Este cambio de plan se hace en los ajustes de la cuenta, no en el pago.",
    CHECKOUT_RATE_LIMITED:
      "Demasiados intentos de compra. Espera un momento e inténtalo de nuevo.",
    NETWORK_ERROR:
      "La solicitud de red ha fallado. Comprueba tu conexión e inténtalo de nuevo.",
    UNKNOWN_ERROR: "No se ha podido iniciar la compra. Inténtalo de nuevo.",
  },
  pt: {
    AUTHENTICATION_REQUIRED: "Entre para continuar esta compra.",
    SESSION_EXPIRED:
      "Sua sessão expirou. Entre novamente para continuar esta compra.",
    PACK_NOT_AVAILABLE_FOR_PLAN:
      "Este pacote não está disponível no seu plano atual. Escolha outro pacote.",
    CHECKOUT_CONFIGURATION_ERROR:
      "O checkout está temporariamente indisponível. Nada foi cobrado. Fale com o suporte se continuar.",
    BILLING_MARKET_MISMATCH:
      "Não foi possível confirmar a moeda de cobrança da sua região. Recarregue a página e tente de novo.",
    ACTIVE_SUBSCRIPTION_EXISTS:
      "Esta conta já tem uma assinatura ativa. Gerencie seu plano nas configurações da conta.",
    PLAN_CHANGE_NOT_SUPPORTED:
      "Esta mudança de plano é feita nas configurações da conta, não no checkout.",
    CHECKOUT_RATE_LIMITED:
      "Muitas tentativas de compra. Aguarde um momento e tente de novo.",
    NETWORK_ERROR:
      "A requisição de rede falhou. Verifique sua conexão e tente de novo.",
    UNKNOWN_ERROR: "Não foi possível iniciar a compra. Tente novamente.",
  },
};

export const billingErrorMessage = (
  code: BillingErrorCode,
  lang: Language
): string =>
  (billingErrorMessages[lang] || billingErrorMessages.en)[code] ||
  billingErrorMessages.en.UNKNOWN_ERROR;

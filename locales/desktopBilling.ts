import type { Language } from "../lib/language";

/**
 * Desktop-only strings for the in-app plan and payment screens. Everything the
 * web already says (prices, renewal and refund notices, plan change, refusals)
 * comes from the web's own dictionaries; these cover only the separate checkout
 * window and the account check that follows it.
 */
export type DesktopBillingCopy = {
  windowTitle: string;
  windowOpen: string;
  windowHost: string;
  windowLoading: string;
  windowFailed: string;
  closeWindow: string;
  verifying: string;
  planConfirmed: string;
  notConfirmed: string;
  checkAgain: string;
  leftCheckout: string;
  urlRejected: string;
  windowBusy: string;
  plansTitle: string;
  pricePerMonth: string;
  pricePerYear: string;
  monthlyCredits: string;
  balancesTitle: string;
  purchasedExpiry: string;
  cancelConfirm: string;
  back: string;
};

const copy: Record<Language, DesktopBillingCopy> = {
  en: {
    windowTitle: "Tomverse checkout",
    windowOpen: "Checkout is open in a separate window.",
    windowHost: "Page on screen: {host}",
    windowLoading: "Loading the payment page…",
    windowFailed: "The payment page did not load. Close the window and try again.",
    closeWindow: "Close checkout window",
    verifying: "Checking your account with Tomverse…",
    planConfirmed: "{plan} is now active on your account.",
    notConfirmed: "Tomverse has not recorded this payment yet. If you finished paying, check again in a moment.",
    checkAgain: "Check again",
    leftCheckout: "You left checkout before paying. Your account has not changed.",
    urlRejected: "The payment page address could not be verified, so it was not opened.",
    windowBusy: "Finish or close the checkout window that is already open.",
    plansTitle: "Plans",
    pricePerMonth: "{amount} / month",
    pricePerYear: "{amount} / year",
    monthlyCredits: "{credits} credits a month",
    balancesTitle: "Credits",
    purchasedExpiry: "Earliest expiry {date}",
    cancelConfirm: "Click again to schedule the cancellation.",
    back: "Back",
  },
  ko: {
    windowTitle: "Tomverse 결제",
    windowOpen: "결제가 별도 창에서 열려 있습니다.",
    windowHost: "현재 페이지: {host}",
    windowLoading: "결제 페이지를 불러오는 중…",
    windowFailed: "결제 페이지를 불러오지 못했습니다. 창을 닫고 다시 시도해 주세요.",
    closeWindow: "결제 창 닫기",
    verifying: "Tomverse에서 계정을 확인하는 중…",
    planConfirmed: "{plan} 플랜이 계정에 적용되었습니다.",
    notConfirmed: "아직 Tomverse에 결제가 기록되지 않았습니다. 결제를 마쳤다면 잠시 후 다시 확인해 주세요.",
    checkAgain: "다시 확인",
    leftCheckout: "결제를 마치기 전에 결제 창을 나왔습니다. 계정에는 변경이 없습니다.",
    urlRejected: "결제 페이지 주소를 확인할 수 없어 열지 않았습니다.",
    windowBusy: "이미 열려 있는 결제 창을 먼저 마치거나 닫아 주세요.",
    plansTitle: "플랜",
    pricePerMonth: "월 {amount}",
    pricePerYear: "연 {amount}",
    monthlyCredits: "월 {credits} 크레딧",
    balancesTitle: "크레딧",
    purchasedExpiry: "가장 빠른 만료 {date}",
    cancelConfirm: "한 번 더 누르면 해지가 예약됩니다.",
    back: "뒤로",
  },
  zh: {
    windowTitle: "Tomverse 结账",
    windowOpen: "结账页面已在单独的窗口中打开。",
    windowHost: "当前页面：{host}",
    windowLoading: "正在加载付款页面…",
    windowFailed: "付款页面未能加载。请关闭窗口后重试。",
    closeWindow: "关闭结账窗口",
    verifying: "正在通过 Tomverse 核对你的账户…",
    planConfirmed: "{plan} 方案已在你的账户中生效。",
    notConfirmed: "Tomverse 尚未记录这笔付款。如果你已完成付款，请稍后再核对。",
    checkAgain: "再次核对",
    leftCheckout: "你在付款前离开了结账页面。账户没有变化。",
    urlRejected: "无法验证付款页面地址，因此未打开。",
    windowBusy: "请先完成或关闭已打开的结账窗口。",
    plansTitle: "方案",
    pricePerMonth: "{amount}/月",
    pricePerYear: "{amount}/年",
    monthlyCredits: "每月 {credits} 积分",
    balancesTitle: "积分",
    purchasedExpiry: "最早到期 {date}",
    cancelConfirm: "再点击一次即可预约取消。",
    back: "返回",
  },
  "zh-Hant": {
    windowTitle: "Tomverse 結帳",
    windowOpen: "結帳頁面已在獨立視窗中開啟。",
    windowHost: "目前頁面：{host}",
    windowLoading: "正在載入付款頁面…",
    windowFailed: "付款頁面未能載入。請關閉視窗後再試一次。",
    closeWindow: "關閉結帳視窗",
    verifying: "正在透過 Tomverse 確認你的帳戶…",
    planConfirmed: "{plan} 方案已在你的帳戶中生效。",
    notConfirmed: "Tomverse 尚未記錄這筆付款。如果你已完成付款，請稍後再確認。",
    checkAgain: "再次確認",
    leftCheckout: "你在付款前離開了結帳頁面。帳戶沒有變更。",
    urlRejected: "無法驗證付款頁面位址，因此未開啟。",
    windowBusy: "請先完成或關閉已開啟的結帳視窗。",
    plansTitle: "方案",
    pricePerMonth: "{amount}/月",
    pricePerYear: "{amount}/年",
    monthlyCredits: "每月 {credits} 點數",
    balancesTitle: "點數",
    purchasedExpiry: "最早到期 {date}",
    cancelConfirm: "再按一次即可預約取消。",
    back: "返回",
  },
  fr: {
    windowTitle: "Paiement Tomverse",
    windowOpen: "Le paiement est ouvert dans une fenêtre séparée.",
    windowHost: "Page affichée : {host}",
    windowLoading: "Chargement de la page de paiement…",
    windowFailed: "La page de paiement ne s’est pas chargée. Fermez la fenêtre et réessayez.",
    closeWindow: "Fermer la fenêtre de paiement",
    verifying: "Vérification de votre compte auprès de Tomverse…",
    planConfirmed: "{plan} est maintenant actif sur votre compte.",
    notConfirmed: "Tomverse n’a pas encore enregistré ce paiement. Si vous l’avez terminé, vérifiez de nouveau dans un instant.",
    checkAgain: "Vérifier de nouveau",
    leftCheckout: "Vous avez quitté le paiement avant de payer. Votre compte n’a pas changé.",
    urlRejected: "L’adresse de la page de paiement n’a pas pu être vérifiée ; elle n’a donc pas été ouverte.",
    windowBusy: "Terminez ou fermez d’abord la fenêtre de paiement déjà ouverte.",
    plansTitle: "Abonnements",
    pricePerMonth: "{amount} / mois",
    pricePerYear: "{amount} / an",
    monthlyCredits: "{credits} crédits par mois",
    balancesTitle: "Crédits",
    purchasedExpiry: "Première expiration le {date}",
    cancelConfirm: "Cliquez de nouveau pour programmer la résiliation.",
    back: "Retour",
  },
  de: {
    windowTitle: "Tomverse-Bezahlung",
    windowOpen: "Die Bezahlung ist in einem separaten Fenster geöffnet.",
    windowHost: "Angezeigte Seite: {host}",
    windowLoading: "Zahlungsseite wird geladen…",
    windowFailed: "Die Zahlungsseite wurde nicht geladen. Schließen Sie das Fenster und versuchen Sie es erneut.",
    closeWindow: "Zahlungsfenster schließen",
    verifying: "Ihr Konto wird bei Tomverse geprüft…",
    planConfirmed: "{plan} ist jetzt in Ihrem Konto aktiv.",
    notConfirmed: "Tomverse hat diese Zahlung noch nicht erfasst. Wenn Sie bezahlt haben, prüfen Sie es gleich noch einmal.",
    checkAgain: "Erneut prüfen",
    leftCheckout: "Sie haben die Bezahlung vor dem Zahlen verlassen. Ihr Konto ist unverändert.",
    urlRejected: "Die Adresse der Zahlungsseite konnte nicht geprüft werden und wurde daher nicht geöffnet.",
    windowBusy: "Schließen Sie zuerst das bereits geöffnete Zahlungsfenster ab oder schließen Sie es.",
    plansTitle: "Tarife",
    pricePerMonth: "{amount} / Monat",
    pricePerYear: "{amount} / Jahr",
    monthlyCredits: "{credits} Credits pro Monat",
    balancesTitle: "Credits",
    purchasedExpiry: "Früheste Ablaufzeit {date}",
    cancelConfirm: "Klicken Sie erneut, um die Kündigung vorzumerken.",
    back: "Zurück",
  },
  es: {
    windowTitle: "Pago de Tomverse",
    windowOpen: "El pago está abierto en una ventana aparte.",
    windowHost: "Página en pantalla: {host}",
    windowLoading: "Cargando la página de pago…",
    windowFailed: "La página de pago no se cargó. Cierra la ventana e inténtalo de nuevo.",
    closeWindow: "Cerrar ventana de pago",
    verifying: "Comprobando tu cuenta con Tomverse…",
    planConfirmed: "{plan} ya está activo en tu cuenta.",
    notConfirmed: "Tomverse aún no ha registrado este pago. Si ya pagaste, vuelve a comprobarlo en un momento.",
    checkAgain: "Comprobar de nuevo",
    leftCheckout: "Saliste del pago antes de pagar. Tu cuenta no ha cambiado.",
    urlRejected: "No se pudo verificar la dirección de la página de pago, así que no se abrió.",
    windowBusy: "Termina o cierra primero la ventana de pago que ya está abierta.",
    plansTitle: "Planes",
    pricePerMonth: "{amount} / mes",
    pricePerYear: "{amount} / año",
    monthlyCredits: "{credits} créditos al mes",
    balancesTitle: "Créditos",
    purchasedExpiry: "Primer vencimiento: {date}",
    cancelConfirm: "Haz clic de nuevo para programar la cancelación.",
    back: "Atrás",
  },
  pt: {
    windowTitle: "Pagamento Tomverse",
    windowOpen: "O pagamento está aberto numa janela separada.",
    windowHost: "Página no ecrã: {host}",
    windowLoading: "A carregar a página de pagamento…",
    windowFailed: "A página de pagamento não carregou. Feche a janela e tente novamente.",
    closeWindow: "Fechar janela de pagamento",
    verifying: "A verificar a sua conta com a Tomverse…",
    planConfirmed: "O plano {plan} está ativo na sua conta.",
    notConfirmed: "A Tomverse ainda não registou este pagamento. Se já pagou, verifique novamente dentro de momentos.",
    checkAgain: "Verificar novamente",
    leftCheckout: "Saiu do pagamento antes de pagar. A sua conta não mudou.",
    urlRejected: "Não foi possível verificar o endereço da página de pagamento, por isso não foi aberta.",
    windowBusy: "Conclua ou feche primeiro a janela de pagamento que já está aberta.",
    plansTitle: "Planos",
    pricePerMonth: "{amount} / mês",
    pricePerYear: "{amount} / ano",
    monthlyCredits: "{credits} créditos por mês",
    balancesTitle: "Créditos",
    purchasedExpiry: "Primeira expiração: {date}",
    cancelConfirm: "Clique novamente para agendar o cancelamento.",
    back: "Voltar",
  },
};

export const desktopBillingCopy = (language: Language): DesktopBillingCopy => copy[language] ?? copy.en;

/** Replaces `{name}` placeholders. */
export const fillBillingCopy = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

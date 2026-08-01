import type { Language } from "@/components/LanguageProvider";

/**
 * Customer-facing copy for the Pro <-> Max change screen.
 *
 * Kept apart from `purchaseCopy.ts` because it says different things: a
 * purchase is one decision, a plan change is three -- what it costs, when it
 * takes effect, and what happens to an existing cancellation -- and every one
 * of those has to be readable before the customer commits.
 *
 * Two rules the strings themselves have to carry:
 *
 * - An upgrade is charged **now**, and Max does not arrive until that charge
 *   succeeds. Copy that says "upgraded" before the invoice is paid would be
 *   the same lie the server refuses to tell.
 * - Resuming a cancelled subscription is its own decision with its own label.
 *   It is never folded into "confirm".
 *
 * Server error text is never shown as-is. Each refusal code maps to a sentence
 * that says what the customer can do next.
 */

export type PlanChangeCopy = {
  upgradeTitle: (plan: string) => string;
  downgradeTitle: (plan: string) => string;
  close: string;
  loading: string;
  loadingStatus: string;
  /** The charge that happens the moment they confirm. */
  dueNow: string;
  /** Says outright that the plan does not move until the charge clears. */
  upgradeBody: (plan: string) => string;
  /** Says the current plan runs to the end of the period, with no refund. */
  downgradeBody: (plan: string, date: string) => string;
  effectiveOn: (date: string) => string;
  effectiveImmediately: string;
  confirmUpgrade: (plan: string) => string;
  confirmDowngrade: (plan: string) => string;
  working: string;
  /** Its own control, its own label. Never implied by the confirm button. */
  resumeRenewalLabel: string;
  resumeRenewalHint: string;
  cancellationPreservedNotice: string;
  scheduledTitle: (plan: string) => string;
  scheduledBody: (plan: string, date: string) => string;
  cancelScheduled: string;
  cancelScheduledDone: string;
  pendingPaymentTitle: string;
  pendingPaymentBody: string;
  upgradeDoneTitle: (plan: string) => string;
  upgradeDoneBody: string;
  retry: string;
  contactSupport: string;
  errors: Record<PlanChangeCopyErrorCode, string>;
};

export type PlanChangeCopyErrorCode =
  | "PLAN_CHANGE_NOT_SUPPORTED"
  | "NO_ACTIVE_SUBSCRIPTION"
  | "SUBSCRIPTION_NOT_CHANGEABLE"
  | "BILLING_INTERVAL_CHANGE_NOT_SUPPORTED"
  | "SUBSCRIPTION_NOT_SINGLE_ITEM"
  | "PLAN_CHANGE_ALREADY_PENDING"
  | "PLAN_CHANGE_ALREADY_SCHEDULED"
  | "SUBSCRIPTION_SCHEDULE_CONFLICT"
  | "PLAN_CHANGE_BLOCKED_BY_CANCELLATION"
  | "PLAN_CHANGE_PREVIEW_NOT_FOUND"
  | "PLAN_CHANGE_PREVIEW_EXPIRED"
  | "PLAN_CHANGE_PRICE_UNAVAILABLE"
  | "PLAN_CHANGE_ALREADY_APPLIED"
  | "NO_SCHEDULED_PLAN_CHANGE"
  | "AUTHENTICATION_REQUIRED"
  | "STRIPE_NOT_CONFIGURED"
  | "STRIPE_ERROR"
  | "NETWORK_ERROR";

const CODES: readonly PlanChangeCopyErrorCode[] = [
  "PLAN_CHANGE_NOT_SUPPORTED",
  "NO_ACTIVE_SUBSCRIPTION",
  "SUBSCRIPTION_NOT_CHANGEABLE",
  "BILLING_INTERVAL_CHANGE_NOT_SUPPORTED",
  "SUBSCRIPTION_NOT_SINGLE_ITEM",
  "PLAN_CHANGE_ALREADY_PENDING",
  "PLAN_CHANGE_ALREADY_SCHEDULED",
  "SUBSCRIPTION_SCHEDULE_CONFLICT",
  "PLAN_CHANGE_BLOCKED_BY_CANCELLATION",
  "PLAN_CHANGE_PREVIEW_NOT_FOUND",
  "PLAN_CHANGE_PREVIEW_EXPIRED",
  "PLAN_CHANGE_PRICE_UNAVAILABLE",
  "PLAN_CHANGE_ALREADY_APPLIED",
  "NO_SCHEDULED_PLAN_CHANGE",
  "AUTHENTICATION_REQUIRED",
  "STRIPE_NOT_CONFIGURED",
  "STRIPE_ERROR",
  "NETWORK_ERROR",
];

/** Narrows an unknown server `code` to one this screen has a sentence for. */
export const normalizePlanChangeErrorCode = (
  value: unknown
): PlanChangeCopyErrorCode =>
  typeof value === "string" &&
  (CODES as readonly string[]).includes(value)
    ? (value as PlanChangeCopyErrorCode)
    : "STRIPE_ERROR";

/**
 * True when the only useful next step is a person.
 *
 * Retrying a schedule conflict or a missing price just produces the same
 * refusal, so those offer support instead of a button that cannot work.
 */
export const planChangeNeedsSupport = (
  code: PlanChangeCopyErrorCode
): boolean =>
  code === "SUBSCRIPTION_SCHEDULE_CONFLICT" ||
  code === "SUBSCRIPTION_NOT_SINGLE_ITEM" ||
  code === "PLAN_CHANGE_PRICE_UNAVAILABLE" ||
  code === "SUBSCRIPTION_NOT_CHANGEABLE" ||
  code === "BILLING_INTERVAL_CHANGE_NOT_SUPPORTED" ||
  code === "STRIPE_NOT_CONFIGURED";

export const planChangeCopy: Record<Language, PlanChangeCopy> = {
  en: {
    upgradeTitle: (plan) => `Move to ${plan}`,
    downgradeTitle: (plan) => `Move to ${plan}`,
    close: "Close",
    loading: "Working out what this costs…",
    loadingStatus: "Asking the payment provider what this change costs.",
    dueNow: "Due today",
    upgradeBody: (plan) =>
      `You are charged the amount above today. ${plan} starts as soon as that payment succeeds — if it fails or needs extra verification, you stay on your current plan and are not charged.`,
    downgradeBody: (plan, date) =>
      `You keep your current plan until ${date}, with no refund for the rest of the period. ${plan} starts on that date, and you can call this off any time before then.`,
    effectiveOn: (date) => `Starts on ${date}`,
    effectiveImmediately: "Starts as soon as payment succeeds",
    confirmUpgrade: (plan) => `Pay and move to ${plan}`,
    confirmDowngrade: (plan) => `Schedule ${plan}`,
    working: "Working…",
    resumeRenewalLabel: "Also turn automatic renewal back on",
    resumeRenewalHint:
      "Your subscription is set to end at the end of this period. Changing plan does not change that on its own.",
    cancellationPreservedNotice:
      "Your subscription still ends at the end of this period. Tick the box above if you want it to renew.",
    scheduledTitle: (plan) => `${plan} is scheduled`,
    scheduledBody: (plan, date) =>
      `${plan} starts on ${date}. Until then nothing about your current plan changes.`,
    cancelScheduled: "Cancel this change",
    cancelScheduledDone: "The scheduled change was cancelled.",
    pendingPaymentTitle: "Waiting for your payment",
    pendingPaymentBody:
      "Your bank has not finished with the payment yet. Your plan changes the moment it does; nothing changes if it does not.",
    upgradeDoneTitle: (plan) => `${plan} is active`,
    upgradeDoneBody: "The payment went through and the new plan is in effect.",
    retry: "Try again",
    contactSupport: "Contact support",
    errors: {
      PLAN_CHANGE_NOT_SUPPORTED: "You are already on this plan.",
      NO_ACTIVE_SUBSCRIPTION:
        "There is no subscription to change. Start one from the plan you want.",
      SUBSCRIPTION_NOT_CHANGEABLE:
        "Your subscription cannot be changed right now — an unpaid invoice or an unfinished payment has to be settled first. Support can sort this out.",
      BILLING_INTERVAL_CHANGE_NOT_SUPPORTED:
        "Changing between monthly and annual billing at the same time as the plan is not supported yet. Support can do it for you.",
      SUBSCRIPTION_NOT_SINGLE_ITEM:
        "Your subscription has a shape this screen cannot change safely. Support can make the change.",
      PLAN_CHANGE_ALREADY_PENDING:
        "An earlier change is still waiting on payment or verification. Wait for it to finish, then try again.",
      PLAN_CHANGE_ALREADY_SCHEDULED:
        "A plan change is already scheduled. Cancel it first if you want a different one.",
      SUBSCRIPTION_SCHEDULE_CONFLICT:
        "Your subscription is being driven by a schedule this screen did not create. Support can look at it.",
      PLAN_CHANGE_BLOCKED_BY_CANCELLATION:
        "Your subscription already ends at the end of this period, so there is no next period to move. Turn renewal back on first if you want to keep the subscription.",
      PLAN_CHANGE_PREVIEW_NOT_FOUND:
        "That quote is no longer available. Start again to get a fresh one.",
      PLAN_CHANGE_PREVIEW_EXPIRED:
        "The price we showed you is out of date. Start again to see the current one.",
      PLAN_CHANGE_PRICE_UNAVAILABLE:
        "The price for that plan is not available in your currency. Support can help.",
      PLAN_CHANGE_ALREADY_APPLIED: "That change has already taken effect.",
      NO_SCHEDULED_PLAN_CHANGE: "There is no scheduled change to cancel.",
      AUTHENTICATION_REQUIRED: "Your session has expired. Sign in again to continue.",
      STRIPE_NOT_CONFIGURED:
        "Payments are unavailable right now. Please try again later.",
      STRIPE_ERROR:
        "The payment provider could not complete this. Nothing was charged.",
      NETWORK_ERROR:
        "We could not reach the server. Check your connection and try again.",
    },
  },
  ko: {
    upgradeTitle: (plan) => `${plan}(으)로 변경`,
    downgradeTitle: (plan) => `${plan}(으)로 변경`,
    close: "닫기",
    loading: "결제 금액을 확인하고 있습니다…",
    loadingStatus: "결제사에 이번 변경의 금액을 확인하고 있습니다.",
    dueNow: "오늘 결제",
    upgradeBody: (plan) =>
      `확인을 누르면 위 금액이 오늘 결제됩니다. 결제가 성공한 직후 ${plan}이 시작되며, 결제가 실패하거나 추가 인증이 필요하면 지금 플랜이 그대로 유지되고 결제도 되지 않습니다.`,
    downgradeBody: (plan, date) =>
      `${date}까지는 지금 플랜을 그대로 사용하며, 남은 기간에 대한 환불은 없습니다. 그날부터 ${plan}이 적용되고, 그 전까지는 언제든 취소할 수 있습니다.`,
    effectiveOn: (date) => `${date}부터 적용`,
    effectiveImmediately: "결제 성공 즉시 적용",
    confirmUpgrade: (plan) => `결제하고 ${plan} 시작`,
    confirmDowngrade: (plan) => `${plan} 예약`,
    working: "처리 중…",
    resumeRenewalLabel: "자동 갱신도 다시 켜기",
    resumeRenewalHint:
      "이 구독은 이번 기간이 끝나면 종료되도록 예약돼 있습니다. 플랜 변경만으로는 이 예약이 해제되지 않습니다.",
    cancellationPreservedNotice:
      "구독은 이번 기간이 끝나면 계속 종료됩니다. 갱신을 원하시면 위 항목을 선택하세요.",
    scheduledTitle: (plan) => `${plan} 변경이 예약되었습니다`,
    scheduledBody: (plan, date) =>
      `${date}부터 ${plan}이 적용됩니다. 그때까지는 지금 플랜에 아무 변화도 없습니다.`,
    cancelScheduled: "예약 취소",
    cancelScheduledDone: "예약된 변경을 취소했습니다.",
    pendingPaymentTitle: "결제를 기다리고 있습니다",
    pendingPaymentBody:
      "카드사 처리가 아직 끝나지 않았습니다. 결제가 완료되는 즉시 플랜이 바뀌고, 완료되지 않으면 아무것도 바뀌지 않습니다.",
    upgradeDoneTitle: (plan) => `${plan}이 적용되었습니다`,
    upgradeDoneBody: "결제가 완료되어 새 플랜이 적용되었습니다.",
    retry: "다시 시도",
    contactSupport: "고객지원 문의",
    errors: {
      PLAN_CHANGE_NOT_SUPPORTED: "이미 이 플랜을 사용 중입니다.",
      NO_ACTIVE_SUBSCRIPTION:
        "변경할 구독이 없습니다. 원하시는 플랜에서 새로 시작해 주세요.",
      SUBSCRIPTION_NOT_CHANGEABLE:
        "지금은 구독을 변경할 수 없습니다. 미납 청구서나 완료되지 않은 결제를 먼저 정리해야 합니다. 고객지원이 도와드립니다.",
      BILLING_INTERVAL_CHANGE_NOT_SUPPORTED:
        "플랜 변경과 월간·연간 변경을 동시에 하는 것은 아직 지원하지 않습니다. 고객지원이 대신 처리해 드립니다.",
      SUBSCRIPTION_NOT_SINGLE_ITEM:
        "이 화면에서 안전하게 변경할 수 없는 구독 구성입니다. 고객지원이 대신 변경해 드립니다.",
      PLAN_CHANGE_ALREADY_PENDING:
        "이전 변경이 아직 결제 또는 인증을 기다리고 있습니다. 완료된 뒤에 다시 시도해 주세요.",
      PLAN_CHANGE_ALREADY_SCHEDULED:
        "이미 예약된 플랜 변경이 있습니다. 다른 변경을 원하시면 먼저 취소해 주세요.",
      SUBSCRIPTION_SCHEDULE_CONFLICT:
        "이 화면이 만들지 않은 예약이 구독을 제어하고 있습니다. 고객지원이 확인해 드립니다.",
      PLAN_CHANGE_BLOCKED_BY_CANCELLATION:
        "구독이 이번 기간 말에 종료되도록 예약돼 있어 옮길 다음 기간이 없습니다. 구독을 유지하시려면 먼저 자동 갱신을 다시 켜 주세요.",
      PLAN_CHANGE_PREVIEW_NOT_FOUND:
        "이 견적은 더 이상 유효하지 않습니다. 처음부터 다시 진행해 주세요.",
      PLAN_CHANGE_PREVIEW_EXPIRED:
        "표시된 금액이 지금 기준이 아닙니다. 다시 시작해 현재 금액을 확인해 주세요.",
      PLAN_CHANGE_PRICE_UNAVAILABLE:
        "해당 플랜의 가격을 사용 중인 통화로 제공하지 못했습니다. 고객지원이 도와드립니다.",
      PLAN_CHANGE_ALREADY_APPLIED: "이미 적용된 변경입니다.",
      NO_SCHEDULED_PLAN_CHANGE: "취소할 예약된 변경이 없습니다.",
      AUTHENTICATION_REQUIRED: "세션이 만료되었습니다. 다시 로그인해 주세요.",
      STRIPE_NOT_CONFIGURED:
        "지금은 결제를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
      STRIPE_ERROR: "결제사에서 처리하지 못했습니다. 결제된 금액은 없습니다.",
      NETWORK_ERROR:
        "서버에 연결하지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요.",
    },
  },
  zh: {
    upgradeTitle: (plan) => `切换到 ${plan}`,
    downgradeTitle: (plan) => `切换到 ${plan}`,
    close: "关闭",
    loading: "正在确认费用…",
    loadingStatus: "正在向支付服务商确认本次变更的费用。",
    dueNow: "今日扣款",
    upgradeBody: (plan) =>
      `确认后将于今日扣除上述金额。扣款成功后立即启用 ${plan}；若扣款失败或需要额外验证，将保留当前方案且不会扣款。`,
    downgradeBody: (plan, date) =>
      `在 ${date} 之前继续使用当前方案，剩余时间不退款。该日期起启用 ${plan}，在此之前可随时取消。`,
    effectiveOn: (date) => `${date} 起生效`,
    effectiveImmediately: "扣款成功后立即生效",
    confirmUpgrade: (plan) => `付款并切换到 ${plan}`,
    confirmDowngrade: (plan) => `预约 ${plan}`,
    working: "处理中…",
    resumeRenewalLabel: "同时重新开启自动续订",
    resumeRenewalHint:
      "此订阅已设定在本期结束时终止。仅变更方案不会解除该设定。",
    cancellationPreservedNotice:
      "订阅仍会在本期结束时终止。如需续订，请勾选上方选项。",
    scheduledTitle: (plan) => `已预约切换到 ${plan}`,
    scheduledBody: (plan, date) =>
      `${date} 起启用 ${plan}。在此之前当前方案不会有任何变化。`,
    cancelScheduled: "取消此变更",
    cancelScheduledDone: "已取消预约的变更。",
    pendingPaymentTitle: "正在等待付款",
    pendingPaymentBody:
      "银行尚未完成付款处理。付款完成后方案立即变更；未完成则不会有任何变化。",
    upgradeDoneTitle: (plan) => `${plan} 已生效`,
    upgradeDoneBody: "付款已完成，新方案已生效。",
    retry: "重试",
    contactSupport: "联系支持",
    errors: {
      PLAN_CHANGE_NOT_SUPPORTED: "你已经在使用此方案。",
      NO_ACTIVE_SUBSCRIPTION: "没有可变更的订阅，请直接开通所需方案。",
      SUBSCRIPTION_NOT_CHANGEABLE:
        "当前无法变更订阅，需先处理未支付的账单或未完成的付款。支持团队可以协助。",
      BILLING_INTERVAL_CHANGE_NOT_SUPPORTED:
        "暂不支持在变更方案的同时切换月付与年付。支持团队可以代为处理。",
      SUBSCRIPTION_NOT_SINGLE_ITEM:
        "此订阅的结构无法在此页面安全变更。支持团队可以代为处理。",
      PLAN_CHANGE_ALREADY_PENDING:
        "上一次变更仍在等待付款或验证。完成后再试一次。",
      PLAN_CHANGE_ALREADY_SCHEDULED:
        "已经预约了一次方案变更。如需其他变更，请先取消。",
      SUBSCRIPTION_SCHEDULE_CONFLICT:
        "订阅正由此页面未创建的预约控制。支持团队可以查看。",
      PLAN_CHANGE_BLOCKED_BY_CANCELLATION:
        "订阅已设定在本期结束时终止，没有可切换的下一期。如需保留订阅，请先重新开启自动续订。",
      PLAN_CHANGE_PREVIEW_NOT_FOUND: "该报价已失效，请重新开始。",
      PLAN_CHANGE_PREVIEW_EXPIRED: "显示的金额已过期，请重新开始以查看当前金额。",
      PLAN_CHANGE_PRICE_UNAVAILABLE:
        "无法以你的币种提供该方案的价格。支持团队可以协助。",
      PLAN_CHANGE_ALREADY_APPLIED: "该变更已经生效。",
      NO_SCHEDULED_PLAN_CHANGE: "没有可取消的预约变更。",
      AUTHENTICATION_REQUIRED: "登录状态已过期，请重新登录。",
      STRIPE_NOT_CONFIGURED: "目前无法使用支付功能，请稍后再试。",
      STRIPE_ERROR: "支付服务商未能完成此操作，未产生任何扣款。",
      NETWORK_ERROR: "无法连接服务器，请检查网络后重试。",
    },
  },
  fr: {
    upgradeTitle: (plan) => `Passer à ${plan}`,
    downgradeTitle: (plan) => `Passer à ${plan}`,
    close: "Fermer",
    loading: "Calcul du montant…",
    loadingStatus: "Nous demandons le montant de ce changement au prestataire de paiement.",
    dueNow: "À payer aujourd'hui",
    upgradeBody: (plan) =>
      `Le montant ci-dessus est prélevé aujourd'hui. ${plan} démarre dès que le paiement aboutit ; en cas d'échec ou de vérification supplémentaire, votre offre actuelle est conservée et rien n'est prélevé.`,
    downgradeBody: (plan, date) =>
      `Vous conservez votre offre actuelle jusqu'au ${date}, sans remboursement du reste de la période. ${plan} démarre à cette date, et vous pouvez annuler à tout moment avant.`,
    effectiveOn: (date) => `Prend effet le ${date}`,
    effectiveImmediately: "Prend effet dès le paiement",
    confirmUpgrade: (plan) => `Payer et passer à ${plan}`,
    confirmDowngrade: (plan) => `Programmer ${plan}`,
    working: "Traitement…",
    resumeRenewalLabel: "Réactiver aussi le renouvellement automatique",
    resumeRenewalHint:
      "Votre abonnement doit se terminer à la fin de cette période. Changer d'offre ne modifie pas cela.",
    cancellationPreservedNotice:
      "Votre abonnement se termine toujours à la fin de cette période. Cochez la case ci-dessus pour le renouveler.",
    scheduledTitle: (plan) => `${plan} est programmé`,
    scheduledBody: (plan, date) =>
      `${plan} démarre le ${date}. D'ici là, rien ne change à votre offre actuelle.`,
    cancelScheduled: "Annuler ce changement",
    cancelScheduledDone: "Le changement programmé a été annulé.",
    pendingPaymentTitle: "Paiement en attente",
    pendingPaymentBody:
      "Votre banque n'a pas terminé le paiement. Votre offre change dès que c'est fait ; rien ne change sinon.",
    upgradeDoneTitle: (plan) => `${plan} est actif`,
    upgradeDoneBody: "Le paiement a abouti et la nouvelle offre est active.",
    retry: "Réessayer",
    contactSupport: "Contacter le support",
    errors: {
      PLAN_CHANGE_NOT_SUPPORTED: "Vous utilisez déjà cette offre.",
      NO_ACTIVE_SUBSCRIPTION:
        "Aucun abonnement à modifier. Démarrez-en un depuis l'offre souhaitée.",
      SUBSCRIPTION_NOT_CHANGEABLE:
        "Votre abonnement ne peut pas être modifié pour l'instant : une facture impayée ou un paiement inachevé doit d'abord être réglé. Le support peut vous aider.",
      BILLING_INTERVAL_CHANGE_NOT_SUPPORTED:
        "Changer d'offre et de périodicité en même temps n'est pas encore possible. Le support peut le faire pour vous.",
      SUBSCRIPTION_NOT_SINGLE_ITEM:
        "Votre abonnement a une structure que cet écran ne peut pas modifier sans risque. Le support peut s'en charger.",
      PLAN_CHANGE_ALREADY_PENDING:
        "Un changement précédent attend encore un paiement ou une vérification. Réessayez une fois terminé.",
      PLAN_CHANGE_ALREADY_SCHEDULED:
        "Un changement d'offre est déjà programmé. Annulez-le d'abord pour en demander un autre.",
      SUBSCRIPTION_SCHEDULE_CONFLICT:
        "Votre abonnement est piloté par une programmation que cet écran n'a pas créée. Le support peut l'examiner.",
      PLAN_CHANGE_BLOCKED_BY_CANCELLATION:
        "Votre abonnement se termine déjà à la fin de cette période : il n'y a pas de période suivante. Réactivez d'abord le renouvellement pour le conserver.",
      PLAN_CHANGE_PREVIEW_NOT_FOUND:
        "Ce devis n'est plus disponible. Recommencez pour en obtenir un nouveau.",
      PLAN_CHANGE_PREVIEW_EXPIRED:
        "Le montant affiché n'est plus à jour. Recommencez pour voir le montant actuel.",
      PLAN_CHANGE_PRICE_UNAVAILABLE:
        "Le tarif de cette offre n'est pas disponible dans votre devise. Le support peut vous aider.",
      PLAN_CHANGE_ALREADY_APPLIED: "Ce changement a déjà pris effet.",
      NO_SCHEDULED_PLAN_CHANGE: "Aucun changement programmé à annuler.",
      AUTHENTICATION_REQUIRED:
        "Votre session a expiré. Reconnectez-vous pour continuer.",
      STRIPE_NOT_CONFIGURED:
        "Les paiements sont indisponibles pour le moment. Réessayez plus tard.",
      STRIPE_ERROR:
        "Le prestataire de paiement n'a pas pu finaliser l'opération. Rien n'a été prélevé.",
      NETWORK_ERROR:
        "Impossible de joindre le serveur. Vérifiez votre connexion et réessayez.",
    },
  },
  de: {
    upgradeTitle: (plan) => `Zu ${plan} wechseln`,
    downgradeTitle: (plan) => `Zu ${plan} wechseln`,
    close: "Schließen",
    loading: "Betrag wird ermittelt…",
    loadingStatus: "Wir fragen den Zahlungsanbieter nach dem Betrag für diesen Wechsel.",
    dueNow: "Heute fällig",
    upgradeBody: (plan) =>
      `Der obige Betrag wird heute abgebucht. ${plan} startet, sobald die Zahlung erfolgreich ist — schlägt sie fehl oder ist eine zusätzliche Bestätigung nötig, bleibt Ihr aktueller Tarif und es wird nichts abgebucht.`,
    downgradeBody: (plan, date) =>
      `Ihr aktueller Tarif läuft bis zum ${date}, ohne Erstattung für den Rest des Zeitraums. Ab diesem Datum gilt ${plan}; bis dahin können Sie den Wechsel jederzeit abbrechen.`,
    effectiveOn: (date) => `Gilt ab ${date}`,
    effectiveImmediately: "Gilt, sobald die Zahlung erfolgreich ist",
    confirmUpgrade: (plan) => `Bezahlen und zu ${plan} wechseln`,
    confirmDowngrade: (plan) => `${plan} vormerken`,
    working: "Wird verarbeitet…",
    resumeRenewalLabel: "Automatische Verlängerung wieder einschalten",
    resumeRenewalHint:
      "Ihr Abonnement endet zum Ende dieses Zeitraums. Ein Tarifwechsel ändert das nicht von allein.",
    cancellationPreservedNotice:
      "Ihr Abonnement endet weiterhin zum Ende dieses Zeitraums. Setzen Sie oben das Häkchen, wenn es sich verlängern soll.",
    scheduledTitle: (plan) => `${plan} ist vorgemerkt`,
    scheduledBody: (plan, date) =>
      `${plan} startet am ${date}. Bis dahin ändert sich an Ihrem aktuellen Tarif nichts.`,
    cancelScheduled: "Wechsel abbrechen",
    cancelScheduledDone: "Der vorgemerkte Wechsel wurde abgebrochen.",
    pendingPaymentTitle: "Zahlung wird erwartet",
    pendingPaymentBody:
      "Ihre Bank hat die Zahlung noch nicht abgeschlossen. Sobald das geschieht, wechselt der Tarif; andernfalls ändert sich nichts.",
    upgradeDoneTitle: (plan) => `${plan} ist aktiv`,
    upgradeDoneBody: "Die Zahlung war erfolgreich und der neue Tarif gilt.",
    retry: "Erneut versuchen",
    contactSupport: "Support kontaktieren",
    errors: {
      PLAN_CHANGE_NOT_SUPPORTED: "Sie nutzen diesen Tarif bereits.",
      NO_ACTIVE_SUBSCRIPTION:
        "Es gibt kein Abonnement zum Wechseln. Starten Sie eines im gewünschten Tarif.",
      SUBSCRIPTION_NOT_CHANGEABLE:
        "Ihr Abonnement kann derzeit nicht geändert werden — eine offene Rechnung oder eine unfertige Zahlung muss zuerst geklärt werden. Der Support hilft weiter.",
      BILLING_INTERVAL_CHANGE_NOT_SUPPORTED:
        "Tarif und Abrechnungszeitraum gleichzeitig zu wechseln, ist noch nicht möglich. Der Support übernimmt das für Sie.",
      SUBSCRIPTION_NOT_SINGLE_ITEM:
        "Ihr Abonnement hat eine Struktur, die dieser Bildschirm nicht sicher ändern kann. Der Support übernimmt den Wechsel.",
      PLAN_CHANGE_ALREADY_PENDING:
        "Ein früherer Wechsel wartet noch auf Zahlung oder Bestätigung. Versuchen Sie es danach erneut.",
      PLAN_CHANGE_ALREADY_SCHEDULED:
        "Ein Tarifwechsel ist bereits vorgemerkt. Brechen Sie ihn ab, wenn Sie einen anderen möchten.",
      SUBSCRIPTION_SCHEDULE_CONFLICT:
        "Ihr Abonnement wird von einer Planung gesteuert, die dieser Bildschirm nicht angelegt hat. Der Support sieht sich das an.",
      PLAN_CHANGE_BLOCKED_BY_CANCELLATION:
        "Ihr Abonnement endet bereits zum Ende dieses Zeitraums, es gibt also keinen nächsten Zeitraum. Schalten Sie zuerst die Verlängerung wieder ein, wenn Sie es behalten möchten.",
      PLAN_CHANGE_PREVIEW_NOT_FOUND:
        "Dieses Angebot ist nicht mehr verfügbar. Starten Sie neu, um ein aktuelles zu erhalten.",
      PLAN_CHANGE_PREVIEW_EXPIRED:
        "Der angezeigte Betrag ist nicht mehr aktuell. Starten Sie neu, um den aktuellen zu sehen.",
      PLAN_CHANGE_PRICE_UNAVAILABLE:
        "Der Preis für diesen Tarif ist in Ihrer Währung nicht verfügbar. Der Support hilft weiter.",
      PLAN_CHANGE_ALREADY_APPLIED: "Dieser Wechsel ist bereits wirksam.",
      NO_SCHEDULED_PLAN_CHANGE: "Es gibt keinen vorgemerkten Wechsel zum Abbrechen.",
      AUTHENTICATION_REQUIRED:
        "Ihre Sitzung ist abgelaufen. Melden Sie sich erneut an.",
      STRIPE_NOT_CONFIGURED:
        "Zahlungen sind derzeit nicht verfügbar. Bitte später erneut versuchen.",
      STRIPE_ERROR:
        "Der Zahlungsanbieter konnte den Vorgang nicht abschließen. Es wurde nichts abgebucht.",
      NETWORK_ERROR:
        "Der Server war nicht erreichbar. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.",
    },
  },
  es: {
    upgradeTitle: (plan) => `Cambiar a ${plan}`,
    downgradeTitle: (plan) => `Cambiar a ${plan}`,
    close: "Cerrar",
    loading: "Calculando el importe…",
    loadingStatus: "Estamos consultando el importe de este cambio al proveedor de pagos.",
    dueNow: "A pagar hoy",
    upgradeBody: (plan) =>
      `Hoy se cobrará el importe anterior. ${plan} empieza en cuanto el pago se complete; si falla o necesita verificación adicional, mantienes tu plan actual y no se cobra nada.`,
    downgradeBody: (plan, date) =>
      `Mantienes tu plan actual hasta el ${date}, sin reembolso por el resto del periodo. ${plan} empieza ese día y puedes cancelarlo en cualquier momento antes.`,
    effectiveOn: (date) => `Se aplica el ${date}`,
    effectiveImmediately: "Se aplica en cuanto se complete el pago",
    confirmUpgrade: (plan) => `Pagar y cambiar a ${plan}`,
    confirmDowngrade: (plan) => `Programar ${plan}`,
    working: "Procesando…",
    resumeRenewalLabel: "Reactivar también la renovación automática",
    resumeRenewalHint:
      "Tu suscripción está configurada para terminar al final de este periodo. Cambiar de plan no lo modifica por sí solo.",
    cancellationPreservedNotice:
      "Tu suscripción sigue terminando al final de este periodo. Marca la casilla de arriba si quieres que se renueve.",
    scheduledTitle: (plan) => `${plan} está programado`,
    scheduledBody: (plan, date) =>
      `${plan} empieza el ${date}. Hasta entonces tu plan actual no cambia.`,
    cancelScheduled: "Cancelar este cambio",
    cancelScheduledDone: "Se canceló el cambio programado.",
    pendingPaymentTitle: "Esperando el pago",
    pendingPaymentBody:
      "Tu banco aún no ha completado el pago. El plan cambiará en cuanto lo haga; si no, nada cambia.",
    upgradeDoneTitle: (plan) => `${plan} está activo`,
    upgradeDoneBody: "El pago se completó y el nuevo plan ya está activo.",
    retry: "Reintentar",
    contactSupport: "Contactar con soporte",
    errors: {
      PLAN_CHANGE_NOT_SUPPORTED: "Ya tienes este plan.",
      NO_ACTIVE_SUBSCRIPTION:
        "No hay una suscripción que cambiar. Empieza una desde el plan que quieras.",
      SUBSCRIPTION_NOT_CHANGEABLE:
        "Ahora mismo no se puede cambiar tu suscripción: primero hay que resolver una factura impagada o un pago sin terminar. Soporte puede ayudarte.",
      BILLING_INTERVAL_CHANGE_NOT_SUPPORTED:
        "Todavía no se puede cambiar de plan y de periodicidad a la vez. Soporte puede hacerlo por ti.",
      SUBSCRIPTION_NOT_SINGLE_ITEM:
        "Tu suscripción tiene una estructura que esta pantalla no puede cambiar con seguridad. Soporte puede hacerlo.",
      PLAN_CHANGE_ALREADY_PENDING:
        "Un cambio anterior sigue esperando pago o verificación. Inténtalo de nuevo cuando termine.",
      PLAN_CHANGE_ALREADY_SCHEDULED:
        "Ya hay un cambio de plan programado. Cancélalo primero si quieres otro.",
      SUBSCRIPTION_SCHEDULE_CONFLICT:
        "Tu suscripción la controla una programación que esta pantalla no creó. Soporte puede revisarlo.",
      PLAN_CHANGE_BLOCKED_BY_CANCELLATION:
        "Tu suscripción ya termina al final de este periodo, así que no hay un periodo siguiente. Reactiva la renovación si quieres conservarla.",
      PLAN_CHANGE_PREVIEW_NOT_FOUND:
        "Ese presupuesto ya no está disponible. Empieza de nuevo para obtener uno actual.",
      PLAN_CHANGE_PREVIEW_EXPIRED:
        "El importe que mostramos ya no está vigente. Empieza de nuevo para ver el actual.",
      PLAN_CHANGE_PRICE_UNAVAILABLE:
        "El precio de ese plan no está disponible en tu moneda. Soporte puede ayudarte.",
      PLAN_CHANGE_ALREADY_APPLIED: "Ese cambio ya se aplicó.",
      NO_SCHEDULED_PLAN_CHANGE: "No hay ningún cambio programado que cancelar.",
      AUTHENTICATION_REQUIRED:
        "Tu sesión ha caducado. Inicia sesión de nuevo para continuar.",
      STRIPE_NOT_CONFIGURED:
        "Los pagos no están disponibles ahora mismo. Inténtalo más tarde.",
      STRIPE_ERROR:
        "El proveedor de pagos no pudo completar la operación. No se cobró nada.",
      NETWORK_ERROR:
        "No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.",
    },
  },
  pt: {
    upgradeTitle: (plan) => `Mudar para ${plan}`,
    downgradeTitle: (plan) => `Mudar para ${plan}`,
    close: "Fechar",
    loading: "A calcular o valor…",
    loadingStatus: "Estamos a consultar o valor desta alteração junto do fornecedor de pagamentos.",
    dueNow: "A pagar hoje",
    upgradeBody: (plan) =>
      `O valor acima é cobrado hoje. O ${plan} começa assim que o pagamento for concluído; se falhar ou exigir verificação adicional, mantém o plano atual e nada é cobrado.`,
    downgradeBody: (plan, date) =>
      `Mantém o plano atual até ${date}, sem reembolso do restante do período. O ${plan} começa nessa data e pode cancelar a qualquer momento antes.`,
    effectiveOn: (date) => `Entra em vigor a ${date}`,
    effectiveImmediately: "Entra em vigor assim que o pagamento for concluído",
    confirmUpgrade: (plan) => `Pagar e mudar para ${plan}`,
    confirmDowngrade: (plan) => `Agendar ${plan}`,
    working: "A processar…",
    resumeRenewalLabel: "Reativar também a renovação automática",
    resumeRenewalHint:
      "A sua subscrição está definida para terminar no fim deste período. Mudar de plano não altera isso por si só.",
    cancellationPreservedNotice:
      "A subscrição continua a terminar no fim deste período. Marque a opção acima se quiser que renove.",
    scheduledTitle: (plan) => `${plan} está agendado`,
    scheduledBody: (plan, date) =>
      `O ${plan} começa a ${date}. Até lá, nada muda no plano atual.`,
    cancelScheduled: "Cancelar esta alteração",
    cancelScheduledDone: "A alteração agendada foi cancelada.",
    pendingPaymentTitle: "A aguardar o pagamento",
    pendingPaymentBody:
      "O seu banco ainda não concluiu o pagamento. O plano muda assim que isso acontecer; caso contrário, nada muda.",
    upgradeDoneTitle: (plan) => `${plan} está ativo`,
    upgradeDoneBody: "O pagamento foi concluído e o novo plano está em vigor.",
    retry: "Tentar novamente",
    contactSupport: "Contactar o suporte",
    errors: {
      PLAN_CHANGE_NOT_SUPPORTED: "Já tem este plano.",
      NO_ACTIVE_SUBSCRIPTION:
        "Não há subscrição para alterar. Comece uma a partir do plano que pretende.",
      SUBSCRIPTION_NOT_CHANGEABLE:
        "A subscrição não pode ser alterada agora: é preciso resolver primeiro uma fatura por pagar ou um pagamento incompleto. O suporte pode ajudar.",
      BILLING_INTERVAL_CHANGE_NOT_SUPPORTED:
        "Ainda não é possível mudar de plano e de periodicidade ao mesmo tempo. O suporte trata disso por si.",
      SUBSCRIPTION_NOT_SINGLE_ITEM:
        "A sua subscrição tem uma estrutura que este ecrã não consegue alterar em segurança. O suporte pode fazê-lo.",
      PLAN_CHANGE_ALREADY_PENDING:
        "Uma alteração anterior ainda aguarda pagamento ou verificação. Tente de novo quando terminar.",
      PLAN_CHANGE_ALREADY_SCHEDULED:
        "Já existe uma alteração de plano agendada. Cancele-a primeiro se quiser outra.",
      SUBSCRIPTION_SCHEDULE_CONFLICT:
        "A subscrição está a ser controlada por um agendamento que este ecrã não criou. O suporte pode verificar.",
      PLAN_CHANGE_BLOCKED_BY_CANCELLATION:
        "A subscrição já termina no fim deste período, por isso não há período seguinte. Reative primeiro a renovação se quiser mantê-la.",
      PLAN_CHANGE_PREVIEW_NOT_FOUND:
        "Esse orçamento já não está disponível. Recomece para obter um novo.",
      PLAN_CHANGE_PREVIEW_EXPIRED:
        "O valor apresentado já não está atualizado. Recomece para ver o valor atual.",
      PLAN_CHANGE_PRICE_UNAVAILABLE:
        "O preço desse plano não está disponível na sua moeda. O suporte pode ajudar.",
      PLAN_CHANGE_ALREADY_APPLIED: "Essa alteração já entrou em vigor.",
      NO_SCHEDULED_PLAN_CHANGE: "Não há alterações agendadas para cancelar.",
      AUTHENTICATION_REQUIRED:
        "A sua sessão expirou. Inicie sessão novamente para continuar.",
      STRIPE_NOT_CONFIGURED:
        "Os pagamentos não estão disponíveis de momento. Tente mais tarde.",
      STRIPE_ERROR:
        "O fornecedor de pagamentos não conseguiu concluir a operação. Nada foi cobrado.",
      NETWORK_ERROR:
        "Não foi possível contactar o servidor. Verifique a ligação e tente novamente.",
    },
  },
};

export const planChangeText = (lang: string): PlanChangeCopy =>
  planChangeCopy[(lang as Language) in planChangeCopy ? (lang as Language) : "en"];

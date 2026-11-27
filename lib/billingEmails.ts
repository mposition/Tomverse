import "server-only";

import { EMAIL_FONT_STACK } from "@/lib/emailTypography";

type EmailLanguage = "en" | "ko" | "zh" | "fr" | "de" | "es" | "pt";

type RefundEmailInput = {
  to: string | null | undefined;
  plan: string | null | undefined;
  requestId: string;
  adminNote?: string | null;
  language?: string | null;
};


const appUrl = () =>
  process.env.PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://tomverse.app";

const normalizeLanguage = (value: string | null | undefined): EmailLanguage => {
  if (
    value === "ko" ||
    value === "zh" ||
    value === "fr" ||
    value === "de" ||
    value === "es" ||
    value === "pt"
  ) {
    return value;
  }
  return "en";
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * The period end a receipt quotes, resolved once at enqueue time.
 *
 * Exported because the resolution has to happen at the call site, not in the
 * renderer: the renderer runs again at drain time and possibly days later, and
 * a `new Date()` in there would make the delivered message differ from the one
 * that was queued -- breaking the idempotency key's payload match and the audit
 * reproduction with it (docs/policy/email-notifications.md §9.3, §10.3).
 * Resolved here and frozen into the
 * snapshot, it stays the date the purchase actually renews on.
 *
 * Stripe usually supplies it. The fallback covers the case where it does not,
 * and exists because a receipt reading "renewal date: not available" is worse
 * than one reading the date the interval implies.
 */
export const resolveBillingPeriodEnd = (
  periodEnd: Date | string | null | undefined,
  billingInterval: string | null | undefined,
  now = new Date()
): string =>
  (periodEnd
    ? new Date(periodEnd)
    : addBillingPeriod(now, billingInterval)
  ).toISOString();

const addBillingPeriod = (
  date: Date,
  billingInterval: string | null | undefined
) => {
  const next = new Date(date);
  if (billingInterval === "annual") {
    next.setUTCFullYear(next.getUTCFullYear() + 1);
  } else {
    next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next;
};

const localeForLanguage: Record<EmailLanguage, string> = {
  en: "en",
  ko: "ko-KR",
  zh: "zh-CN",
  fr: "fr-FR",
  de: "de-DE",
  es: "es-ES",
  pt: "pt-PT",
};

const emailCopy = {
  en: {
    billingLabel: "Tomverse Billing",
    openTomverse: "Open Tomverse",
    footer:
      "This message was sent about your Tomverse billing account. If you did not request this, contact support.",
    notAvailable: "Not available",
    interval: {
      annual: "Annual",
      monthly: "Monthly",
      subscription: "Subscription",
    },
    welcome: {
      subject: (plan: string) => `Welcome to Tomverse ${plan}`,
      title: "Welcome to Tomverse",
      text: (
        plan: string,
        billingInterval: string,
        periodEnd: string
      ) => [
        "Your Tomverse payment was successful.",
        "Welcome to the Tomverse family.",
        `Plan: ${plan}`,
        `Billing: ${billingInterval}`,
        `Plan valid until: ${periodEnd}`,
        "Checkout is charged in USD. You can manage your plan in Settings > Plan.",
      ],
      body: (plan: string, billingInterval: string, periodEnd: string) => `
        <p>Your payment was successful. Welcome to the Tomverse family.</p>
        <div style="margin:20px 0;padding:18px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#1e3a8a;">
          <div style="margin-bottom:8px;"><strong>Plan:</strong> ${plan}</div>
          <div style="margin-bottom:8px;"><strong>Billing:</strong> ${billingInterval}</div>
          <div><strong>Plan valid until:</strong> ${periodEnd}</div>
        </div>
        <p>You can now use the paid Tomverse workspace features included with your plan. Manage billing and plan details anytime from <strong>Settings &gt; Plan</strong>.</p>
        <p style="color:#6b7280;">Displayed local prices are converted for convenience. Checkout and billing are charged in USD.</p>
      `,
    },
    refundReceived: {
      subject: "We received your Tomverse refund request",
      title: "Refund request received",
      text: (plan: string, requestId: string) => [
        "We received your refund and plan cancellation request.",
        `Plan: ${plan}`,
        `Request ID: ${requestId}`,
        "Our team will review the request and notify you when a decision is made.",
      ],
      body: (plan: string, requestId: string) => `
        <p>We received your refund and plan cancellation request.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #e5e7eb;border-radius:14px;background:#f9fafb;">
          <div><strong>Plan:</strong> ${plan}</div>
          <div><strong>Request ID:</strong> ${requestId}</div>
        </div>
        <p>Our billing team will review the request and notify you when a decision is made. Your current plan remains active until the request is approved or your subscription changes.</p>
      `,
    },
    refundApproved: {
      subject: "Your Tomverse refund request was approved",
      title: "Refund request approved",
      text: (requestId: string, adminNote: string) => [
        "Your refund and plan cancellation request has been approved.",
        "Your Tomverse membership has been moved back to Free.",
        adminNote ? `Admin note: ${adminNote}` : "",
        `Request ID: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string) => `
        <p>Your refund and plan cancellation request has been approved.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
          <strong>Your Tomverse membership has been moved back to Free.</strong>
        </div>
        ${adminNote ? `<p><strong>Note from Tomverse:</strong> ${adminNote}</p>` : ""}
        <p>If a payment refund is applicable, processing time may depend on Stripe, your card issuer, Apple Pay, or Google Pay.</p>
        <p style="color:#6b7280;">Request ID: ${requestId}</p>
      `,
    },
    refundRejected: {
      subject: "Update on your Tomverse refund request",
      title: "Refund request reviewed",
      fallback: "Please contact support if you need more information about this decision.",
      text: (requestId: string, adminNote: string) => [
        "Your refund request has been reviewed.",
        adminNote || "Please contact support if you need more information.",
        `Request ID: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string, fallback: string) => `
        <p>Your refund request has been reviewed.</p>
        <p>${adminNote || fallback}</p>
        <p style="color:#6b7280;">Request ID: ${requestId}</p>
      `,
    },
  },
  ko: {
    billingLabel: "Tomverse 결제",
    openTomverse: "Tomverse 열기",
    footer:
      "이 메일은 Tomverse 결제 계정과 관련해 발송되었습니다. 직접 요청하지 않은 내용이라면 지원팀에 문의해 주세요.",
    notAvailable: "확인 불가",
    interval: { annual: "연간", monthly: "월간", subscription: "구독" },
    welcome: {
      subject: (plan: string) => `Tomverse ${plan} 플랜에 오신 것을 환영합니다`,
      title: "Tomverse에 오신 것을 환영합니다",
      text: (plan: string, billingInterval: string, periodEnd: string) => [
        "Tomverse 결제가 성공적으로 완료되었습니다.",
        "Tomverse의 새로운 가족이 되신 것을 환영합니다.",
        `플랜: ${plan}`,
        `결제 주기: ${billingInterval}`,
        `플랜 만료일: ${periodEnd}`,
        "결제는 USD로 청구됩니다. 설정 > 플랜에서 플랜을 관리할 수 있습니다.",
      ],
      body: (plan: string, billingInterval: string, periodEnd: string) => `
        <p>Tomverse 결제가 성공적으로 완료되었습니다. Tomverse의 새로운 가족이 되신 것을 환영합니다.</p>
        <div style="margin:20px 0;padding:18px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#1e3a8a;">
          <div style="margin-bottom:8px;"><strong>플랜:</strong> ${plan}</div>
          <div style="margin-bottom:8px;"><strong>결제 주기:</strong> ${billingInterval}</div>
          <div><strong>플랜 만료일:</strong> ${periodEnd}</div>
        </div>
        <p>이제 현재 플랜에 포함된 Tomverse의 유료 워크스페이스 기능을 사용할 수 있습니다. 결제와 플랜 정보는 언제든 <strong>설정 &gt; 플랜</strong>에서 확인하실 수 있습니다.</p>
        <p style="color:#6b7280;">현지 통화 가격은 참고용 환산 금액이며, 실제 결제와 청구는 USD 기준으로 처리됩니다.</p>
      `,
    },
    refundReceived: {
      subject: "Tomverse 환불 요청이 접수되었습니다",
      title: "환불 요청이 접수되었습니다",
      text: (plan: string, requestId: string) => [
        "환불 및 플랜 취소 요청이 접수되었습니다.",
        `플랜: ${plan}`,
        `요청 ID: ${requestId}`,
        "담당자가 요청을 검토한 뒤 결과를 안내해 드립니다.",
      ],
      body: (plan: string, requestId: string) => `
        <p>환불 및 플랜 취소 요청이 접수되었습니다.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #e5e7eb;border-radius:14px;background:#f9fafb;">
          <div><strong>플랜:</strong> ${plan}</div>
          <div><strong>요청 ID:</strong> ${requestId}</div>
        </div>
        <p>담당자가 요청을 검토한 뒤 결과를 안내해 드립니다. 승인되거나 구독 상태가 변경되기 전까지 현재 플랜은 유지됩니다.</p>
      `,
    },
    refundApproved: {
      subject: "Tomverse 환불 요청이 승인되었습니다",
      title: "환불 요청이 승인되었습니다",
      text: (requestId: string, adminNote: string) => [
        "환불 및 플랜 취소 요청이 승인되었습니다.",
        "Tomverse 멤버십이 Free 플랜으로 변경되었습니다.",
        adminNote ? `관리자 메모: ${adminNote}` : "",
        `요청 ID: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string) => `
        <p>환불 및 플랜 취소 요청이 승인되었습니다.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
          <strong>Tomverse 멤버십이 Free 플랜으로 변경되었습니다.</strong>
        </div>
        ${adminNote ? `<p><strong>Tomverse 메모:</strong> ${adminNote}</p>` : ""}
        <p>환불이 적용되는 경우, 처리 시간은 Stripe, 카드사, Apple Pay 또는 Google Pay 정책에 따라 달라질 수 있습니다.</p>
        <p style="color:#6b7280;">요청 ID: ${requestId}</p>
      `,
    },
    refundRejected: {
      subject: "Tomverse 환불 요청 검토 결과 안내",
      title: "환불 요청 검토가 완료되었습니다",
      fallback: "결정에 대해 추가 안내가 필요하시면 지원팀에 문의해 주세요.",
      text: (requestId: string, adminNote: string) => [
        "환불 요청 검토가 완료되었습니다.",
        adminNote || "추가 안내가 필요하시면 지원팀에 문의해 주세요.",
        `요청 ID: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string, fallback: string) => `
        <p>환불 요청 검토가 완료되었습니다.</p>
        <p>${adminNote || fallback}</p>
        <p style="color:#6b7280;">요청 ID: ${requestId}</p>
      `,
    },
  },
  zh: {
    billingLabel: "Tomverse 账单",
    openTomverse: "打开 Tomverse",
    footer:
      "此邮件与您的 Tomverse 账单账户有关。如果这不是您本人请求的操作，请联系支持团队。",
    notAvailable: "不可用",
    interval: { annual: "年度", monthly: "月度", subscription: "订阅" },
    welcome: {
      subject: (plan: string) => `欢迎使用 Tomverse ${plan}`,
      title: "欢迎使用 Tomverse",
      text: (plan: string, billingInterval: string, periodEnd: string) => [
        "您的 Tomverse 付款已成功完成。",
        "欢迎加入 Tomverse。",
        `套餐：${plan}`,
        `账单周期：${billingInterval}`,
        `套餐有效期至：${periodEnd}`,
        "结账将以 USD 收费。您可以在设置 > 套餐中管理订阅。",
      ],
      body: (plan: string, billingInterval: string, periodEnd: string) => `
        <p>您的付款已成功完成。欢迎加入 Tomverse。</p>
        <div style="margin:20px 0;padding:18px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#1e3a8a;">
          <div style="margin-bottom:8px;"><strong>套餐：</strong> ${plan}</div>
          <div style="margin-bottom:8px;"><strong>账单周期：</strong> ${billingInterval}</div>
          <div><strong>套餐有效期至：</strong> ${periodEnd}</div>
        </div>
        <p>您现在可以使用当前套餐包含的 Tomverse 付费工作区功能。您可以随时在 <strong>设置 &gt; 套餐</strong> 中管理账单和套餐信息。</p>
        <p style="color:#6b7280;">本地货币价格仅供参考，实际结账和账单均以 USD 收取。</p>
      `,
    },
    refundReceived: {
      subject: "我们已收到您的 Tomverse 退款请求",
      title: "退款请求已收到",
      text: (plan: string, requestId: string) => [
        "我们已收到您的退款和套餐取消请求。",
        `套餐：${plan}`,
        `请求 ID：${requestId}`,
        "我们的团队会审核请求，并在做出决定后通知您。",
      ],
      body: (plan: string, requestId: string) => `
        <p>我们已收到您的退款和套餐取消请求。</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #e5e7eb;border-radius:14px;background:#f9fafb;">
          <div><strong>套餐：</strong> ${plan}</div>
          <div><strong>请求 ID：</strong> ${requestId}</div>
        </div>
        <p>我们的账单团队会审核该请求并通知您。在请求获批或订阅状态变更之前，当前套餐仍会保持有效。</p>
      `,
    },
    refundApproved: {
      subject: "您的 Tomverse 退款请求已获批准",
      title: "退款请求已批准",
      text: (requestId: string, adminNote: string) => [
        "您的退款和套餐取消请求已获批准。",
        "您的 Tomverse 会员资格已切换回 Free。",
        adminNote ? `管理员备注：${adminNote}` : "",
        `请求 ID：${requestId}`,
      ],
      body: (requestId: string, adminNote: string) => `
        <p>您的退款和套餐取消请求已获批准。</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
          <strong>您的 Tomverse 会员资格已切换回 Free。</strong>
        </div>
        ${adminNote ? `<p><strong>Tomverse 备注：</strong> ${adminNote}</p>` : ""}
        <p>如适用退款，处理时间可能取决于 Stripe、发卡行、Apple Pay 或 Google Pay。</p>
        <p style="color:#6b7280;">请求 ID：${requestId}</p>
      `,
    },
    refundRejected: {
      subject: "您的 Tomverse 退款请求更新",
      title: "退款请求已审核",
      fallback: "如需了解更多信息，请联系支持团队。",
      text: (requestId: string, adminNote: string) => [
        "您的退款请求已审核。",
        adminNote || "如需了解更多信息，请联系支持团队。",
        `请求 ID：${requestId}`,
      ],
      body: (requestId: string, adminNote: string, fallback: string) => `
        <p>您的退款请求已审核。</p>
        <p>${adminNote || fallback}</p>
        <p style="color:#6b7280;">请求 ID：${requestId}</p>
      `,
    },
  },
  fr: {
    billingLabel: "Facturation Tomverse",
    openTomverse: "Ouvrir Tomverse",
    footer:
      "Ce message concerne votre compte de facturation Tomverse. Si vous n'êtes pas à l'origine de cette demande, contactez le support.",
    notAvailable: "Non disponible",
    interval: { annual: "Annuel", monthly: "Mensuel", subscription: "Abonnement" },
    welcome: {
      subject: (plan: string) => `Bienvenue sur Tomverse ${plan}`,
      title: "Bienvenue sur Tomverse",
      text: (plan: string, billingInterval: string, periodEnd: string) => [
        "Votre paiement Tomverse a bien été effectué.",
        "Bienvenue dans la famille Tomverse.",
        `Plan : ${plan}`,
        `Facturation : ${billingInterval}`,
        `Plan valable jusqu'au : ${periodEnd}`,
        "Le paiement est facturé en USD. Vous pouvez gérer votre plan dans Paramètres > Plan.",
      ],
      body: (plan: string, billingInterval: string, periodEnd: string) => `
        <p>Votre paiement a bien été effectué. Bienvenue dans la famille Tomverse.</p>
        <div style="margin:20px 0;padding:18px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#1e3a8a;">
          <div style="margin-bottom:8px;"><strong>Plan :</strong> ${plan}</div>
          <div style="margin-bottom:8px;"><strong>Facturation :</strong> ${billingInterval}</div>
          <div><strong>Plan valable jusqu'au :</strong> ${periodEnd}</div>
        </div>
        <p>Vous pouvez maintenant utiliser les fonctionnalités payantes incluses dans votre plan. Gérez vos informations de facturation depuis <strong>Paramètres &gt; Plan</strong>.</p>
        <p style="color:#6b7280;">Les prix locaux sont convertis à titre indicatif. Le paiement et la facturation sont effectués en USD.</p>
      `,
    },
    refundReceived: {
      subject: "Nous avons reçu votre demande de remboursement Tomverse",
      title: "Demande de remboursement reçue",
      text: (plan: string, requestId: string) => [
        "Nous avons reçu votre demande de remboursement et d'annulation de plan.",
        `Plan : ${plan}`,
        `ID de demande : ${requestId}`,
        "Notre équipe examinera la demande et vous informera de la décision.",
      ],
      body: (plan: string, requestId: string) => `
        <p>Nous avons reçu votre demande de remboursement et d'annulation de plan.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #e5e7eb;border-radius:14px;background:#f9fafb;">
          <div><strong>Plan :</strong> ${plan}</div>
          <div><strong>ID de demande :</strong> ${requestId}</div>
        </div>
        <p>Notre équipe de facturation examinera votre demande. Votre plan actuel reste actif jusqu'à l'approbation ou la modification de votre abonnement.</p>
      `,
    },
    refundApproved: {
      subject: "Votre demande de remboursement Tomverse a été approuvée",
      title: "Demande de remboursement approuvée",
      text: (requestId: string, adminNote: string) => [
        "Votre demande de remboursement et d'annulation de plan a été approuvée.",
        "Votre abonnement Tomverse est repassé au plan Free.",
        adminNote ? `Note : ${adminNote}` : "",
        `ID de demande : ${requestId}`,
      ],
      body: (requestId: string, adminNote: string) => `
        <p>Votre demande de remboursement et d'annulation de plan a été approuvée.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
          <strong>Votre abonnement Tomverse est repassé au plan Free.</strong>
        </div>
        ${adminNote ? `<p><strong>Note de Tomverse :</strong> ${adminNote}</p>` : ""}
        <p>Si un remboursement est applicable, le délai de traitement peut dépendre de Stripe, de votre banque, d’Apple Pay ou de Google Pay.</p>
        <p style="color:#6b7280;">ID de demande : ${requestId}</p>
      `,
    },
    refundRejected: {
      subject: "Mise à jour de votre demande de remboursement Tomverse",
      title: "Demande de remboursement examinée",
      fallback: "Contactez le support si vous souhaitez plus d'informations sur cette décision.",
      text: (requestId: string, adminNote: string) => [
        "Votre demande de remboursement a été examinée.",
        adminNote || "Contactez le support si vous souhaitez plus d'informations.",
        `ID de demande : ${requestId}`,
      ],
      body: (requestId: string, adminNote: string, fallback: string) => `
        <p>Votre demande de remboursement a été examinée.</p>
        <p>${adminNote || fallback}</p>
        <p style="color:#6b7280;">ID de demande : ${requestId}</p>
      `,
    },
  },
  de: {
    billingLabel: "Tomverse Abrechnung",
    openTomverse: "Tomverse öffnen",
    footer:
      "Diese Nachricht betrifft Ihr Tomverse Abrechnungskonto. Wenn Sie dies nicht angefordert haben, kontaktieren Sie bitte den Support.",
    notAvailable: "Nicht verfügbar",
    interval: { annual: "Jährlich", monthly: "Monatlich", subscription: "Abonnement" },
    welcome: {
      subject: (plan: string) => `Willkommen bei Tomverse ${plan}`,
      title: "Willkommen bei Tomverse",
      text: (plan: string, billingInterval: string, periodEnd: string) => [
        "Ihre Tomverse Zahlung war erfolgreich.",
        "Willkommen in der Tomverse Familie.",
        `Plan: ${plan}`,
        `Abrechnung: ${billingInterval}`,
        `Plan gültig bis: ${periodEnd}`,
        "Der Checkout wird in USD berechnet. Sie können Ihren Plan unter Einstellungen > Plan verwalten.",
      ],
      body: (plan: string, billingInterval: string, periodEnd: string) => `
        <p>Ihre Zahlung war erfolgreich. Willkommen in der Tomverse Familie.</p>
        <div style="margin:20px 0;padding:18px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#1e3a8a;">
          <div style="margin-bottom:8px;"><strong>Plan:</strong> ${plan}</div>
          <div style="margin-bottom:8px;"><strong>Abrechnung:</strong> ${billingInterval}</div>
          <div><strong>Plan gültig bis:</strong> ${periodEnd}</div>
        </div>
        <p>Sie können jetzt die bezahlten Workspace-Funktionen Ihres Plans nutzen. Abrechnung und Plan verwalten Sie jederzeit unter <strong>Einstellungen &gt; Plan</strong>.</p>
        <p style="color:#6b7280;">Lokale Preise werden nur zur Orientierung umgerechnet. Checkout und Abrechnung erfolgen in USD.</p>
      `,
    },
    refundReceived: {
      subject: "Wir haben Ihre Tomverse Rückerstattungsanfrage erhalten",
      title: "Rückerstattungsanfrage erhalten",
      text: (plan: string, requestId: string) => [
        "Wir haben Ihre Anfrage zur Rückerstattung und Kündigung des Plans erhalten.",
        `Plan: ${plan}`,
        `Anfrage-ID: ${requestId}`,
        "Unser Team prüft die Anfrage und informiert Sie über die Entscheidung.",
      ],
      body: (plan: string, requestId: string) => `
        <p>Wir haben Ihre Anfrage zur Rückerstattung und Kündigung des Plans erhalten.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #e5e7eb;border-radius:14px;background:#f9fafb;">
          <div><strong>Plan:</strong> ${plan}</div>
          <div><strong>Anfrage-ID:</strong> ${requestId}</div>
        </div>
        <p>Unser Abrechnungsteam prüft die Anfrage. Ihr aktueller Plan bleibt aktiv, bis die Anfrage genehmigt wird oder sich Ihr Abonnement ändert.</p>
      `,
    },
    refundApproved: {
      subject: "Ihre Tomverse Rückerstattungsanfrage wurde genehmigt",
      title: "Rückerstattungsanfrage genehmigt",
      text: (requestId: string, adminNote: string) => [
        "Ihre Anfrage zur Rückerstattung und Kündigung des Plans wurde genehmigt.",
        "Ihre Tomverse Mitgliedschaft wurde auf Free zurückgesetzt.",
        adminNote ? `Hinweis: ${adminNote}` : "",
        `Anfrage-ID: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string) => `
        <p>Ihre Anfrage zur Rückerstattung und Kündigung des Plans wurde genehmigt.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
          <strong>Ihre Tomverse Mitgliedschaft wurde auf Free zurückgesetzt.</strong>
        </div>
        ${adminNote ? `<p><strong>Hinweis von Tomverse:</strong> ${adminNote}</p>` : ""}
        <p>Falls eine Rückerstattung gilt, kann die Bearbeitungszeit von Stripe, Ihrer Bank, Apple Pay oder Google Pay abhängen.</p>
        <p style="color:#6b7280;">Anfrage-ID: ${requestId}</p>
      `,
    },
    refundRejected: {
      subject: "Update zu Ihrer Tomverse Rückerstattungsanfrage",
      title: "Rückerstattungsanfrage geprüft",
      fallback: "Bitte kontaktieren Sie den Support, wenn Sie weitere Informationen benötigen.",
      text: (requestId: string, adminNote: string) => [
        "Ihre Rückerstattungsanfrage wurde geprüft.",
        adminNote || "Bitte kontaktieren Sie den Support, wenn Sie weitere Informationen benötigen.",
        `Anfrage-ID: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string, fallback: string) => `
        <p>Ihre Rückerstattungsanfrage wurde geprüft.</p>
        <p>${adminNote || fallback}</p>
        <p style="color:#6b7280;">Anfrage-ID: ${requestId}</p>
      `,
    },
  },
  es: {
    billingLabel: "Facturación de Tomverse",
    openTomverse: "Abrir Tomverse",
    footer:
      "Este mensaje se envió sobre tu cuenta de facturación de Tomverse. Si no solicitaste esto, contacta con soporte.",
    notAvailable: "No disponible",
    interval: { annual: "Anual", monthly: "Mensual", subscription: "Suscripción" },
    welcome: {
      subject: (plan: string) => `Bienvenido a Tomverse ${plan}`,
      title: "Bienvenido a Tomverse",
      text: (plan: string, billingInterval: string, periodEnd: string) => [
        "Tu pago de Tomverse se completó correctamente.",
        "Bienvenido a la familia Tomverse.",
        `Plan: ${plan}`,
        `Facturación: ${billingInterval}`,
        `Plan válido hasta: ${periodEnd}`,
        "El checkout se cobra en USD. Puedes gestionar tu plan en Configuración > Plan.",
      ],
      body: (plan: string, billingInterval: string, periodEnd: string) => `
        <p>Tu pago se completó correctamente. Bienvenido a la familia Tomverse.</p>
        <div style="margin:20px 0;padding:18px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#1e3a8a;">
          <div style="margin-bottom:8px;"><strong>Plan:</strong> ${plan}</div>
          <div style="margin-bottom:8px;"><strong>Facturación:</strong> ${billingInterval}</div>
          <div><strong>Plan válido hasta:</strong> ${periodEnd}</div>
        </div>
        <p>Ya puedes usar las funciones de pago incluidas en tu plan. Gestiona la facturación y el plan desde <strong>Configuración &gt; Plan</strong>.</p>
        <p style="color:#6b7280;">Los precios locales son conversiones orientativas. El checkout y la facturación se cobran en USD.</p>
      `,
    },
    refundReceived: {
      subject: "Recibimos tu solicitud de reembolso de Tomverse",
      title: "Solicitud de reembolso recibida",
      text: (plan: string, requestId: string) => [
        "Recibimos tu solicitud de reembolso y cancelación del plan.",
        `Plan: ${plan}`,
        `ID de solicitud: ${requestId}`,
        "Nuestro equipo revisará la solicitud y te informará cuando haya una decisión.",
      ],
      body: (plan: string, requestId: string) => `
        <p>Recibimos tu solicitud de reembolso y cancelación del plan.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #e5e7eb;border-radius:14px;background:#f9fafb;">
          <div><strong>Plan:</strong> ${plan}</div>
          <div><strong>ID de solicitud:</strong> ${requestId}</div>
        </div>
        <p>Nuestro equipo de facturación revisará la solicitud. Tu plan actual seguirá activo hasta que se apruebe la solicitud o cambie la suscripción.</p>
      `,
    },
    refundApproved: {
      subject: "Tu solicitud de reembolso de Tomverse fue aprobada",
      title: "Solicitud de reembolso aprobada",
      text: (requestId: string, adminNote: string) => [
        "Tu solicitud de reembolso y cancelación del plan fue aprobada.",
        "Tu membresía de Tomverse volvió al plan Free.",
        adminNote ? `Nota: ${adminNote}` : "",
        `ID de solicitud: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string) => `
        <p>Tu solicitud de reembolso y cancelación del plan fue aprobada.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
          <strong>Tu membresía de Tomverse volvió al plan Free.</strong>
        </div>
        ${adminNote ? `<p><strong>Nota de Tomverse:</strong> ${adminNote}</p>` : ""}
        <p>Si corresponde un reembolso, el tiempo de procesamiento puede depender de Stripe, tu banco, Apple Pay o Google Pay.</p>
        <p style="color:#6b7280;">ID de solicitud: ${requestId}</p>
      `,
    },
    refundRejected: {
      subject: "Actualización sobre tu solicitud de reembolso de Tomverse",
      title: "Solicitud de reembolso revisada",
      fallback: "Contacta con soporte si necesitas más información sobre esta decisión.",
      text: (requestId: string, adminNote: string) => [
        "Tu solicitud de reembolso fue revisada.",
        adminNote || "Contacta con soporte si necesitas más información.",
        `ID de solicitud: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string, fallback: string) => `
        <p>Tu solicitud de reembolso fue revisada.</p>
        <p>${adminNote || fallback}</p>
        <p style="color:#6b7280;">ID de solicitud: ${requestId}</p>
      `,
    },
  },
  pt: {
    billingLabel: "Cobrança Tomverse",
    openTomverse: "Abrir Tomverse",
    footer:
      "Esta mensagem foi enviada sobre a sua conta de cobrança Tomverse. Se não solicitou isto, contacte o suporte.",
    notAvailable: "Indisponível",
    interval: { annual: "Anual", monthly: "Mensal", subscription: "Subscrição" },
    welcome: {
      subject: (plan: string) => `Bem-vindo ao Tomverse ${plan}`,
      title: "Bem-vindo ao Tomverse",
      text: (plan: string, billingInterval: string, periodEnd: string) => [
        "O seu pagamento Tomverse foi concluído com sucesso.",
        "Bem-vindo à família Tomverse.",
        `Plano: ${plan}`,
        `Cobrança: ${billingInterval}`,
        `Plano válido até: ${periodEnd}`,
        "O checkout é cobrado em USD. Pode gerir o plano em Definições > Plano.",
      ],
      body: (plan: string, billingInterval: string, periodEnd: string) => `
        <p>O seu pagamento foi concluído com sucesso. Bem-vindo à família Tomverse.</p>
        <div style="margin:20px 0;padding:18px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#1e3a8a;">
          <div style="margin-bottom:8px;"><strong>Plano:</strong> ${plan}</div>
          <div style="margin-bottom:8px;"><strong>Cobrança:</strong> ${billingInterval}</div>
          <div><strong>Plano válido até:</strong> ${periodEnd}</div>
        </div>
        <p>Já pode usar as funcionalidades pagas incluídas no seu plano. Gerencie cobrança e plano em <strong>Definições &gt; Plano</strong>.</p>
        <p style="color:#6b7280;">Os preços locais são convertidos apenas como referência. O checkout e a cobrança são feitos em USD.</p>
      `,
    },
    refundReceived: {
      subject: "Recebemos o seu pedido de reembolso Tomverse",
      title: "Pedido de reembolso recebido",
      text: (plan: string, requestId: string) => [
        "Recebemos o seu pedido de reembolso e cancelamento do plano.",
        `Plano: ${plan}`,
        `ID do pedido: ${requestId}`,
        "A nossa equipa irá analisar o pedido e avisá-lo quando houver uma decisão.",
      ],
      body: (plan: string, requestId: string) => `
        <p>Recebemos o seu pedido de reembolso e cancelamento do plano.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #e5e7eb;border-radius:14px;background:#f9fafb;">
          <div><strong>Plano:</strong> ${plan}</div>
          <div><strong>ID do pedido:</strong> ${requestId}</div>
        </div>
        <p>A nossa equipa de cobrança irá analisar o pedido. O plano atual permanece ativo até o pedido ser aprovado ou a subscrição mudar.</p>
      `,
    },
    refundApproved: {
      subject: "O seu pedido de reembolso Tomverse foi aprovado",
      title: "Pedido de reembolso aprovado",
      text: (requestId: string, adminNote: string) => [
        "O seu pedido de reembolso e cancelamento do plano foi aprovado.",
        "A sua subscrição Tomverse voltou para o plano Free.",
        adminNote ? `Nota: ${adminNote}` : "",
        `ID do pedido: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string) => `
        <p>O seu pedido de reembolso e cancelamento do plano foi aprovado.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
          <strong>A sua subscrição Tomverse voltou para o plano Free.</strong>
        </div>
        ${adminNote ? `<p><strong>Nota da Tomverse:</strong> ${adminNote}</p>` : ""}
        <p>Se houver reembolso aplicável, o tempo de processamento pode depender da Stripe, do emissor do cartão, Apple Pay ou Google Pay.</p>
        <p style="color:#6b7280;">ID do pedido: ${requestId}</p>
      `,
    },
    refundRejected: {
      subject: "Atualização sobre o seu pedido de reembolso Tomverse",
      title: "Pedido de reembolso analisado",
      fallback: "Contacte o suporte se precisar de mais informações sobre esta decisão.",
      text: (requestId: string, adminNote: string) => [
        "O seu pedido de reembolso foi analisado.",
        adminNote || "Contacte o suporte se precisar de mais informações.",
        `ID do pedido: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string, fallback: string) => `
        <p>O seu pedido de reembolso foi analisado.</p>
        <p>${adminNote || fallback}</p>
        <p style="color:#6b7280;">ID do pedido: ${requestId}</p>
      `,
    },
  },
} as const;

const getCopy = (language: string | null | undefined) =>
  emailCopy[normalizeLanguage(language)];

const formatDate = (
  value: Date | string | null | undefined,
  language: EmailLanguage
) => {
  const copy = emailCopy[language];
  if (!value) return copy.notAvailable;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return copy.notAvailable;
  return new Intl.DateTimeFormat(localeForLanguage[language], {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
};

const formatBillingInterval = (
  value: string | null | undefined,
  language: EmailLanguage
) => {
  const copy = emailCopy[language];
  if (value === "annual") return copy.interval.annual;
  if (value === "monthly") return copy.interval.monthly;
  return copy.interval.subscription;
};

const shell = (title: string, body: string, language: EmailLanguage) => {
  const copy = emailCopy[language];
  return `
  <div style="margin:0;padding:0;background:#f4f6fb;font-family:${EMAIL_FONT_STACK};color:#111827;">
    <div style="max-width:640px;margin:0 auto;padding:32px 18px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:20px;overflow:hidden;">
        <div style="padding:28px 30px;background:#0b1020;color:#ffffff;">
          <div style="font-size:12px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#93c5fd;">${copy.billingLabel}</div>
          <h1 style="margin:12px 0 0;font-size:28px;line-height:1.2;">${title}</h1>
        </div>
        <div style="padding:30px;color:#374151;font-size:15px;line-height:1.7;">
          ${body}
          <p style="margin-top:28px;">
            <a href="${appUrl()}/chat" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;border-radius:12px;padding:12px 18px;">${copy.openTomverse}</a>
          </p>
        </div>
      </div>
      <p style="margin:18px 4px 0;color:#6b7280;font-size:12px;line-height:1.6;">
        ${copy.footer}
      </p>
    </div>
  </div>
`;
};

export function buildBillingWelcomeEmail(input: {
  plan: string | null | undefined;
  billingInterval?: string | null;
  /** ISO string, never a Date: the snapshot has to survive JSON. */
  periodEnd?: string | null;
  language?: string | null;
}) {
  const language = normalizeLanguage(input.language);
  const copy = getCopy(input.language);
  const plan = escapeHtml(input.plan || "Tomverse");
  const billingInterval = formatBillingInterval(input.billingInterval, language);
  // Resolved by the caller, never here: `new Date()` inside a renderer makes
  // the drain render something different from the enqueue, which breaks both
  // the idempotency key and the audit reproduction
  // (docs/policy/email-notifications.md §9.3, §10.3).
  const periodEnd = formatDate(input.periodEnd ?? null, language);
  return {
    subject: copy.welcome.subject(plan),
    text: copy.welcome.text(plan, billingInterval, periodEnd).join("\n"),
    html: shell(
      copy.welcome.title,
      copy.welcome.body(plan, billingInterval, periodEnd),
      language
    ),
  };
}


const foundingTesterPassCopy: Record<
  EmailLanguage,
  {
    startedSubject: string;
    startedTitle: string;
    startedBody: (periodEnd: string) => string;
    reminderSubject: string;
    reminderTitle: string;
    reminderBody: (periodEnd: string) => string;
    endedSubject: string;
    endedTitle: string;
    endedBody: string;
    noRenewal: string;
    upgrade: string;
  }
> = {
  en: {
    startedSubject: "Your 60-day Tomverse Founding Tester Pass is active",
    startedTitle: "Founding Tester Pass activated",
    startedBody: (periodEnd) =>
      `Your Pro access is active until ${periodEnd}. No payment method was collected and this pass will not renew automatically.`,
    reminderSubject: "Your Founding Tester Pass ends in 7 days",
    reminderTitle: "Seven days of Pro access remain",
    reminderBody: (periodEnd) =>
      `Your Founding Tester Pass ends on ${periodEnd}. After that, your account returns to Free unless you choose a paid plan.`,
    endedSubject: "Your Founding Tester Pass has ended",
    endedTitle: "Your account has returned to Free",
    endedBody:
      "Your complimentary Pro access has ended. Your account and conversations remain available on the Free plan.",
    noRenewal: "There is no automatic renewal or charge.",
    upgrade: "View Pro and Max plans",
  },
  ko: {
    startedSubject: "Tomverse Founding Tester Pass 60일 혜택이 시작되었습니다",
    startedTitle: "Founding Tester Pass가 활성화되었습니다",
    startedBody: (periodEnd) =>
      `Pro 이용 권한은 ${periodEnd}까지 유지됩니다. 결제수단은 등록되지 않았으며 자동으로 유료 갱신되지 않습니다.`,
    reminderSubject: "Founding Tester Pass가 7일 후 종료됩니다",
    reminderTitle: "Pro 이용 기간이 7일 남았습니다",
    reminderBody: (periodEnd) =>
      `Founding Tester Pass는 ${periodEnd}에 종료됩니다. 유료 플랜을 선택하지 않으면 이후 Free 플랜으로 전환됩니다.`,
    endedSubject: "Founding Tester Pass가 종료되었습니다",
    endedTitle: "계정이 Free 플랜으로 전환되었습니다",
    endedBody:
      "무료로 제공된 Pro 이용 기간이 종료되었습니다. 계정과 기존 대화는 Free 플랜에서 계속 이용할 수 있습니다.",
    noRenewal: "자동 갱신이나 자동 결제는 없습니다.",
    upgrade: "Pro 및 Max 플랜 보기",
  },
  zh: {
    startedSubject: "您的 Tomverse 60 天创始测试通行证已生效",
    startedTitle: "创始测试通行证已激活",
    startedBody: (periodEnd) =>
      `Pro 权限有效至 ${periodEnd}。我们未收集付款方式，此通行证不会自动续费。`,
    reminderSubject: "您的创始测试通行证将在 7 天后结束",
    reminderTitle: "Pro 权限还剩 7 天",
    reminderBody: (periodEnd) =>
      `通行证将于 ${periodEnd}结束。若不选择付费方案，账户随后将恢复为 Free。`,
    endedSubject: "您的创始测试通行证已结束",
    endedTitle: "您的账户已恢复为 Free",
    endedBody: "赠送的 Pro 权限已结束，您的账户和对话仍可在 Free 方案中使用。",
    noRenewal: "不会自动续费或扣款。",
    upgrade: "查看 Pro 和 Max 方案",
  },
  fr: {
    startedSubject: "Votre pass testeur fondateur Tomverse de 60 jours est actif",
    startedTitle: "Pass testeur fondateur activé",
    startedBody: (periodEnd) =>
      `Votre accès Pro est actif jusqu’au ${periodEnd}. Aucun moyen de paiement n’a été enregistré et le pass ne se renouvelle pas automatiquement.`,
    reminderSubject: "Votre pass testeur fondateur se termine dans 7 jours",
    reminderTitle: "Il reste sept jours d’accès Pro",
    reminderBody: (periodEnd) =>
      `Le pass se termine le ${periodEnd}. Votre compte repassera ensuite à Free sauf si vous choisissez une offre payante.`,
    endedSubject: "Votre pass testeur fondateur est terminé",
    endedTitle: "Votre compte est repassé à Free",
    endedBody:
      "Votre accès Pro offert est terminé. Votre compte et vos conversations restent disponibles avec l’offre Free.",
    noRenewal: "Aucun renouvellement ni prélèvement automatique.",
    upgrade: "Voir les offres Pro et Max",
  },
  de: {
    startedSubject: "Ihr 60-tägiger Tomverse Founding Tester Pass ist aktiv",
    startedTitle: "Founding Tester Pass aktiviert",
    startedBody: (periodEnd) =>
      `Ihr Pro-Zugang ist bis ${periodEnd} aktiv. Es wurde keine Zahlungsmethode hinterlegt und der Pass verlängert sich nicht automatisch.`,
    reminderSubject: "Ihr Founding Tester Pass endet in 7 Tagen",
    reminderTitle: "Noch sieben Tage Pro-Zugang",
    reminderBody: (periodEnd) =>
      `Der Pass endet am ${periodEnd}. Danach wird Ihr Konto auf Free zurückgesetzt, sofern Sie keinen kostenpflichtigen Tarif wählen.`,
    endedSubject: "Ihr Founding Tester Pass ist beendet",
    endedTitle: "Ihr Konto wurde auf Free zurückgesetzt",
    endedBody:
      "Ihr kostenloser Pro-Zugang ist beendet. Konto und Unterhaltungen bleiben im Free-Tarif verfügbar.",
    noRenewal: "Keine automatische Verlängerung oder Belastung.",
    upgrade: "Pro- und Max-Tarife ansehen",
  },
  es: {
    startedSubject: "Tu pase Tomverse Founding Tester de 60 días está activo",
    startedTitle: "Pase Founding Tester activado",
    startedBody: (periodEnd) =>
      `Tu acceso Pro está activo hasta el ${periodEnd}. No se registró ningún método de pago y el pase no se renovará automáticamente.`,
    reminderSubject: "Tu pase Founding Tester termina en 7 días",
    reminderTitle: "Quedan siete días de acceso Pro",
    reminderBody: (periodEnd) =>
      `El pase termina el ${periodEnd}. Después, tu cuenta volverá a Free salvo que elijas un plan de pago.`,
    endedSubject: "Tu pase Founding Tester ha terminado",
    endedTitle: "Tu cuenta ha vuelto a Free",
    endedBody:
      "Tu acceso Pro gratuito ha terminado. Tu cuenta y conversaciones siguen disponibles en el plan Free.",
    noRenewal: "No hay renovación ni cobro automático.",
    upgrade: "Ver planes Pro y Max",
  },
  pt: {
    startedSubject: "O seu passe Tomverse Founding Tester de 60 dias está ativo",
    startedTitle: "Passe Founding Tester ativado",
    startedBody: (periodEnd) =>
      `O acesso Pro está ativo até ${periodEnd}. Nenhum método de pagamento foi registado e o passe não será renovado automaticamente.`,
    reminderSubject: "O seu passe Founding Tester termina em 7 dias",
    reminderTitle: "Restam sete dias de acesso Pro",
    reminderBody: (periodEnd) =>
      `O passe termina em ${periodEnd}. Depois disso, a conta regressa ao Free, salvo se escolher um plano pago.`,
    endedSubject: "O seu passe Founding Tester terminou",
    endedTitle: "A sua conta regressou ao Free",
    endedBody:
      "O acesso Pro gratuito terminou. A conta e as conversas continuam disponíveis no plano Free.",
    noRenewal: "Não existe renovação nem cobrança automática.",
    upgrade: "Ver planos Pro e Max",
  },
};

export type FoundingTesterPassPhase = "started" | "reminder" | "ended";

/**
 * Renders one of the three Founding Tester Pass notices without sending it.
 *
 * Pure, and taking the period end as a string rather than a Date, because the
 * standard lane re-renders from the stored snapshot on every attempt and the
 * snapshot is JSON. A Date would not survive the round trip, and a clock read
 * in here would make a retry produce different bytes -- which stops the
 * provider's idempotency key from recognising the retry as the same message
 * (docs/policy/email-notifications.md §9.3, §10.3).
 */
export function buildFoundingTesterPassEmail(
  phase: FoundingTesterPassPhase,
  input: { periodEnd: string | null; language?: string | null }
) {
  const language = normalizeLanguage(input.language);
  const copy = foundingTesterPassCopy[language];
  const periodEnd = formatDate(input.periodEnd, language);
  const subject =
    phase === "started"
      ? copy.startedSubject
      : phase === "reminder"
        ? copy.reminderSubject
        : copy.endedSubject;
  const title =
    phase === "started"
      ? copy.startedTitle
      : phase === "reminder"
        ? copy.reminderTitle
        : copy.endedTitle;
  const body =
    phase === "started"
      ? copy.startedBody(periodEnd)
      : phase === "reminder"
        ? copy.reminderBody(periodEnd)
        : copy.endedBody;
  const pricingLink = `${appUrl()}/pricing?lang=${language}`;
  const text = [body, copy.noRenewal, `${copy.upgrade}: ${pricingLink}`].join("\n");
  const html = shell(
    title,
    `<p>${escapeHtml(body)}</p>
     <p><strong>${escapeHtml(copy.noRenewal)}</strong></p>
     <p><a href="${pricingLink}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;border-radius:12px;padding:12px 18px;">${escapeHtml(copy.upgrade)}</a></p>`,
    language
  );
  return { subject, text, html };
}

export type RefundEmailStage = "received" | "approved" | "rejected";

/**
 * Renders a refund email without sending it.
 *
 * Split out from the senders below because these three are now delivered
 * through the notification retry queue, which re-renders from the stored
 * RefundRequest at send time. Building the message in one place is what keeps
 * a retried mail identical to the original -- which the provider's idempotency
 * key requires, and which is what stops a retry becoming a duplicate.
 */
export function buildRefundRequestEmail(
  stage: RefundEmailStage,
  input: RefundEmailInput
) {
  const language = normalizeLanguage(input.language);
  const copy = getCopy(input.language);
  const requestId = escapeHtml(input.requestId);

  if (stage === "received") {
    const plan = escapeHtml(input.plan || "paid");
    return {
      subject: copy.refundReceived.subject,
      text: copy.refundReceived.text(plan, requestId).join("\n"),
      html: shell(
        copy.refundReceived.title,
        copy.refundReceived.body(plan, requestId),
        language
      ),
    };
  }

  const adminNote = input.adminNote ? escapeHtml(input.adminNote) : "";
  if (stage === "approved") {
    return {
      subject: copy.refundApproved.subject,
      text: copy.refundApproved
        .text(input.requestId, input.adminNote || "")
        .filter(Boolean)
        .join("\n"),
      html: shell(
        copy.refundApproved.title,
        copy.refundApproved.body(requestId, adminNote),
        language
      ),
    };
  }

  return {
    subject: copy.refundRejected.subject,
    text: copy.refundRejected
      .text(input.requestId, input.adminNote || "")
      .join("\n"),
    html: shell(
      copy.refundRejected.title,
      copy.refundRejected.body(requestId, adminNote, copy.refundRejected.fallback),
      language
    ),
  };
}

/**
 * Renders the notice that an operator changed somebody's plan by hand.
 *
 * English only, and deliberately not taking the account's language: the copy
 * has never been translated, so passing one would stamp a delivery row with a
 * language it does not render in and put that untruth in the audit record.
 * Translating it is its own decision, not part of moving the send onto the
 * queue.
 */
export function buildAdminPlanChangedEmail(input: {
  plan: string | null | undefined;
  periodEnd?: string | null;
  billingInterval?: string | null;
  reason?: string | null;
}) {
  const plan = escapeHtml(input.plan || "Free");
  const periodEnd = formatDate(input.periodEnd, "en");
  const billingInterval = escapeHtml(input.billingInterval || "manual update");
  const reason = input.reason ? escapeHtml(input.reason) : "";
  const subject = `Your Tomverse plan was updated to ${plan}`;
  const text = [
    `Your Tomverse plan was updated to ${plan}.`,
    `Billing: ${billingInterval}`,
    `Plan valid until: ${periodEnd}`,
    reason ? `Reason: ${reason}` : "",
    "You can review the current plan from Settings > Plan.",
  ]
    .filter(Boolean)
    .join("\n");
  const html = shell(
    "Your Tomverse plan was updated",
    `
      <p>Your Tomverse plan was updated by the Tomverse team.</p>
      <div style="margin:20px 0;padding:18px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#1e3a8a;">
        <div style="margin-bottom:8px;"><strong>Plan:</strong> ${plan}</div>
        <div style="margin-bottom:8px;"><strong>Billing:</strong> ${billingInterval}</div>
        <div><strong>Plan valid until:</strong> ${periodEnd}</div>
      </div>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
      <p>You can review the current plan from <strong>Settings &gt; Plan</strong>.</p>
    `,
    "en"
  );
  return { subject, text, html };
}

/**
 * The two plan-change confirmations (docs/policy/plan-change.md section 9).
 *
 * Two phases rather than one message with a direction field, for the same
 * reason the pass notices are three keys: a TemplateVersion hashes one
 * message's copy, and the audit reproduction has to be able to say which of
 * the two a delivery was. Both use the billing welcome email's shell and box,
 * so a plan change reads like the receipt it follows.
 */
export type PlanChangeEmailPhase = "upgraded" | "downgrade_scheduled";

type PlanChangeEmailCopy = {
  fromLabel: string;
  toLabel: string;
  billingLabel: string;
  upgraded: {
    subject: (plan: string) => string;
    title: string;
    intro: string;
    dateLabel: string;
    note: string;
  };
  downgradeScheduled: {
    subject: (plan: string) => string;
    title: string;
    intro: (fromPlan: string, date: string) => string;
    dateLabel: string;
    note: (date: string) => string;
  };
};

const planChangeEmailCopy: Record<EmailLanguage, PlanChangeEmailCopy> = {
  en: {
    fromLabel: "Previous plan",
    toLabel: "New plan",
    billingLabel: "Billing",
    upgraded: {
      subject: (plan) => `Your Tomverse plan is now ${plan}`,
      title: "Your plan has been upgraded",
      intro: "The payment for your plan change was successful, and the new plan is active on your account now.",
      dateLabel: "Current billing period ends",
      note: "Your billing period has not changed. This month's plan credit limit is now the new plan's limit; credits you already used this month still count, and purchased credits are unchanged.",
    },
    downgradeScheduled: {
      subject: (plan) => `Your change to Tomverse ${plan} is scheduled`,
      title: "Your plan change is scheduled",
      intro: (fromPlan, date) => `You keep ${fromPlan} until the end of your current billing period. The new plan starts on ${date}.`,
      dateLabel: "Change takes effect",
      note: (date) => `There is no charge or refund for this change. You can cancel it from Settings > Plan before ${date}.`,
    },
  },
  ko: {
    fromLabel: "이전 플랜",
    toLabel: "새 플랜",
    billingLabel: "결제 주기",
    upgraded: {
      subject: (plan) => `Tomverse ${plan} 플랜으로 변경되었습니다`,
      title: "플랜이 업그레이드되었습니다",
      intro: "플랜 변경 결제가 완료되어 지금부터 새 플랜을 이용하실 수 있습니다.",
      dateLabel: "현재 결제기간 종료일",
      note: "결제기간은 그대로입니다. 이번 달 플랜 크레딧 한도는 새 플랜 기준으로 바뀌며, 이번 달에 이미 사용한 크레딧은 그대로 반영됩니다. 구매한 추가 크레딧은 변동이 없습니다.",
    },
    downgradeScheduled: {
      subject: (plan) => `Tomverse ${plan} 플랜으로 변경이 예약되었습니다`,
      title: "플랜 변경이 예약되었습니다",
      intro: (fromPlan, date) => `현재 결제기간이 끝날 때까지 ${fromPlan} 플랜이 유지되고, ${date}부터 새 플랜이 적용됩니다.`,
      dateLabel: "적용일",
      note: (date) => `이 변경에는 추가 결제나 환불이 없습니다. ${date} 전까지 설정 > 플랜에서 예약을 취소할 수 있습니다.`,
    },
  },
  zh: {
    fromLabel: "原套餐",
    toLabel: "新套餐",
    billingLabel: "计费周期",
    upgraded: {
      subject: (plan) => `您的 Tomverse 套餐已变更为 ${plan}`,
      title: "套餐已升级",
      intro: "套餐变更付款已成功，新套餐现已在您的账户中生效。",
      dateLabel: "当前计费周期结束日",
      note: "计费周期保持不变。本月套餐积分额度已改为新套餐的额度；本月已使用的积分仍计入，已购买的积分不变。",
    },
    downgradeScheduled: {
      subject: (plan) => `已预约变更为 Tomverse ${plan}`,
      title: "套餐变更已预约",
      intro: (fromPlan, date) => `在当前计费周期结束前，您将继续使用 ${fromPlan}。新套餐将于 ${date} 开始生效。`,
      dateLabel: "生效日期",
      note: (date) => `此次变更不会产生额外费用或退款。您可以在 ${date} 之前于“设置 > 套餐”中取消此预约。`,
    },
  },
  fr: {
    fromLabel: "Ancienne formule",
    toLabel: "Nouvelle formule",
    billingLabel: "Facturation",
    upgraded: {
      subject: (plan) => `Votre formule Tomverse est désormais ${plan}`,
      title: "Votre formule a été mise à niveau",
      intro: "Le paiement de votre changement de formule a réussi et la nouvelle formule est active dès maintenant sur votre compte.",
      dateLabel: "Fin de la période de facturation",
      note: "Votre période de facturation ne change pas. La limite de crédits du mois en cours correspond désormais à la nouvelle formule ; les crédits déjà utilisés ce mois-ci restent comptés et vos crédits achetés ne changent pas.",
    },
    downgradeScheduled: {
      subject: (plan) => `Votre passage à Tomverse ${plan} est programmé`,
      title: "Votre changement de formule est programmé",
      intro: (fromPlan, date) => `Vous conservez ${fromPlan} jusqu'à la fin de votre période de facturation actuelle. La nouvelle formule commence le ${date}.`,
      dateLabel: "Date d'effet",
      note: (date) => `Ce changement n'entraîne ni frais ni remboursement. Vous pouvez l'annuler depuis Paramètres > Formule avant le ${date}.`,
    },
  },
  de: {
    fromLabel: "Bisheriger Tarif",
    toLabel: "Neuer Tarif",
    billingLabel: "Abrechnung",
    upgraded: {
      subject: (plan) => `Ihr Tomverse-Tarif ist jetzt ${plan}`,
      title: "Ihr Tarif wurde hochgestuft",
      intro: "Die Zahlung für Ihren Tarifwechsel war erfolgreich, und der neue Tarif ist ab sofort in Ihrem Konto aktiv.",
      dateLabel: "Ende des Abrechnungszeitraums",
      note: "Ihr Abrechnungszeitraum bleibt gleich. Das Credit-Limit dieses Monats entspricht jetzt dem neuen Tarif; bereits in diesem Monat verbrauchte Credits zählen weiterhin, gekaufte Credits bleiben unverändert.",
    },
    downgradeScheduled: {
      subject: (plan) => `Ihr Wechsel zu Tomverse ${plan} ist geplant`,
      title: "Ihr Tarifwechsel ist geplant",
      intro: (fromPlan, date) => `Sie behalten ${fromPlan} bis zum Ende Ihres aktuellen Abrechnungszeitraums. Der neue Tarif beginnt am ${date}.`,
      dateLabel: "Wirksam ab",
      note: (date) => `Für diesen Wechsel fallen weder Kosten noch Erstattungen an. Sie können ihn vor dem ${date} unter Einstellungen > Tarif stornieren.`,
    },
  },
  es: {
    fromLabel: "Plan anterior",
    toLabel: "Plan nuevo",
    billingLabel: "Facturación",
    upgraded: {
      subject: (plan) => `Su plan de Tomverse ahora es ${plan}`,
      title: "Su plan se ha mejorado",
      intro: "El pago del cambio de plan se realizó correctamente y el nuevo plan ya está activo en su cuenta.",
      dateLabel: "Fin del período de facturación",
      note: "Su período de facturación no cambia. El límite de créditos de este mes pasa a ser el del nuevo plan; los créditos que ya usó este mes siguen contando y los créditos comprados no cambian.",
    },
    downgradeScheduled: {
      subject: (plan) => `Su cambio a Tomverse ${plan} está programado`,
      title: "Su cambio de plan está programado",
      intro: (fromPlan, date) => `Conservará ${fromPlan} hasta el final de su período de facturación actual. El nuevo plan comienza el ${date}.`,
      dateLabel: "Fecha de entrada en vigor",
      note: (date) => `Este cambio no tiene cargos ni reembolsos. Puede cancelarlo desde Configuración > Plan antes del ${date}.`,
    },
  },
  pt: {
    fromLabel: "Plano anterior",
    toLabel: "Plano novo",
    billingLabel: "Faturação",
    upgraded: {
      subject: (plan) => `O seu plano Tomverse é agora ${plan}`,
      title: "O seu plano foi melhorado",
      intro: "O pagamento da alteração de plano foi concluído e o novo plano já está ativo na sua conta.",
      dateLabel: "Fim do período de faturação",
      note: "O seu período de faturação não muda. O limite de créditos deste mês passa a ser o do novo plano; os créditos já usados este mês continuam a contar e os créditos comprados não mudam.",
    },
    downgradeScheduled: {
      subject: (plan) => `A sua mudança para Tomverse ${plan} está agendada`,
      title: "A sua alteração de plano está agendada",
      intro: (fromPlan, date) => `Mantém o ${fromPlan} até ao fim do seu período de faturação atual. O novo plano começa a ${date}.`,
      dateLabel: "Data de entrada em vigor",
      note: (date) => `Esta alteração não tem custos nem reembolsos. Pode cancelá-la em Definições > Plano antes de ${date}.`,
    },
  },
};

const PLAN_CHANGE_EMAIL_COPY = new Map(
  Object.entries(planChangeEmailCopy) as [EmailLanguage, PlanChangeEmailCopy][]
);

export function buildPlanChangeEmail(
  phase: PlanChangeEmailPhase,
  input: {
    fromPlan: string | null | undefined;
    toPlan: string | null | undefined;
    billingInterval?: string | null;
    /**
     * ISO string resolved by the caller: the current period end for an upgrade (it may not renew), the
     * date the scheduled plan starts for a downgrade. Never `new Date()` here
     * (docs/policy/email-notifications.md §9.3).
     */
    effectiveAt?: string | null;
    language?: string | null;
  }
) {
  const language = normalizeLanguage(input.language);
  // A Map lookup, not a computed index: the language is already normalised
  // and every language has copy, so `en` is only the type's fallback.
  const copy = PLAN_CHANGE_EMAIL_COPY.get(language) ?? planChangeEmailCopy.en;
  // Raw in the text part and inside the sentences (each sentence is escaped
  // once, as a whole, for the HTML part); escaped in the HTML rows.
  const rawFrom = input.fromPlan || "Tomverse";
  const rawTo = input.toPlan || "Tomverse";
  const fromPlan = escapeHtml(rawFrom);
  const toPlan = escapeHtml(rawTo);
  const billingInterval = formatBillingInterval(input.billingInterval, language);
  const date = formatDate(input.effectiveAt ?? null, language);
  // An upgrade whose next renewal Stripe did not report leaves the row out
  // rather than printing "not available" under the period end.
  const showDate = Boolean(input.effectiveAt);
  const phaseCopy = phase === "upgraded" ? copy.upgraded : copy.downgradeScheduled;
  const intro =
    phase === "upgraded"
      ? copy.upgraded.intro
      : copy.downgradeScheduled.intro(rawFrom, date);
  const note =
    phase === "upgraded" ? copy.upgraded.note : copy.downgradeScheduled.note(date);
  const text = [
    intro,
    `${copy.fromLabel}: ${rawFrom}`,
    `${copy.toLabel}: ${rawTo}`,
    `${copy.billingLabel}: ${billingInterval}`,
    showDate ? `${phaseCopy.dateLabel}: ${date}` : "",
    note,
  ]
    .filter(Boolean)
    .join("\n");
  const html = shell(
    phaseCopy.title,
    `
        <p>${escapeHtml(intro)}</p>
        <div style="margin:20px 0;padding:18px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#1e3a8a;">
          <div style="margin-bottom:8px;"><strong>${copy.fromLabel}:</strong> ${fromPlan}</div>
          <div style="margin-bottom:8px;"><strong>${copy.toLabel}:</strong> ${toPlan}</div>
          <div${showDate ? ' style="margin-bottom:8px;"' : ""}><strong>${copy.billingLabel}:</strong> ${billingInterval}</div>
          ${showDate ? `<div><strong>${phaseCopy.dateLabel}:</strong> ${date}</div>` : ""}
        </div>
        <p>${escapeHtml(note)}</p>
      `,
    language
  );
  return { subject: phaseCopy.subject(rawTo), text, html };
}

import "server-only";

import { sendTransactionalEmail } from "@/lib/email";

type EmailLanguage = "en" | "ko" | "zh" | "fr" | "de" | "es" | "pt";

type RefundEmailInput = {
  to: string | null | undefined;
  plan: string | null | undefined;
  requestId: string;
  adminNote?: string | null;
  language?: string | null;
};

type BillingWelcomeEmailInput = {
  to: string | null | undefined;
  plan: string | null | undefined;
  billingInterval?: string | null;
  periodEnd?: Date | string | null;
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
    billingLabel: "Tomverse AI Billing",
    openTomverse: "Open Tomverse",
    footer:
      "This message was sent about your Tomverse AI billing account. If you did not request this, contact support.",
    notAvailable: "Not available",
    interval: {
      annual: "Annual",
      monthly: "Monthly",
      subscription: "Subscription",
    },
    welcome: {
      subject: (plan: string) => `Welcome to Tomverse AI ${plan}`,
      title: "Welcome to Tomverse AI",
      text: (
        plan: string,
        billingInterval: string,
        periodEnd: string
      ) => [
        "Your Tomverse AI payment was successful.",
        "Welcome to the Tomverse AI family.",
        `Plan: ${plan}`,
        `Billing: ${billingInterval}`,
        `Plan valid until: ${periodEnd}`,
        "Checkout is charged in USD. You can manage your plan in Settings > Plan.",
      ],
      body: (plan: string, billingInterval: string, periodEnd: string) => `
        <p>Your payment was successful. Welcome to the Tomverse AI family.</p>
        <div style="margin:20px 0;padding:18px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#1e3a8a;">
          <div style="margin-bottom:8px;"><strong>Plan:</strong> ${plan}</div>
          <div style="margin-bottom:8px;"><strong>Billing:</strong> ${billingInterval}</div>
          <div><strong>Plan valid until:</strong> ${periodEnd}</div>
        </div>
        <p>You can now use the paid Tomverse AI workspace features included with your plan. Manage billing and plan details anytime from <strong>Settings &gt; Plan</strong>.</p>
        <p style="color:#6b7280;">Displayed local prices are converted for convenience. Checkout and billing are charged in USD.</p>
      `,
    },
    refundReceived: {
      subject: "We received your Tomverse AI refund request",
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
      subject: "Your Tomverse AI refund request was approved",
      title: "Refund request approved",
      text: (requestId: string, adminNote: string) => [
        "Your refund and plan cancellation request has been approved.",
        "Your Tomverse AI membership has been moved back to Free.",
        adminNote ? `Admin note: ${adminNote}` : "",
        `Request ID: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string) => `
        <p>Your refund and plan cancellation request has been approved.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
          <strong>Your Tomverse AI membership has been moved back to Free.</strong>
        </div>
        ${adminNote ? `<p><strong>Note from Tomverse:</strong> ${adminNote}</p>` : ""}
        <p>If a payment refund is applicable, processing time may depend on Stripe, your card issuer, PayPal, Apple Pay, or Google Pay.</p>
        <p style="color:#6b7280;">Request ID: ${requestId}</p>
      `,
    },
    refundRejected: {
      subject: "Update on your Tomverse AI refund request",
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
    billingLabel: "Tomverse AI 결제",
    openTomverse: "Tomverse 열기",
    footer:
      "이 메일은 Tomverse AI 결제 계정과 관련해 발송되었습니다. 직접 요청하지 않은 내용이라면 지원팀에 문의해 주세요.",
    notAvailable: "확인 불가",
    interval: { annual: "연간", monthly: "월간", subscription: "구독" },
    welcome: {
      subject: (plan: string) => `Tomverse AI ${plan} 플랜에 오신 것을 환영합니다`,
      title: "Tomverse AI에 오신 것을 환영합니다",
      text: (plan: string, billingInterval: string, periodEnd: string) => [
        "Tomverse AI 결제가 성공적으로 완료되었습니다.",
        "Tomverse AI의 새로운 가족이 되신 것을 환영합니다.",
        `플랜: ${plan}`,
        `결제 주기: ${billingInterval}`,
        `플랜 만료일: ${periodEnd}`,
        "결제는 USD로 청구됩니다. 설정 > 플랜에서 플랜을 관리할 수 있습니다.",
      ],
      body: (plan: string, billingInterval: string, periodEnd: string) => `
        <p>Tomverse AI 결제가 성공적으로 완료되었습니다. Tomverse AI의 새로운 가족이 되신 것을 환영합니다.</p>
        <div style="margin:20px 0;padding:18px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#1e3a8a;">
          <div style="margin-bottom:8px;"><strong>플랜:</strong> ${plan}</div>
          <div style="margin-bottom:8px;"><strong>결제 주기:</strong> ${billingInterval}</div>
          <div><strong>플랜 만료일:</strong> ${periodEnd}</div>
        </div>
        <p>이제 현재 플랜에 포함된 Tomverse AI의 유료 워크스페이스 기능을 사용할 수 있습니다. 결제와 플랜 정보는 언제든 <strong>설정 &gt; 플랜</strong>에서 확인하실 수 있습니다.</p>
        <p style="color:#6b7280;">현지 통화 가격은 참고용 환산 금액이며, 실제 결제와 청구는 USD 기준으로 처리됩니다.</p>
      `,
    },
    refundReceived: {
      subject: "Tomverse AI 환불 요청이 접수되었습니다",
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
      subject: "Tomverse AI 환불 요청이 승인되었습니다",
      title: "환불 요청이 승인되었습니다",
      text: (requestId: string, adminNote: string) => [
        "환불 및 플랜 취소 요청이 승인되었습니다.",
        "Tomverse AI 멤버십이 Free 플랜으로 변경되었습니다.",
        adminNote ? `관리자 메모: ${adminNote}` : "",
        `요청 ID: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string) => `
        <p>환불 및 플랜 취소 요청이 승인되었습니다.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
          <strong>Tomverse AI 멤버십이 Free 플랜으로 변경되었습니다.</strong>
        </div>
        ${adminNote ? `<p><strong>Tomverse 메모:</strong> ${adminNote}</p>` : ""}
        <p>환불이 적용되는 경우, 처리 시간은 Stripe, 카드사, PayPal, Apple Pay 또는 Google Pay 정책에 따라 달라질 수 있습니다.</p>
        <p style="color:#6b7280;">요청 ID: ${requestId}</p>
      `,
    },
    refundRejected: {
      subject: "Tomverse AI 환불 요청 검토 결과 안내",
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
    billingLabel: "Tomverse AI 账单",
    openTomverse: "打开 Tomverse",
    footer:
      "此邮件与您的 Tomverse AI 账单账户有关。如果这不是您本人请求的操作，请联系支持团队。",
    notAvailable: "不可用",
    interval: { annual: "年度", monthly: "月度", subscription: "订阅" },
    welcome: {
      subject: (plan: string) => `欢迎使用 Tomverse AI ${plan}`,
      title: "欢迎使用 Tomverse AI",
      text: (plan: string, billingInterval: string, periodEnd: string) => [
        "您的 Tomverse AI 付款已成功完成。",
        "欢迎加入 Tomverse AI。",
        `套餐：${plan}`,
        `账单周期：${billingInterval}`,
        `套餐有效期至：${periodEnd}`,
        "结账将以 USD 收费。您可以在设置 > 套餐中管理订阅。",
      ],
      body: (plan: string, billingInterval: string, periodEnd: string) => `
        <p>您的付款已成功完成。欢迎加入 Tomverse AI。</p>
        <div style="margin:20px 0;padding:18px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#1e3a8a;">
          <div style="margin-bottom:8px;"><strong>套餐：</strong> ${plan}</div>
          <div style="margin-bottom:8px;"><strong>账单周期：</strong> ${billingInterval}</div>
          <div><strong>套餐有效期至：</strong> ${periodEnd}</div>
        </div>
        <p>您现在可以使用当前套餐包含的 Tomverse AI 付费工作区功能。您可以随时在 <strong>设置 &gt; 套餐</strong> 中管理账单和套餐信息。</p>
        <p style="color:#6b7280;">本地货币价格仅供参考，实际结账和账单均以 USD 收取。</p>
      `,
    },
    refundReceived: {
      subject: "我们已收到您的 Tomverse AI 退款请求",
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
      subject: "您的 Tomverse AI 退款请求已获批准",
      title: "退款请求已批准",
      text: (requestId: string, adminNote: string) => [
        "您的退款和套餐取消请求已获批准。",
        "您的 Tomverse AI 会员资格已切换回 Free。",
        adminNote ? `管理员备注：${adminNote}` : "",
        `请求 ID：${requestId}`,
      ],
      body: (requestId: string, adminNote: string) => `
        <p>您的退款和套餐取消请求已获批准。</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
          <strong>您的 Tomverse AI 会员资格已切换回 Free。</strong>
        </div>
        ${adminNote ? `<p><strong>Tomverse 备注：</strong> ${adminNote}</p>` : ""}
        <p>如适用退款，处理时间可能取决于 Stripe、发卡行、PayPal、Apple Pay 或 Google Pay。</p>
        <p style="color:#6b7280;">请求 ID：${requestId}</p>
      `,
    },
    refundRejected: {
      subject: "您的 Tomverse AI 退款请求更新",
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
    billingLabel: "Facturation Tomverse AI",
    openTomverse: "Ouvrir Tomverse",
    footer:
      "Ce message concerne votre compte de facturation Tomverse AI. Si vous n'êtes pas à l'origine de cette demande, contactez le support.",
    notAvailable: "Non disponible",
    interval: { annual: "Annuel", monthly: "Mensuel", subscription: "Abonnement" },
    welcome: {
      subject: (plan: string) => `Bienvenue sur Tomverse AI ${plan}`,
      title: "Bienvenue sur Tomverse AI",
      text: (plan: string, billingInterval: string, periodEnd: string) => [
        "Votre paiement Tomverse AI a bien été effectué.",
        "Bienvenue dans la famille Tomverse AI.",
        `Plan : ${plan}`,
        `Facturation : ${billingInterval}`,
        `Plan valable jusqu'au : ${periodEnd}`,
        "Le paiement est facturé en USD. Vous pouvez gérer votre plan dans Paramètres > Plan.",
      ],
      body: (plan: string, billingInterval: string, periodEnd: string) => `
        <p>Votre paiement a bien été effectué. Bienvenue dans la famille Tomverse AI.</p>
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
      subject: "Nous avons reçu votre demande de remboursement Tomverse AI",
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
      subject: "Votre demande de remboursement Tomverse AI a été approuvée",
      title: "Demande de remboursement approuvée",
      text: (requestId: string, adminNote: string) => [
        "Votre demande de remboursement et d'annulation de plan a été approuvée.",
        "Votre abonnement Tomverse AI est repassé au plan Free.",
        adminNote ? `Note : ${adminNote}` : "",
        `ID de demande : ${requestId}`,
      ],
      body: (requestId: string, adminNote: string) => `
        <p>Votre demande de remboursement et d'annulation de plan a été approuvée.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
          <strong>Votre abonnement Tomverse AI est repassé au plan Free.</strong>
        </div>
        ${adminNote ? `<p><strong>Note de Tomverse :</strong> ${adminNote}</p>` : ""}
        <p>Si un remboursement est applicable, le délai de traitement peut dépendre de Stripe, de votre banque, de PayPal, Apple Pay ou Google Pay.</p>
        <p style="color:#6b7280;">ID de demande : ${requestId}</p>
      `,
    },
    refundRejected: {
      subject: "Mise à jour de votre demande de remboursement Tomverse AI",
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
    billingLabel: "Tomverse AI Abrechnung",
    openTomverse: "Tomverse öffnen",
    footer:
      "Diese Nachricht betrifft Ihr Tomverse AI Abrechnungskonto. Wenn Sie dies nicht angefordert haben, kontaktieren Sie bitte den Support.",
    notAvailable: "Nicht verfügbar",
    interval: { annual: "Jährlich", monthly: "Monatlich", subscription: "Abonnement" },
    welcome: {
      subject: (plan: string) => `Willkommen bei Tomverse AI ${plan}`,
      title: "Willkommen bei Tomverse AI",
      text: (plan: string, billingInterval: string, periodEnd: string) => [
        "Ihre Tomverse AI Zahlung war erfolgreich.",
        "Willkommen in der Tomverse AI Familie.",
        `Plan: ${plan}`,
        `Abrechnung: ${billingInterval}`,
        `Plan gültig bis: ${periodEnd}`,
        "Der Checkout wird in USD berechnet. Sie können Ihren Plan unter Einstellungen > Plan verwalten.",
      ],
      body: (plan: string, billingInterval: string, periodEnd: string) => `
        <p>Ihre Zahlung war erfolgreich. Willkommen in der Tomverse AI Familie.</p>
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
      subject: "Wir haben Ihre Tomverse AI Rückerstattungsanfrage erhalten",
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
      subject: "Ihre Tomverse AI Rückerstattungsanfrage wurde genehmigt",
      title: "Rückerstattungsanfrage genehmigt",
      text: (requestId: string, adminNote: string) => [
        "Ihre Anfrage zur Rückerstattung und Kündigung des Plans wurde genehmigt.",
        "Ihre Tomverse AI Mitgliedschaft wurde auf Free zurückgesetzt.",
        adminNote ? `Hinweis: ${adminNote}` : "",
        `Anfrage-ID: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string) => `
        <p>Ihre Anfrage zur Rückerstattung und Kündigung des Plans wurde genehmigt.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
          <strong>Ihre Tomverse AI Mitgliedschaft wurde auf Free zurückgesetzt.</strong>
        </div>
        ${adminNote ? `<p><strong>Hinweis von Tomverse:</strong> ${adminNote}</p>` : ""}
        <p>Falls eine Rückerstattung gilt, kann die Bearbeitungszeit von Stripe, Ihrer Bank, PayPal, Apple Pay oder Google Pay abhängen.</p>
        <p style="color:#6b7280;">Anfrage-ID: ${requestId}</p>
      `,
    },
    refundRejected: {
      subject: "Update zu Ihrer Tomverse AI Rückerstattungsanfrage",
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
    billingLabel: "Facturación de Tomverse AI",
    openTomverse: "Abrir Tomverse",
    footer:
      "Este mensaje se envió sobre tu cuenta de facturación de Tomverse AI. Si no solicitaste esto, contacta con soporte.",
    notAvailable: "No disponible",
    interval: { annual: "Anual", monthly: "Mensual", subscription: "Suscripción" },
    welcome: {
      subject: (plan: string) => `Bienvenido a Tomverse AI ${plan}`,
      title: "Bienvenido a Tomverse AI",
      text: (plan: string, billingInterval: string, periodEnd: string) => [
        "Tu pago de Tomverse AI se completó correctamente.",
        "Bienvenido a la familia Tomverse AI.",
        `Plan: ${plan}`,
        `Facturación: ${billingInterval}`,
        `Plan válido hasta: ${periodEnd}`,
        "El checkout se cobra en USD. Puedes gestionar tu plan en Configuración > Plan.",
      ],
      body: (plan: string, billingInterval: string, periodEnd: string) => `
        <p>Tu pago se completó correctamente. Bienvenido a la familia Tomverse AI.</p>
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
      subject: "Recibimos tu solicitud de reembolso de Tomverse AI",
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
      subject: "Tu solicitud de reembolso de Tomverse AI fue aprobada",
      title: "Solicitud de reembolso aprobada",
      text: (requestId: string, adminNote: string) => [
        "Tu solicitud de reembolso y cancelación del plan fue aprobada.",
        "Tu membresía de Tomverse AI volvió al plan Free.",
        adminNote ? `Nota: ${adminNote}` : "",
        `ID de solicitud: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string) => `
        <p>Tu solicitud de reembolso y cancelación del plan fue aprobada.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
          <strong>Tu membresía de Tomverse AI volvió al plan Free.</strong>
        </div>
        ${adminNote ? `<p><strong>Nota de Tomverse:</strong> ${adminNote}</p>` : ""}
        <p>Si corresponde un reembolso, el tiempo de procesamiento puede depender de Stripe, tu banco, PayPal, Apple Pay o Google Pay.</p>
        <p style="color:#6b7280;">ID de solicitud: ${requestId}</p>
      `,
    },
    refundRejected: {
      subject: "Actualización sobre tu solicitud de reembolso de Tomverse AI",
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
    billingLabel: "Cobrança Tomverse AI",
    openTomverse: "Abrir Tomverse",
    footer:
      "Esta mensagem foi enviada sobre a sua conta de cobrança Tomverse AI. Se não solicitou isto, contacte o suporte.",
    notAvailable: "Indisponível",
    interval: { annual: "Anual", monthly: "Mensal", subscription: "Subscrição" },
    welcome: {
      subject: (plan: string) => `Bem-vindo ao Tomverse AI ${plan}`,
      title: "Bem-vindo ao Tomverse AI",
      text: (plan: string, billingInterval: string, periodEnd: string) => [
        "O seu pagamento Tomverse AI foi concluído com sucesso.",
        "Bem-vindo à família Tomverse AI.",
        `Plano: ${plan}`,
        `Cobrança: ${billingInterval}`,
        `Plano válido até: ${periodEnd}`,
        "O checkout é cobrado em USD. Pode gerir o plano em Definições > Plano.",
      ],
      body: (plan: string, billingInterval: string, periodEnd: string) => `
        <p>O seu pagamento foi concluído com sucesso. Bem-vindo à família Tomverse AI.</p>
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
      subject: "Recebemos o seu pedido de reembolso Tomverse AI",
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
      subject: "O seu pedido de reembolso Tomverse AI foi aprovado",
      title: "Pedido de reembolso aprovado",
      text: (requestId: string, adminNote: string) => [
        "O seu pedido de reembolso e cancelamento do plano foi aprovado.",
        "A sua subscrição Tomverse AI voltou para o plano Free.",
        adminNote ? `Nota: ${adminNote}` : "",
        `ID do pedido: ${requestId}`,
      ],
      body: (requestId: string, adminNote: string) => `
        <p>O seu pedido de reembolso e cancelamento do plano foi aprovado.</p>
        <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
          <strong>A sua subscrição Tomverse AI voltou para o plano Free.</strong>
        </div>
        ${adminNote ? `<p><strong>Nota da Tomverse:</strong> ${adminNote}</p>` : ""}
        <p>Se houver reembolso aplicável, o tempo de processamento pode depender da Stripe, do emissor do cartão, PayPal, Apple Pay ou Google Pay.</p>
        <p style="color:#6b7280;">ID do pedido: ${requestId}</p>
      `,
    },
    refundRejected: {
      subject: "Atualização sobre o seu pedido de reembolso Tomverse AI",
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
  <div style="margin:0;padding:0;background:#f4f6fb;font-family:Inter,Arial,sans-serif;color:#111827;">
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

export async function sendBillingWelcomeEmail(input: BillingWelcomeEmailInput) {
  if (!input.to) return;
  const language = normalizeLanguage(input.language);
  const copy = getCopy(input.language);
  const plan = escapeHtml(input.plan || "Tomverse AI");
  const billingInterval = formatBillingInterval(input.billingInterval, language);
  const resolvedPeriodEnd =
    input.periodEnd || addBillingPeriod(new Date(), input.billingInterval);
  const periodEnd = formatDate(resolvedPeriodEnd, language);
  const subject = copy.welcome.subject(plan);
  const text = copy.welcome.text(plan, billingInterval, periodEnd).join("\n");
  const html = shell(
    copy.welcome.title,
    copy.welcome.body(plan, billingInterval, periodEnd),
    language
  );
  await sendTransactionalEmail({ to: input.to, subject, text, html });
}

type FoundingTesterPassEmailInput = {
  to: string | null | undefined;
  periodEnd: Date | string;
  language?: string | null;
};

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

const passEmail = async (
  input: FoundingTesterPassEmailInput,
  phase: "started" | "reminder" | "ended"
) => {
  if (!input.to) return { sent: false, skipped: true } as const;
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
  return sendTransactionalEmail({ to: input.to, subject, text, html });
};

export const sendFoundingTesterPassStartedEmail = (
  input: FoundingTesterPassEmailInput
) => passEmail(input, "started");

export const sendFoundingTesterPassReminderEmail = (
  input: FoundingTesterPassEmailInput
) => passEmail(input, "reminder");

export const sendFoundingTesterPassEndedEmail = (
  input: FoundingTesterPassEmailInput
) => passEmail(input, "ended");

export async function sendRefundRequestReceivedEmail(input: RefundEmailInput) {
  if (!input.to) return;
  const language = normalizeLanguage(input.language);
  const copy = getCopy(input.language);
  const plan = escapeHtml(input.plan || "paid");
  const requestId = escapeHtml(input.requestId);
  const subject = copy.refundReceived.subject;
  const text = copy.refundReceived.text(plan, requestId).join("\n");
  const html = shell(
    copy.refundReceived.title,
    copy.refundReceived.body(plan, requestId),
    language
  );
  await sendTransactionalEmail({ to: input.to, subject, text, html });
}

export async function sendRefundRequestApprovedEmail(input: RefundEmailInput) {
  if (!input.to) return;
  const language = normalizeLanguage(input.language);
  const copy = getCopy(input.language);
  const requestId = escapeHtml(input.requestId);
  const adminNote = input.adminNote ? escapeHtml(input.adminNote) : "";
  const subject = copy.refundApproved.subject;
  const text = copy.refundApproved
    .text(input.requestId, input.adminNote || "")
    .filter(Boolean)
    .join("\n");
  const html = shell(
    copy.refundApproved.title,
    copy.refundApproved.body(requestId, adminNote),
    language
  );
  await sendTransactionalEmail({ to: input.to, subject, text, html });
}

export async function sendRefundRequestRejectedEmail(input: RefundEmailInput) {
  if (!input.to) return;
  const language = normalizeLanguage(input.language);
  const copy = getCopy(input.language);
  const requestId = escapeHtml(input.requestId);
  const adminNote = input.adminNote ? escapeHtml(input.adminNote) : "";
  const subject = copy.refundRejected.subject;
  const text = copy.refundRejected
    .text(input.requestId, input.adminNote || "")
    .join("\n");
  const html = shell(
    copy.refundRejected.title,
    copy.refundRejected.body(requestId, adminNote, copy.refundRejected.fallback),
    language
  );
  await sendTransactionalEmail({ to: input.to, subject, text, html });
}

export async function sendAdminPlanChangedEmail(input: {
  to: string | null | undefined;
  plan: string | null | undefined;
  periodEnd?: Date | string | null;
  billingInterval?: string | null;
  reason?: string | null;
}) {
  if (!input.to) return;
  const plan = escapeHtml(input.plan || "Free");
  const periodEnd = formatDate(input.periodEnd, "en");
  const billingInterval = escapeHtml(input.billingInterval || "manual update");
  const reason = input.reason ? escapeHtml(input.reason) : "";
  const subject = `Your Tomverse AI plan was updated to ${plan}`;
  const text = [
    `Your Tomverse AI plan was updated to ${plan}.`,
    `Billing: ${billingInterval}`,
    `Plan valid until: ${periodEnd}`,
    reason ? `Reason: ${reason}` : "",
    "You can review the current plan from Settings > Plan.",
  ]
    .filter(Boolean)
    .join("\n");
  const html = shell(
    "Your Tomverse AI plan was updated",
    `
      <p>Your Tomverse AI plan was updated by the Tomverse team.</p>
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
  await sendTransactionalEmail({ to: input.to, subject, text, html });
}

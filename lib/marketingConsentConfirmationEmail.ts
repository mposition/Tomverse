import { EMAIL_FONT_STACK } from "@/lib/emailTypography";

/**
 * The mail that asks a person to confirm a marketing consent.
 *
 * Contract: docs/policy/email-double-opt-in.md §3 rules 2-3, §5, §8.
 *
 * ## It confirms and does nothing else
 *
 * A confirmation mail that also promotes something is itself advertising sent
 * without consent -- German case law has treated it that way -- so this carries
 * no product copy, no feature list, no offer and no second link. It names what
 * was asked for, gives one button, says when the link stops working, and says
 * what happens if the reader did not ask. `tests/marketingConsentConfirmationEmail.test.mjs`
 * checks the copy for exactly that.
 *
 * It is `transactional` and goes out on the transactional identity: filed as
 * marketing it would be refused by the very consent gate it exists to satisfy.
 *
 * Pure and deterministic for a given payload, so the drain's retries render the
 * same bytes (docs/policy/email-notifications.md §9.3).
 */

type EmailLanguage = "en" | "ko" | "zh" | "fr" | "de" | "es" | "pt";

export type MarketingConsentPurpose = "product_updates" | "newsletter" | "promotions";

export type MarketingConsentConfirmationPayload = {
  purpose: MarketingConsentPurpose;
  confirmUrl: string;
};

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

type Copy = {
  subject: string;
  purposeName: Record<MarketingConsentPurpose, string>;
  intro: (purposeName: string) => string;
  button: string;
  expiry: string;
  ignore: string;
  change: string;
};

export const MARKETING_CONSENT_CONFIRMATION_COPY: Record<EmailLanguage, Copy> = {
  en: {
    subject: "Confirm your Tomverse email subscription",
    purposeName: {
      product_updates: "product updates",
      newsletter: "the newsletter",
      promotions: "offers and promotions",
    },
    intro: (name) =>
      `You asked to receive ${name} from Tomverse by email. Confirm below to start receiving them.`,
    button: "Confirm subscription",
    expiry: "This link expires in 72 hours.",
    ignore:
      "If you did not ask for this, ignore this email. We will not send you this kind of email unless you confirm.",
    change: "You can change or withdraw this at any time in your notification settings.",
  },
  ko: {
    subject: "Tomverse 이메일 수신 동의를 확인해 주세요",
    purposeName: {
      product_updates: "제품 업데이트",
      newsletter: "뉴스레터",
      promotions: "혜택 및 프로모션",
    },
    intro: (name) =>
      `Tomverse의 ${name} 이메일 수신을 요청하셨습니다. 아래에서 확인하시면 수신이 시작됩니다.`,
    button: "수신 동의 확인",
    expiry: "이 링크는 72시간 후 만료됩니다.",
    ignore:
      "요청하지 않으셨다면 이 메일을 무시해 주세요. 확인하지 않으면 이 종류의 이메일은 발송되지 않습니다.",
    change: "알림 설정에서 언제든지 변경하거나 철회할 수 있습니다.",
  },
  zh: {
    subject: "请确认你的 Tomverse 邮件订阅",
    purposeName: {
      product_updates: "产品更新",
      newsletter: "新闻简报",
      promotions: "优惠与促销",
    },
    intro: (name) =>
      `你申请通过电子邮件接收 Tomverse 的${name}。请在下方确认后开始接收。`,
    button: "确认订阅",
    expiry: "此链接将在 72 小时后失效。",
    ignore: "如果这不是你本人的请求，请忽略此邮件。未经确认，我们不会向你发送此类邮件。",
    change: "你可以随时在通知设置中更改或撤回。",
  },
  fr: {
    subject: "Confirmez votre abonnement aux e-mails Tomverse",
    purposeName: {
      product_updates: "les nouveautés du produit",
      newsletter: "la newsletter",
      promotions: "les offres et promotions",
    },
    intro: (name) =>
      `Vous avez demandé à recevoir ${name} de Tomverse par e-mail. Confirmez ci-dessous pour commencer à les recevoir.`,
    button: "Confirmer l'abonnement",
    expiry: "Ce lien expire dans 72 heures.",
    ignore:
      "Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail. Ce type d'e-mail ne vous sera pas envoyé sans votre confirmation.",
    change:
      "Vous pouvez modifier ou retirer ce choix à tout moment dans vos paramètres de notification.",
  },
  de: {
    subject: "Bestätigen Sie Ihr Tomverse-E-Mail-Abonnement",
    purposeName: {
      product_updates: "Produktneuigkeiten",
      newsletter: "den Newsletter",
      promotions: "Angebote und Aktionen",
    },
    intro: (name) =>
      `Sie haben angefordert, ${name} von Tomverse per E-Mail zu erhalten. Bestätigen Sie unten, um den Empfang zu starten.`,
    button: "Abonnement bestätigen",
    expiry: "Dieser Link läuft in 72 Stunden ab.",
    ignore:
      "Wenn Sie dies nicht angefordert haben, ignorieren Sie diese E-Mail. Ohne Ihre Bestätigung senden wir Ihnen diese Art von E-Mail nicht.",
    change:
      "Sie können dies jederzeit in Ihren Benachrichtigungseinstellungen ändern oder widerrufen.",
  },
  es: {
    subject: "Confirma tu suscripción a los correos de Tomverse",
    purposeName: {
      product_updates: "las novedades del producto",
      newsletter: "el boletín",
      promotions: "las ofertas y promociones",
    },
    intro: (name) =>
      `Solicitaste recibir ${name} de Tomverse por correo electrónico. Confirma abajo para empezar a recibirlos.`,
    button: "Confirmar suscripción",
    expiry: "Este enlace caduca en 72 horas.",
    ignore:
      "Si no lo solicitaste, ignora este correo. No te enviaremos este tipo de correo a menos que lo confirmes.",
    change:
      "Puedes cambiarlo o retirarlo en cualquier momento en tu configuración de notificaciones.",
  },
  pt: {
    subject: "Confirme sua inscrição nos e-mails do Tomverse",
    purposeName: {
      product_updates: "as novidades do produto",
      newsletter: "a newsletter",
      promotions: "as ofertas e promoções",
    },
    intro: (name) =>
      `Você pediu para receber ${name} do Tomverse por e-mail. Confirme abaixo para começar a receber.`,
    button: "Confirmar inscrição",
    expiry: "Este link expira em 72 horas.",
    ignore:
      "Se você não fez esse pedido, ignore este e-mail. Não enviaremos este tipo de e-mail sem a sua confirmação.",
    change:
      "Você pode alterar ou retirar isso a qualquer momento nas suas configurações de notificação.",
  },
};

/**
 * What the delivery snapshot holds: the non-secret request fields only.
 *
 * The link is a capability -- whoever has it can confirm the consent for
 * seventy-two hours -- so it is not stored in the 90-day render snapshot
 * (docs/policy/email-notifications.md §10.3 keeps credentials out of it). It
 * is re-created at send time from these fields by
 * `prepareConsentConfirmationForSend()`, which the token's deterministic
 * encryption makes byte-identical on every retry.
 */
export type StoredConsentConfirmationPayload = {
  purpose: MarketingConsentPurpose;
  request: {
    userId: string;
    requestedAt: string;
    requestId: string;
    policyVersionId: string;
    addressDigest: string;
  };
  /** The consent key version active at request time; retries render with it. */
  tokenKeyVersion: string;
};

/** The URL placeholder the audit hash and the template registry see. */
export const CONSENT_CONFIRMATION_URL_PLACEHOLDER =
  "https://tomverse.app/consent/confirm#t={{token}}";

/**
 * Builds the send-time payload, and names the secrets it contains so the lane
 * keeps them out of the audit hash.
 *
 * The token travels in the URL fragment (`#t=`), which browsers do not send to
 * the server: it never reaches access logs, proxies, error reporters or a
 * Referer header.
 */
export const prepareConsentConfirmationForSend = (
  stored: StoredConsentConfirmationPayload,
  deps: {
    createToken: (
      payload: StoredConsentConfirmationPayload["request"] & { purpose: string },
      version: string
    ) => string;
    appUrl: string;
  }
): { payload: MarketingConsentConfirmationPayload; secrets: string[] } => {
  const token = deps.createToken(
    { ...stored.request, purpose: stored.purpose },
    stored.tokenKeyVersion
  );
  const confirmUrl = `${deps.appUrl}/consent/confirm#t=${encodeURIComponent(token)}`;
  return {
    payload: { purpose: stored.purpose, confirmUrl },
    secrets: [confirmUrl, encodeURIComponent(token), token],
  };
};

export const MARKETING_CONSENT_CONFIRMATION_PLACEHOLDER: MarketingConsentConfirmationPayload = {
  purpose: "product_updates",
  confirmUrl: CONSENT_CONFIRMATION_URL_PLACEHOLDER,
};

export function buildMarketingConsentConfirmationEmail(
  payload: MarketingConsentConfirmationPayload,
  language: string | null | undefined
) {
  const copy = MARKETING_CONSENT_CONFIRMATION_COPY[normalizeLanguage(language)];
  const purposeName =
    copy.purposeName[payload.purpose] ?? copy.purposeName.product_updates;
  const intro = copy.intro(purposeName);
  return {
    subject: copy.subject,
    text: [
      intro,
      "",
      `${copy.button}: ${payload.confirmUrl}`,
      "",
      copy.expiry,
      copy.ignore,
      copy.change,
    ].join("\n"),
    html: `
      <div style="font-family:${EMAIL_FONT_STACK};color:#111827;line-height:1.6">
        <p>${escapeHtml(intro)}</p>
        <p><a href="${escapeHtml(payload.confirmUrl)}" style="display:inline-block;padding:10px 20px;background:#18181b;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(copy.button)}</a></p>
        <p style="color:#6b7280;font-size:13px">${escapeHtml(copy.expiry)}</p>
        <p style="color:#6b7280;font-size:13px">${escapeHtml(copy.ignore)}</p>
        <p style="color:#6b7280;font-size:13px">${escapeHtml(copy.change)}</p>
      </div>
    `,
  };
}

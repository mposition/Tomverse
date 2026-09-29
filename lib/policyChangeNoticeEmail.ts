import "server-only";

import { createHash } from "node:crypto";

/**
 * The amendment notice: the legal message that tells every account the privacy
 * policy and the terms are changing, and when.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 10 and 12
 * (S10); docs/policy/email-policy-amendment-draft.md, which holds this wording
 * for approval.
 *
 * **The wording is a draft.** It counts as the notice only once its template
 * version's `contentHash` is listed in `CHANGE_NOTICE_APPROVED_CONTENT_HASHES`
 * (lib/emailPolicyPublication.ts), and that list is the owner's approval of it.
 * Until then a delivery of this template is recorded and counted as nothing.
 *
 * Built rather than sent, and deterministic for a given input, like every
 * standard-lane message: a retry must render the bytes the first attempt did.
 * Seven languages as a `Record`, so a missing one fails to compile.
 */

/**
 * The template versions whose wording the owner approved as the amendment
 * notice: their `contentHash` (lib/emailTemplateRegistry.ts). Empty until
 * docs/policy/email-policy-amendment-draft.md section 4 is approved.
 *
 * Two readers: the publication gate counts only deliveries of these versions,
 * and a campaign on this template is refused while its versions are not among
 * them -- so a draft wording can be neither counted as the notice nor sent as
 * one. The hash covers the whole placeholder render, links included, so it is
 * the value the production environment computes that gets listed here.
 */
export const POLICY_CHANGE_NOTICE_APPROVED_CONTENT_HASHES: readonly string[] = [];

/**
 * The effective date the notice announces, as YYYY-MM-DD, or null until the
 * owner sets it (docs/policy/email-policy-amendment-draft.md section 5).
 *
 * Held here rather than passed as a payload, so that the placeholder render --
 * whose hash is what gets approved -- is byte for byte the message that goes
 * out. A payload date made the approved hash and the sent bytes two different
 * things. A test holds it equal to the documents' effective date once set.
 */
export const POLICY_CHANGE_NOTICE_EFFECTIVE_DATE: string | null = null;

type EmailLanguage = "en" | "ko" | "zh" | "fr" | "de" | "es" | "pt";

type NoticeCopy = {
  subject: string;
  intro: (date: string) => string;
  releaseNotes: string;
  consent: string;
  read: string;
  why: string;
};

const NOTICE_COPY: Record<EmailLanguage, NoticeCopy> = {
  en: {
    subject: "Changes to the Tomverse Privacy Policy and Terms",
    intro: (date) =>
      `We are updating the Tomverse Privacy Policy and Terms and Conditions. The changes take effect on ${date}.`,
    releaseNotes:
      "Tomverse may send product update emails (news about the Tomverse service) without your asking to accounts that were registered before this change was announced. Otherwise we send them only if you ask. You can turn them off at any time in your email settings or with the unsubscribe link in any such message, without signing in. Sign-in codes, receipts and service notices are not affected.",
    consent:
      "A marketing email consent stays in effect until you withdraw it. If you receive marketing email in Korea, we will remind you of that consent every two years.",
    read: "Read the updated documents:",
    why: "You are receiving this because it is a notice about the terms of your account. It is sent whatever your email settings are.",
  },
  ko: {
    subject: "Tomverse 개인정보 처리방침과 이용약관이 변경됩니다",
    intro: (date) =>
      `Tomverse 개인정보 처리방침과 서비스 이용약관이 변경됩니다. 변경 사항은 ${date}부터 적용됩니다.`,
    releaseNotes:
      "Tomverse는 이 변경이 안내되기 전에 가입한 계정에는 신청하지 않으셨어도 제품 소식(Tomverse 서비스 소식) 메일을 보낼 수 있습니다. 그 밖에는 신청하신 경우에만 보냅니다. 이메일 설정 또는 해당 메일의 수신거부 링크에서 로그인 없이 언제든 끄실 수 있습니다. 로그인 코드, 영수증, 서비스 공지는 영향을 받지 않습니다.",
    consent:
      "광고성 이메일 수신동의는 철회하실 때까지 유효합니다. 한국에서 수신 중이신 경우, 2년마다 수신동의 사실을 알려 드립니다.",
    read: "변경된 문서 보기:",
    why: "계정 이용 조건에 관한 고지이므로 이메일 설정과 관계없이 발송됩니다.",
  },
  zh: {
    subject: "Tomverse 隐私政策和条款变更通知",
    intro: (date) => `我们正在更新 Tomverse 隐私政策和服务条款，变更自 ${date} 起生效。`,
    releaseNotes:
      "对于在本次变更公布之前注册的账户，即使您没有申请，Tomverse 也可能向您发送产品动态邮件（关于 Tomverse 服务的消息）。其他情况下，只有在您申请后才会发送。您可以随时在邮件设置中或通过此类邮件中的退订链接关闭，无需登录。登录验证码、收据和服务通知不受影响。",
    consent: "营销邮件同意在您撤回之前一直有效。如果您在韩国接收营销邮件，我们会每两年提醒您一次该同意。",
    read: "查看更新后的文件：",
    why: "这是关于您账户条款的通知，无论您的邮件设置如何都会发送。",
  },
  fr: {
    subject: "Modification de la politique de confidentialité et des conditions de Tomverse",
    intro: (date) =>
      `Nous mettons à jour la politique de confidentialité et les conditions générales de Tomverse. Les modifications prennent effet le ${date}.`,
    releaseNotes:
      "Tomverse peut envoyer des actualités produit (des nouvelles du service Tomverse) sans demande de votre part aux comptes inscrits avant l'annonce de ce changement. Sinon, nous ne les envoyons que si vous les demandez. Vous pouvez les désactiver à tout moment dans vos paramètres e-mail ou avec le lien de désabonnement de ces messages, sans vous connecter. Les codes de connexion, les reçus et les avis de service ne sont pas concernés.",
    consent:
      "Un consentement aux e-mails marketing reste valable jusqu'à ce que vous le retiriez. Si vous recevez des e-mails marketing en Corée, nous vous le rappellerons tous les deux ans.",
    read: "Consulter les documents mis à jour :",
    why: "Vous recevez ce message car il concerne les conditions de votre compte. Il est envoyé quels que soient vos paramètres e-mail.",
  },
  de: {
    subject: "Änderungen der Datenschutzerklärung und Bedingungen von Tomverse",
    intro: (date) =>
      `Wir aktualisieren die Datenschutzerklärung und die Geschäftsbedingungen von Tomverse. Die Änderungen gelten ab dem ${date}.`,
    releaseNotes:
      "Tomverse kann Produkt-Updates (Neuigkeiten zum Tomverse-Dienst) ohne Ihre Anforderung an Konten senden, die vor der Ankündigung dieser Änderung registriert wurden. Andernfalls senden wir sie nur auf Ihre Anforderung. Sie können sie jederzeit in Ihren E-Mail-Einstellungen oder über den Abmeldelink in einer solchen Nachricht deaktivieren, ohne sich anzumelden. Anmeldecodes, Belege und Servicehinweise sind davon nicht betroffen.",
    consent:
      "Eine Einwilligung in Werbe-E-Mails gilt, bis Sie sie widerrufen. Wenn Sie Werbe-E-Mails in Korea erhalten, erinnern wir Sie alle zwei Jahre an diese Einwilligung.",
    read: "Die aktualisierten Dokumente lesen:",
    why: "Sie erhalten diese Nachricht, weil sie die Bedingungen Ihres Kontos betrifft. Sie wird unabhängig von Ihren E-Mail-Einstellungen gesendet.",
  },
  es: {
    subject: "Cambios en la Política de privacidad y los Términos de Tomverse",
    intro: (date) =>
      `Estamos actualizando la Política de privacidad y los Términos y condiciones de Tomverse. Los cambios entran en vigor el ${date}.`,
    releaseNotes:
      "Tomverse puede enviar novedades del producto (noticias sobre el servicio Tomverse) sin que las pidas a las cuentas registradas antes de anunciarse este cambio. En los demás casos solo las enviamos si las pides. Puedes desactivarlas en cualquier momento en la configuración de correo o con el enlace para darte de baja de esos mensajes, sin iniciar sesión. Los códigos de acceso, los recibos y los avisos de servicio no cambian.",
    consent:
      "El consentimiento para correos de marketing sigue vigente hasta que lo retires. Si recibes correos de marketing en Corea, te lo recordaremos cada dos años.",
    read: "Consulta los documentos actualizados:",
    why: "Recibes este mensaje porque es un aviso sobre las condiciones de tu cuenta. Se envía sea cual sea tu configuración de correo.",
  },
  pt: {
    subject: "Alterações na Política de Privacidade e nos Termos da Tomverse",
    intro: (date) =>
      `Estamos atualizando a Política de Privacidade e os Termos e Condições da Tomverse. As alterações entram em vigor em ${date}.`,
    releaseNotes:
      "A Tomverse pode enviar novidades do produto (notícias sobre o serviço Tomverse) sem que você peça para contas cadastradas antes do anúncio desta mudança. Nos demais casos, só enviamos se você pedir. Você pode desativá-las a qualquer momento nas configurações de e-mail ou pelo link de descadastro dessas mensagens, sem fazer login. Códigos de acesso, recibos e avisos de serviço não mudam.",
    consent:
      "O consentimento para e-mails de marketing vale até que você o retire. Se você recebe e-mails de marketing na Coreia, vamos lembrá-lo desse consentimento a cada dois anos.",
    read: "Leia os documentos atualizados:",
    why: "Você está recebendo esta mensagem porque ela trata das condições da sua conta. Ela é enviada independentemente das suas configurações de e-mail.",
  },
};

const LANGUAGES = Object.keys(NOTICE_COPY) as EmailLanguage[];

const normalizeLanguage = (language: string | null | undefined): EmailLanguage =>
  LANGUAGES.includes(language as EmailLanguage) ? (language as EmailLanguage) : "en";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Nothing: every byte of the notice is fixed in code, and approved as such. */
export type PolicyChangeNoticePayload = Record<string, never>;

const formattedEffectiveDate = (language: EmailLanguage): string => {
  if (!POLICY_CHANGE_NOTICE_EFFECTIVE_DATE) return "{{effectiveDate}}";
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${POLICY_CHANGE_NOTICE_EFFECTIVE_DATE}T00:00:00.000Z`));
};

export function buildPolicyChangeNoticeEmail(input: {
  language?: string | null;
  appUrl: string;
}) {
  const language = normalizeLanguage(input.language);
  const copy = NOTICE_COPY[language];
  const effectiveDate = formattedEffectiveDate(language);
  const base = input.appUrl.replace(/\/+$/, "");
  const privacy = `${base}/privacy`;
  const terms = `${base}/terms`;
  return {
    subject: copy.subject,
    text: [
      copy.intro(effectiveDate),
      copy.releaseNotes,
      copy.consent,
      `${copy.read}\n${privacy}\n${terms}`,
      copy.why,
    ].join("\n\n"),
    html: [
      `<p>${escapeHtml(copy.intro(effectiveDate))}</p>`,
      `<p>${escapeHtml(copy.releaseNotes)}</p>`,
      `<p>${escapeHtml(copy.consent)}</p>`,
      `<p>${escapeHtml(copy.read)}<br><a href="${escapeHtml(privacy)}">${escapeHtml(privacy)}</a><br><a href="${escapeHtml(terms)}">${escapeHtml(terms)}</a></p>`,
      `<p>${escapeHtml(copy.why)}</p>`,
    ].join(""),
  };
}

/**
 * The hash the template registry takes of this render
 * (`templateContentHash()` in lib/emailTemplateRegistry.ts; a test holds the two
 * equal). Computed here because the registry imports this module.
 */
export const policyChangeNoticeRenderHash = (language: string, appUrl: string): string => {
  const rendered = buildPolicyChangeNoticeEmail({ language, appUrl });
  return createHash("sha256")
    .update(`${rendered.subject}\n${rendered.html}\n${rendered.text}`)
    .digest("hex");
};

/**
 * Whether the notice, as this build renders it in `language`, is wording the
 * owner approved: an effective date is set, and the render's hash is listed.
 *
 * Asked by every writer of a notice delivery and by the drain before it sends
 * one, so a draft wording can be neither queued nor sent -- and a deploy that
 * changes the wording stops the queue rather than sending new words under an
 * approval they never had.
 */
export const isPolicyChangeNoticeWordingApproved = (language: string, appUrl: string): boolean =>
  POLICY_CHANGE_NOTICE_EFFECTIVE_DATE !== null &&
  POLICY_CHANGE_NOTICE_APPROVED_CONTENT_HASHES.includes(policyChangeNoticeRenderHash(language, appUrl));

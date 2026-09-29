import "server-only";

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
      "Tomverse may email you product updates about features of the service you use, where the law where you live allows it without asking first. You can turn these off at any time in your email settings or with the unsubscribe link in any such message, without signing in. Sign-in codes, receipts and service notices are not affected.",
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
      "거주하시는 곳의 법이 사전 동의 없이 허용하는 경우, Tomverse는 이용 중인 서비스 기능에 관한 제품 소식을 이메일로 보내 드릴 수 있습니다. 이메일 설정 또는 해당 메일의 수신거부 링크에서 로그인 없이 언제든 끄실 수 있습니다. 로그인 코드, 영수증, 서비스 공지는 영향을 받지 않습니다.",
    consent:
      "광고성 이메일 수신동의는 철회하실 때까지 유효합니다. 한국에서 수신 중이신 경우, 2년마다 수신동의 사실을 알려 드립니다.",
    read: "변경된 문서 보기:",
    why: "계정 이용 조건에 관한 고지이므로 이메일 설정과 관계없이 발송됩니다.",
  },
  zh: {
    subject: "Tomverse 隐私政策和条款变更通知",
    intro: (date) => `我们正在更新 Tomverse 隐私政策和服务条款，变更自 ${date} 起生效。`,
    releaseNotes:
      "在您所在地法律允许无需事先征得同意的情况下，Tomverse 可能会通过邮件向您发送与您所使用功能相关的产品动态。您可以随时在邮件设置中或通过此类邮件中的退订链接关闭，无需登录。登录验证码、收据和服务通知不受影响。",
    consent: "营销邮件同意在您撤回之前一直有效。如果您在韩国接收营销邮件，我们会每两年提醒您一次该同意。",
    read: "查看更新后的文件：",
    why: "这是关于您账户条款的通知，无论您的邮件设置如何都会发送。",
  },
  fr: {
    subject: "Modification de la politique de confidentialité et des conditions de Tomverse",
    intro: (date) =>
      `Nous mettons à jour la politique de confidentialité et les conditions générales de Tomverse. Les modifications prennent effet le ${date}.`,
    releaseNotes:
      "Lorsque la loi de votre pays le permet sans accord préalable, Tomverse peut vous envoyer par e-mail des actualités produit concernant les fonctionnalités que vous utilisez. Vous pouvez les désactiver à tout moment dans vos paramètres e-mail ou avec le lien de désabonnement de ces messages, sans vous connecter. Les codes de connexion, les reçus et les avis de service ne sont pas concernés.",
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
      "Wo das Recht Ihres Wohnorts es ohne vorherige Einwilligung erlaubt, kann Tomverse Ihnen Produkt-Updates zu den von Ihnen genutzten Funktionen per E-Mail senden. Sie können diese jederzeit in Ihren E-Mail-Einstellungen oder über den Abmeldelink in einer solchen Nachricht deaktivieren, ohne sich anzumelden. Anmeldecodes, Belege und Servicehinweise sind davon nicht betroffen.",
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
      "Cuando la ley de tu lugar de residencia lo permita sin pedirlo antes, Tomverse puede enviarte por correo novedades del producto sobre las funciones que usas. Puedes desactivarlas en cualquier momento en la configuración de correo o con el enlace para darte de baja de esos mensajes, sin iniciar sesión. Los códigos de acceso, los recibos y los avisos de servicio no cambian.",
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
      "Quando a lei do lugar onde você mora permitir sem pedir antes, a Tomverse pode enviar por e-mail novidades do produto sobre os recursos que você usa. Você pode desativá-las a qualquer momento nas configurações de e-mail ou pelo link de descadastro dessas mensagens, sem fazer login. Códigos de acesso, recibos e avisos de serviço não mudam.",
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

export type PolicyChangeNoticePayload = {
  /** The effective date as the reader should see it, already formatted. */
  effectiveDate: string;
};

export function buildPolicyChangeNoticeEmail(input: {
  effectiveDate: string;
  language?: string | null;
  appUrl: string;
}) {
  const copy = NOTICE_COPY[normalizeLanguage(input.language)];
  const base = input.appUrl.replace(/\/+$/, "");
  const privacy = `${base}/privacy`;
  const terms = `${base}/terms`;
  return {
    subject: copy.subject,
    text: [
      copy.intro(input.effectiveDate),
      copy.releaseNotes,
      copy.consent,
      `${copy.read}\n${privacy}\n${terms}`,
      copy.why,
    ].join("\n\n"),
    html: [
      `<p>${escapeHtml(copy.intro(input.effectiveDate))}</p>`,
      `<p>${escapeHtml(copy.releaseNotes)}</p>`,
      `<p>${escapeHtml(copy.consent)}</p>`,
      `<p>${escapeHtml(copy.read)}<br><a href="${escapeHtml(privacy)}">${escapeHtml(privacy)}</a><br><a href="${escapeHtml(terms)}">${escapeHtml(terms)}</a></p>`,
      `<p>${escapeHtml(copy.why)}</p>`,
    ].join(""),
  };
}

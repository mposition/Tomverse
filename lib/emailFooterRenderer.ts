/**
 * The per-jurisdiction footer.
 *
 * Contract: docs/policy/email-notifications.md §5.2 E3, §8.6, §12.5.
 *
 * Pure: it takes a profile, a set of business identity values and a language,
 * and returns bytes. The profile decides *which* blocks appear and in what
 * order; this module decides what each one says. That split is §8.7's
 * boundary -- a profile changes values, a deploy changes shapes -- and it is
 * why a profile cannot name a block the renderer has never heard of.
 *
 * ## Language and jurisdiction are different axes
 *
 * §8.6. The blocks come from the jurisdiction; the words around them come from
 * `UserSettings.language`. A Korean resident reading in English gets the
 * Korean business registration blocks with English labels, and an American
 * reading in Korean gets neither. Collapsing the two would put `ko` = Korea
 * into the code, and that is wrong for every Korean speaker abroad.
 *
 * ## Missing values are refused, not omitted
 *
 * Q8 is still open: the legal name, the registration numbers, the postal
 * address and the ABN are values nobody has supplied yet. A renderer that
 * quietly dropped an unconfigured block would produce a marketing footer that
 * looks complete and is unlawful in the jurisdiction that required it -- which
 * is exactly the failure C4 exists to prevent. So an absent value is returned
 * as a refusal with the block named, and the caller does not send.
 */

export type FooterLanguage = "en" | "ko" | "zh" | "fr" | "de" | "es" | "pt";

/**
 * The sender's own identity, from configuration rather than from code.
 *
 * Every field is optional because none of them is known yet (Q8). What is not
 * optional is what happens when one is missing: see `renderJurisdictionFooter`.
 */
export type BusinessIdentity = {
  legalName?: string | null;
  postalAddress?: string | null;
  contactEmail?: string | null;
  /**
   * A telephone number the recipient can reach the sender on.
   *
   * Korea's 시행령 별표 6 names it alongside the sender's name, address and
   * email, so the KR profile asks for it (draft section 7.7). Nothing else
   * does, and it is not in the common footer: a value that exists only to
   * satisfy one jurisdiction does not belong in every message.
   */
  contactPhone?: string | null;
  /** 사업자등록번호. Korea. */
  businessRegistrationNumber?: string | null;
  /** 통신판매업 신고번호. Korea. */
  mailOrderRegistrationNumber?: string | null;
  /** Australian Business Number. */
  abn?: string | null;
};

export type FooterProfile = {
  profileKey: string;
  footerBlocks: readonly string[];
  unsubscribeSlaBusinessDays: number;
};

export type FooterInput = {
  profile: FooterProfile;
  identity: BusinessIdentity;
  language?: string | null;
  /**
   * Absent for transactional and legal mail, which carry no unsubscribe link
   * at all (C10). A profile that names the block and a caller that supplies no
   * URL is a classification mistake, and it is refused rather than rendered
   * with a dead link.
   */
  unsubscribeUrl?: string | null;
  /** Why this person is receiving it (C4). One short clause. */
  reasonLine?: string | null;
  /**
   * The languages the unsubscribe notice must also appear in, whatever the
   * message's own language (draft section 7.7: Korea's 별표 6 asks for Korean
   * and English). The message's language comes first; the rest follow in the
   * order given. Absent or empty: the notice is in the message's language only.
   */
  unsubscribeNoticeLanguages?: readonly string[];
};

export type FooterResult =
  | { ok: true; html: string; text: string }
  | { ok: false; missing: string[] };

const LANGUAGES: readonly FooterLanguage[] = [
  "en",
  "ko",
  "zh",
  "fr",
  "de",
  "es",
  "pt",
];

export const FOOTER_LANGUAGES = LANGUAGES;

const normalizeLanguage = (value: string | null | undefined): FooterLanguage =>
  LANGUAGES.includes(value as FooterLanguage) ? (value as FooterLanguage) : "en";

type FooterCopy = {
  phone: string;
  businessRegistration: string;
  mailOrderRegistration: string;
  abn: string;
  contact: string;
  unsubscribe: string;
  /** "{days}" is replaced with the profile's number. */
  unsubscribeSla: string;
  defaultReason: string;
};

/**
 * The labels, per language.
 *
 * Written out rather than pulled from `locales/*.ts`: those are the product's
 * UI strings, loaded by a React provider, and an email builder is neither.
 * `lib/accountEmails.ts` and `lib/emailLoginEmails.ts` already carry their copy
 * this way, and a footer that reached into the UI dictionary would be the one
 * email module that could not be rendered without a browser runtime.
 */
const COPY: Record<FooterLanguage, FooterCopy> = {
  en: {
    phone: "Phone",
    businessRegistration: "Business registration number",
    mailOrderRegistration: "Mail-order business registration number",
    abn: "ABN",
    contact: "Contact",
    unsubscribe: "Unsubscribe",
    unsubscribeSla:
      "Unsubscribe requests take effect immediately, and in no case later than {days} business days.",
    defaultReason:
      "You are receiving this because you agreed to receive it from your account settings.",
  },
  ko: {
    phone: "전화번호",
    businessRegistration: "사업자등록번호",
    mailOrderRegistration: "통신판매업 신고번호",
    abn: "ABN",
    contact: "문의",
    unsubscribe: "수신거부",
    unsubscribeSla:
      "수신거부는 즉시 처리되며, 어떠한 경우에도 {days} 영업일을 넘지 않습니다.",
    defaultReason:
      "회원님이 계정 설정에서 수신에 동의하셨기 때문에 발송되었습니다.",
  },
  zh: {
    phone: "电话",
    businessRegistration: "营业执照号码",
    mailOrderRegistration: "邮购业务登记号",
    abn: "ABN",
    contact: "联系方式",
    unsubscribe: "退订",
    unsubscribeSla:
      "退订请求会立即生效，无论如何都不会晚于 {days} 个工作日。",
    defaultReason: "您收到此邮件是因为您在账户设置中同意接收。",
  },
  fr: {
    phone: "Téléphone",
    businessRegistration: "Numéro d'enregistrement de l'entreprise",
    mailOrderRegistration: "Numéro d'enregistrement de vente à distance",
    abn: "ABN",
    contact: "Contact",
    unsubscribe: "Se désabonner",
    unsubscribeSla:
      "Les demandes de désabonnement prennent effet immédiatement, et en aucun cas au-delà de {days} jours ouvrables.",
    defaultReason:
      "Vous recevez ce message parce que vous y avez consenti dans les paramètres de votre compte.",
  },
  de: {
    phone: "Telefon",
    businessRegistration: "Handelsregisternummer",
    mailOrderRegistration: "Registernummer für den Versandhandel",
    abn: "ABN",
    contact: "Kontakt",
    unsubscribe: "Abbestellen",
    unsubscribeSla:
      "Abmeldungen werden sofort wirksam, in keinem Fall später als {days} Werktage.",
    defaultReason:
      "Sie erhalten diese Nachricht, weil Sie in Ihren Kontoeinstellungen zugestimmt haben.",
  },
  es: {
    phone: "Teléfono",
    businessRegistration: "Número de registro mercantil",
    mailOrderRegistration: "Número de registro de venta a distancia",
    abn: "ABN",
    contact: "Contacto",
    unsubscribe: "Cancelar la suscripción",
    unsubscribeSla:
      "Las bajas se aplican de inmediato y, en ningún caso, más tarde de {days} días hábiles.",
    defaultReason:
      "Recibe este mensaje porque lo aceptó en la configuración de su cuenta.",
  },
  pt: {
    phone: "Telefone",
    businessRegistration: "Número de registo comercial",
    mailOrderRegistration: "Número de registo de venda à distância",
    abn: "ABN",
    contact: "Contacto",
    unsubscribe: "Cancelar subscrição",
    unsubscribeSla:
      "Os pedidos de cancelamento têm efeito imediato e, em caso algum, mais tarde do que {days} dias úteis.",
    defaultReason:
      "Está a receber esta mensagem porque a aceitou nas definições da sua conta.",
  },
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

type Line = { text: string; html: string };

/**
 * One rendered line per block, or the name of the block that could not be
 * rendered.
 *
 * Returns `null` for a block whose value is absent so the caller can collect
 * every missing name at once: telling an operator about one missing value,
 * then another after they fix it, is three deploys to learn three facts.
 */
const renderBlock = (
  block: string,
  input: FooterInput,
  copy: FooterCopy
): Line | null => {
  const identity = input.identity;
  const plain = (value: string | null | undefined) =>
    value?.trim() ? { text: value.trim(), html: escapeHtml(value.trim()) } : null;
  const labelled = (label: string, value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    return {
      text: `${label}: ${trimmed}`,
      html: `${escapeHtml(label)}: ${escapeHtml(trimmed)}`,
    };
  };

  switch (block) {
    case "legal_name":
      return plain(identity.legalName);
    case "postal_address":
      return plain(identity.postalAddress);
    case "contact_email":
      return labelled(copy.contact, identity.contactEmail);
    case "contact_phone":
      return labelled(copy.phone, identity.contactPhone);
    case "business_registration":
      return labelled(copy.businessRegistration, identity.businessRegistrationNumber);
    case "mail_order_registration":
      return labelled(
        copy.mailOrderRegistration,
        identity.mailOrderRegistrationNumber
      );
    case "abn":
      return labelled(copy.abn, identity.abn);
    case "unsubscribe_link": {
      const url = input.unsubscribeUrl?.trim();
      if (!url) return null;
      const noticeIn = (notice: FooterCopy) => ({
        text: `${notice.unsubscribe}: ${url}`,
        html:
          `<a href="${escapeHtml(url)}" style="color:#2563eb;">` +
          `${escapeHtml(notice.unsubscribe)}</a> &middot; ` +
          escapeHtml(
            notice.unsubscribeSla.replace(
              "{days}",
              String(input.profile.unsubscribeSlaBusinessDays)
            )
          ),
      });
      const notices = unsubscribeNoticeCopies(input, copy).map(noticeIn);
      return {
        text: notices.map((notice) => notice.text).join("\n"),
        html: notices.map((notice) => notice.html).join("<br>"),
      };
    }
    case "unsubscribe_reason": {
      const reason = input.reasonLine?.trim() || copy.defaultReason;
      return { text: reason, html: escapeHtml(reason) };
    }
    default:
      return null;
  }
};

/**
 * The unsubscribe notice's copies: the message's language, then each required
 * language not already covered, in the order given. One copy when nothing more
 * is required.
 */
const unsubscribeNoticeCopies = (input: FooterInput, copy: FooterCopy): FooterCopy[] => {
  const own = normalizeLanguage(input.language);
  const languages: FooterLanguage[] = [own];
  for (const language of input.unsubscribeNoticeLanguages ?? []) {
    const normalized = normalizeLanguage(language);
    if (!languages.includes(normalized)) languages.push(normalized);
  }
  return languages.map((language) => (language === own ? copy : COPY_BY_LANGUAGE(language)));
};

/**
 * Whether a footer rendered for a country that requires the unsubscribe notice
 * in `languages` actually carries it in each of them, for a message in any of
 * the footer's languages. The readiness check behind Korea's
 * `bilingual_unsubscribe_notice` duty: a code property, asked at runtime so a
 * build that stops doing it cannot keep the duty settled.
 */
export const unsubscribeNoticeCarriesLanguages = (languages: readonly string[]): boolean => {
  const url = "https://example.invalid/unsubscribe";
  return LANGUAGES.every((messageLanguage) => {
    const rendered = renderJurisdictionFooter({
      profile: { profileKey: "check", footerBlocks: ["unsubscribe_link"], unsubscribeSlaBusinessDays: 10 },
      identity: {},
      language: messageLanguage,
      unsubscribeUrl: url,
      unsubscribeNoticeLanguages: languages,
    });
    return (
      rendered.ok &&
      languages.every((language) =>
        rendered.text.includes(`${COPY_BY_LANGUAGE(normalizeLanguage(language)).unsubscribe}: ${url}`)
      )
    );
  });
};

/**
 * The set of blocks this renderer can produce.
 *
 * Exported so the seed's own validator and this module cannot drift: a profile
 * naming a block nobody renders is a footer with a hole in it, and it should
 * fail where the profile is written rather than where the mail is sent.
 */
export const RENDERABLE_FOOTER_BLOCKS = [
  "legal_name",
  "postal_address",
  "contact_email",
  "contact_phone",
  "business_registration",
  "mail_order_registration",
  "abn",
  "unsubscribe_link",
  "unsubscribe_reason",
] as const;

const COPY_BY_LANGUAGE = (language: FooterLanguage): FooterCopy => {
  switch (language) {
    case "ko":
      return COPY.ko;
    case "zh":
      return COPY.zh;
    case "fr":
      return COPY.fr;
    case "de":
      return COPY.de;
    case "es":
      return COPY.es;
    case "pt":
      return COPY.pt;
    default:
      return COPY.en;
  }
};

export const renderJurisdictionFooter = (input: FooterInput): FooterResult => {
  const copy = COPY[normalizeLanguage(input.language)];
  const lines: Line[] = [];
  const missing: string[] = [];

  for (const block of input.profile.footerBlocks) {
    if (!(RENDERABLE_FOOTER_BLOCKS as readonly string[]).includes(block)) {
      missing.push(block);
      continue;
    }
    const line = renderBlock(block, input, copy);
    if (!line) {
      missing.push(block);
      continue;
    }
    lines.push(line);
  }

  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    text: lines.map((line) => line.text).join("\n"),
    html:
      `<div style="color:#71717a;font-size:12px;line-height:20px;">` +
      lines.map((line) => `<p style="margin:0;">${line.html}</p>`).join("") +
      `</div>`,
  };
};

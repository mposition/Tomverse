/**
 * The approved wording of the consent devices, frozen at its approved bytes.
 *
 * Contract: docs/policy/email-consent-copy-draft.md, approved by mposition on
 * 2026-09-23. That document's section 3 and its section 10 govern this file.
 *
 * ## Why the strings live here rather than in `locales/`
 *
 * Because these ones are evidence. A hash of each string is written into
 * `EmailPermissionEvent.evidence.candidates[].copyHash` when a notice is
 * rendered, and that row is append-only -- so the words have to stay
 * retrievable for as long as the consent they evidence. A locale file is
 * ordinary product copy that anybody may improve; this is a record of what a
 * person was shown when they agreed.
 *
 * The locale files import from here rather than repeating the text, because
 * two copies of one sentence drift, and when this one drifts the hash stops
 * pointing at anything.
 *
 * ## Changing approved wording
 *
 * Add a version. Do not edit one.
 *
 * `CONSENT_COPY_VERSIONS` keeps every version that has ever been rendered, so
 * a `copyHash` written in 2026 still resolves in 2031. Editing an existing
 * entry would leave stored evidence pointing at a hash nothing produces, and
 * "the same sentence, spelled better" is -- from the evidence side -- a
 * different sentence. A typo fix is a new version like any other.
 *
 * Pure and dependency-free: the hash lives in `lib/emailConsentCopyHash.ts`,
 * which needs `node:crypto`, and this file is imported by locale modules that
 * render in a browser.
 */

/** The languages the approved copy covers (draft section 2). */
export const CONSENT_COPY_LANGUAGES = [
  "ko",
  "en",
  "de",
  "es",
  "fr",
  "pt",
  "zh",
] as const;

export type ConsentCopyLanguage = (typeof CONSENT_COPY_LANGUAGES)[number];

/**
 * The devices, named as the approved document names them.
 *
 * `signupOptIn` is device A, `signupNotice` B, `signupRefuse` C, and the
 * `notice*` keys are D. The three buttons are separate keys because they are
 * three separate facts on the screen: accepting, refusing and closing are not
 * one control with three labels.
 */
export const CONSENT_COPY_KEYS = [
  "signupOptIn",
  "signupNotice",
  "signupRefuse",
  "noticeTitle",
  "noticeBody",
  "noticeAccept",
  "noticeRefuse",
  "noticeDismiss",
] as const;

export type ConsentCopyKey = (typeof CONSENT_COPY_KEYS)[number];

export type ConsentCopyTable = Readonly<
  Record<ConsentCopyKey, Readonly<Record<ConsentCopyLanguage, string>>>
>;

const V2026_09_23: ConsentCopyTable = Object.freeze({
  signupOptIn: Object.freeze({
    ko: "이메일 광고성 정보 수신동의 (선택)",
    en: "Send me product news and offers by email (optional)",
    de: "Produktneuigkeiten und Angebote per E-Mail erhalten (optional)",
    es: "Quiero recibir novedades y ofertas por correo electrónico (opcional)",
    fr: "Recevoir les actualités produit et les offres par e-mail (facultatif)",
    pt: "Quero receber novidades e ofertas por e-mail (opcional)",
    zh: "接收产品资讯和优惠邮件（可选）",
  }),
  signupNotice: Object.freeze({
    ko: "켜시면 계정에 등록된 주소로 제품 소식, 뉴스레터, 프로모션을 보내 드립니다. 로그인 코드, 결제 영수증, 서비스 공지는 이 설정과 무관하게 발송됩니다. 언제든 로그인 없이 끄실 수 있습니다.",
    en: "If you turn this on, Tomverse sends product updates, newsletters and promotions to the address on your account. Sign-in codes, billing receipts and service notices are sent whether or not you turn this on. You can turn it off at any time, without signing in.",
    de: "Wenn Sie dies aktivieren, sendet Tomverse Produkt-Updates, Newsletter und Angebote an die Adresse Ihres Kontos. Anmeldecodes, Rechnungsbelege und Servicehinweise werden unabhängig davon gesendet. Sie können es jederzeit ohne Anmeldung deaktivieren.",
    es: "Si lo activas, Tomverse enviará novedades del producto, boletines y promociones a la dirección de tu cuenta. Los códigos de acceso, los recibos de facturación y los avisos de servicio se envían igualmente. Puedes desactivarlo en cualquier momento, sin iniciar sesión.",
    fr: "Si vous l'activez, Tomverse envoie les actualités produit, les infolettres et les promotions à l'adresse de votre compte. Les codes de connexion, les reçus de facturation et les avis de service sont envoyés dans tous les cas. Vous pouvez le désactiver à tout moment, sans vous connecter.",
    pt: "Se você ativar, a Tomverse envia novidades do produto, boletins e promoções para o endereço da sua conta. Códigos de acesso, recibos de cobrança e avisos de serviço são enviados de qualquer forma. Você pode desativar a qualquer momento, sem fazer login.",
    zh: "开启后，Tomverse 会向您账户中的地址发送产品动态、资讯邮件和优惠信息。登录验证码、账单收据和服务通知无论是否开启都会发送。您可以随时关闭，无需登录。",
  }),
  signupRefuse: Object.freeze({
    ko: "광고성 이메일을 받지 않겠습니다",
    en: "I do not want marketing email",
    de: "Ich möchte keine Werbe-E-Mails erhalten",
    es: "No quiero recibir correos de marketing",
    fr: "Je ne souhaite pas recevoir d'e-mails marketing",
    pt: "Não quero receber e-mails de marketing",
    zh: "我不想接收营销邮件",
  }),
  noticeTitle: Object.freeze({
    ko: "제품 소식을 이메일로 받아보시겠습니까?",
    en: "Would you like product news by email?",
    de: "Möchten Sie Produktneuigkeiten per E-Mail erhalten?",
    es: "¿Quieres recibir novedades del producto por correo?",
    fr: "Souhaitez-vous recevoir les actualités produit par e-mail ?",
    pt: "Quer receber novidades do produto por e-mail?",
    zh: "是否希望通过邮件接收产品动态？",
  }),
  noticeBody: Object.freeze({
    ko: "Tomverse는 지금까지 제품 소식을 보내드린 적이 없고, 요청하지 않으시면 앞으로도 보내지 않습니다. 켜시면 계정에 등록된 주소로 제품 소식, 뉴스레터, 프로모션을 보내 드립니다. 로그인 코드, 영수증, 서비스 공지는 영향을 받지 않습니다. 언제든 로그인 없이 끄실 수 있습니다.",
    en: "Tomverse has not sent you product news, and will not unless you ask. Turning this on sends product updates, newsletters and promotions to the address on your account. Sign-in codes, receipts and service notices are unaffected. You can turn it off at any time, without signing in.",
    de: "Tomverse hat Ihnen bisher keine Produktneuigkeiten gesendet und wird dies ohne Ihre Zustimmung auch nicht tun. Wenn Sie dies aktivieren, senden wir Produkt-Updates, Newsletter und Angebote an die Adresse Ihres Kontos. Anmeldecodes, Belege und Servicehinweise bleiben unberührt. Sie können es jederzeit ohne Anmeldung deaktivieren.",
    es: "Tomverse no te ha enviado novedades del producto y no lo hará a menos que lo pidas. Si lo activas, enviaremos novedades, boletines y promociones a la dirección de tu cuenta. Los códigos de acceso, los recibos y los avisos de servicio no cambian. Puedes desactivarlo en cualquier momento, sin iniciar sesión.",
    fr: "Tomverse ne vous a pas envoyé d'actualités produit et ne le fera pas sans votre demande. Si vous l'activez, nous enverrons les actualités produit, les infolettres et les promotions à l'adresse de votre compte. Les codes de connexion, les reçus et les avis de service ne changent pas. Vous pouvez le désactiver à tout moment, sans vous connecter.",
    pt: "A Tomverse não enviou novidades do produto e não enviará a menos que você peça. Se ativar, enviaremos novidades, boletins e promoções para o endereço da sua conta. Códigos de acesso, recibos e avisos de serviço não mudam. Você pode desativar a qualquer momento, sem fazer login.",
    zh: "Tomverse 尚未向您发送过产品动态，未经您同意也不会发送。开启后，我们会向您账户中的地址发送产品动态、资讯邮件和优惠信息。登录验证码、收据和服务通知不受影响。您可以随时关闭，无需登录。",
  }),
  noticeAccept: Object.freeze({
    ko: "네, 받겠습니다",
    en: "Yes, send them",
    de: "Ja, senden",
    es: "Sí, quiero recibirlas",
    fr: "Oui, envoyez-les",
    pt: "Sim, pode enviar",
    zh: "好，请发送",
  }),
  noticeRefuse: Object.freeze({
    ko: "받지 않겠습니다",
    en: "No, thank you",
    de: "Nein, danke",
    es: "No, gracias",
    fr: "Non, merci",
    pt: "Não, obrigado",
    zh: "不用了",
  }),
  noticeDismiss: Object.freeze({
    ko: "나중에",
    en: "Not now",
    de: "Später",
    es: "Ahora no",
    fr: "Plus tard",
    pt: "Agora não",
    zh: "以后再说",
  }),
});

/**
 * Section 9.2's correction, approved by the owner on 2026-09-29: the Portuguese
 * in-product notice names its reader in the first clause, as the other pronoun
 * languages do. Every other string is the 2026-09-23 wording, unchanged.
 *
 * Written out rather than spread from 2026-09-23: the immutability check reads
 * each version's strings as literals (scripts/check-consent-copy-immutability-core.mjs).
 */
const V2026_09_29: ConsentCopyTable = Object.freeze({
  signupOptIn: Object.freeze({
    ko: "이메일 광고성 정보 수신동의 (선택)",
    en: "Send me product news and offers by email (optional)",
    de: "Produktneuigkeiten und Angebote per E-Mail erhalten (optional)",
    es: "Quiero recibir novedades y ofertas por correo electrónico (opcional)",
    fr: "Recevoir les actualités produit et les offres par e-mail (facultatif)",
    pt: "Quero receber novidades e ofertas por e-mail (opcional)",
    zh: "接收产品资讯和优惠邮件（可选）",
  }),
  signupNotice: Object.freeze({
    ko: "켜시면 계정에 등록된 주소로 제품 소식, 뉴스레터, 프로모션을 보내 드립니다. 로그인 코드, 결제 영수증, 서비스 공지는 이 설정과 무관하게 발송됩니다. 언제든 로그인 없이 끄실 수 있습니다.",
    en: "If you turn this on, Tomverse sends product updates, newsletters and promotions to the address on your account. Sign-in codes, billing receipts and service notices are sent whether or not you turn this on. You can turn it off at any time, without signing in.",
    de: "Wenn Sie dies aktivieren, sendet Tomverse Produkt-Updates, Newsletter und Angebote an die Adresse Ihres Kontos. Anmeldecodes, Rechnungsbelege und Servicehinweise werden unabhängig davon gesendet. Sie können es jederzeit ohne Anmeldung deaktivieren.",
    es: "Si lo activas, Tomverse enviará novedades del producto, boletines y promociones a la dirección de tu cuenta. Los códigos de acceso, los recibos de facturación y los avisos de servicio se envían igualmente. Puedes desactivarlo en cualquier momento, sin iniciar sesión.",
    fr: "Si vous l'activez, Tomverse envoie les actualités produit, les infolettres et les promotions à l'adresse de votre compte. Les codes de connexion, les reçus de facturation et les avis de service sont envoyés dans tous les cas. Vous pouvez le désactiver à tout moment, sans vous connecter.",
    pt: "Se você ativar, a Tomverse envia novidades do produto, boletins e promoções para o endereço da sua conta. Códigos de acesso, recibos de cobrança e avisos de serviço são enviados de qualquer forma. Você pode desativar a qualquer momento, sem fazer login.",
    zh: "开启后，Tomverse 会向您账户中的地址发送产品动态、资讯邮件和优惠信息。登录验证码、账单收据和服务通知无论是否开启都会发送。您可以随时关闭，无需登录。",
  }),
  signupRefuse: Object.freeze({
    ko: "광고성 이메일을 받지 않겠습니다",
    en: "I do not want marketing email",
    de: "Ich möchte keine Werbe-E-Mails erhalten",
    es: "No quiero recibir correos de marketing",
    fr: "Je ne souhaite pas recevoir d'e-mails marketing",
    pt: "Não quero receber e-mails de marketing",
    zh: "我不想接收营销邮件",
  }),
  noticeTitle: Object.freeze({
    ko: "제품 소식을 이메일로 받아보시겠습니까?",
    en: "Would you like product news by email?",
    de: "Möchten Sie Produktneuigkeiten per E-Mail erhalten?",
    es: "¿Quieres recibir novedades del producto por correo?",
    fr: "Souhaitez-vous recevoir les actualités produit par e-mail ?",
    pt: "Quer receber novidades do produto por e-mail?",
    zh: "是否希望通过邮件接收产品动态？",
  }),
  noticeBody: Object.freeze({
    ko: "Tomverse는 지금까지 제품 소식을 보내드린 적이 없고, 요청하지 않으시면 앞으로도 보내지 않습니다. 켜시면 계정에 등록된 주소로 제품 소식, 뉴스레터, 프로모션을 보내 드립니다. 로그인 코드, 영수증, 서비스 공지는 영향을 받지 않습니다. 언제든 로그인 없이 끄실 수 있습니다.",
    en: "Tomverse has not sent you product news, and will not unless you ask. Turning this on sends product updates, newsletters and promotions to the address on your account. Sign-in codes, receipts and service notices are unaffected. You can turn it off at any time, without signing in.",
    de: "Tomverse hat Ihnen bisher keine Produktneuigkeiten gesendet und wird dies ohne Ihre Zustimmung auch nicht tun. Wenn Sie dies aktivieren, senden wir Produkt-Updates, Newsletter und Angebote an die Adresse Ihres Kontos. Anmeldecodes, Belege und Servicehinweise bleiben unberührt. Sie können es jederzeit ohne Anmeldung deaktivieren.",
    es: "Tomverse no te ha enviado novedades del producto y no lo hará a menos que lo pidas. Si lo activas, enviaremos novedades, boletines y promociones a la dirección de tu cuenta. Los códigos de acceso, los recibos y los avisos de servicio no cambian. Puedes desactivarlo en cualquier momento, sin iniciar sesión.",
    fr: "Tomverse ne vous a pas envoyé d'actualités produit et ne le fera pas sans votre demande. Si vous l'activez, nous enverrons les actualités produit, les infolettres et les promotions à l'adresse de votre compte. Les codes de connexion, les reçus et les avis de service ne changent pas. Vous pouvez le désactiver à tout moment, sans vous connecter.",
    pt: "A Tomverse não lhe enviou novidades do produto e não enviará a menos que você peça. Se ativar, enviaremos novidades, boletins e promoções para o endereço da sua conta. Códigos de acesso, recibos e avisos de serviço não mudam. Você pode desativar a qualquer momento, sem fazer login.",
    zh: "Tomverse 尚未向您发送过产品动态，未经您同意也不会发送。开启后，我们会向您账户中的地址发送产品动态、资讯邮件和优惠信息。登录验证码、收据和服务通知不受影响。您可以随时关闭，无需登录。",
  }),
  noticeAccept: Object.freeze({
    ko: "네, 받겠습니다",
    en: "Yes, send them",
    de: "Ja, senden",
    es: "Sí, quiero recibirlas",
    fr: "Oui, envoyez-les",
    pt: "Sim, pode enviar",
    zh: "好，请发送",
  }),
  noticeRefuse: Object.freeze({
    ko: "받지 않겠습니다",
    en: "No, thank you",
    de: "Nein, danke",
    es: "No, gracias",
    fr: "Non, merci",
    pt: "Não, obrigado",
    zh: "不用了",
  }),
  noticeDismiss: Object.freeze({
    ko: "나중에",
    en: "Not now",
    de: "Später",
    es: "Ahora no",
    fr: "Plus tard",
    pt: "Agora não",
    zh: "以后再说",
  }),
});

/**
 * The owner's decision of 2026-09-30 (docs/policy/email-consent-copy-draft.md
 * section 13): the sign-up notice keeps only the sentences the law requires.
 *
 * Two things left devices B and D, in all seven languages. The sentence naming
 * the mail that keeps coming (sign-in codes, receipts, service notices) is gone,
 * and the withdrawal sentence stays without its "without signing in" qualifier.
 * The withdrawal sentence itself stays because GDPR Art 7(3) requires telling a
 * person before they consent that they can withdraw. Unsubscribing still needs
 * no sign-in, and section 13 names the contract that decides it; only the
 * statement of that fact was removed.
 *
 * Device D's first two sentences -- the promise and what turning this on sends
 * -- are the 2026-09-29 bytes, so this version still makes the promise. Every
 * other string is the 2026-09-29 wording, unchanged, and written out rather than
 * spread for the same reason as that version's table.
 */
const V2026_09_30: ConsentCopyTable = Object.freeze({
  signupOptIn: Object.freeze({
    ko: "이메일 광고성 정보 수신동의 (선택)",
    en: "Send me product news and offers by email (optional)",
    de: "Produktneuigkeiten und Angebote per E-Mail erhalten (optional)",
    es: "Quiero recibir novedades y ofertas por correo electrónico (opcional)",
    fr: "Recevoir les actualités produit et les offres par e-mail (facultatif)",
    pt: "Quero receber novidades e ofertas por e-mail (opcional)",
    zh: "接收产品资讯和优惠邮件（可选）",
  }),
  signupNotice: Object.freeze({
    ko: "켜시면 계정에 등록된 주소로 제품 소식, 뉴스레터, 프로모션을 보내 드립니다. 언제든 끄실 수 있습니다.",
    en: "If you turn this on, Tomverse sends product updates, newsletters and promotions to the address on your account. You can turn it off at any time.",
    de: "Wenn Sie dies aktivieren, sendet Tomverse Produkt-Updates, Newsletter und Angebote an die Adresse Ihres Kontos. Sie können es jederzeit deaktivieren.",
    es: "Si lo activas, Tomverse enviará novedades del producto, boletines y promociones a la dirección de tu cuenta. Puedes desactivarlo en cualquier momento.",
    fr: "Si vous l'activez, Tomverse envoie les actualités produit, les infolettres et les promotions à l'adresse de votre compte. Vous pouvez le désactiver à tout moment.",
    pt: "Se você ativar, a Tomverse envia novidades do produto, boletins e promoções para o endereço da sua conta. Você pode desativar a qualquer momento.",
    zh: "开启后，Tomverse 会向您账户中的地址发送产品动态、资讯邮件和优惠信息。您可以随时关闭。",
  }),
  signupRefuse: Object.freeze({
    ko: "광고성 이메일을 받지 않겠습니다",
    en: "I do not want marketing email",
    de: "Ich möchte keine Werbe-E-Mails erhalten",
    es: "No quiero recibir correos de marketing",
    fr: "Je ne souhaite pas recevoir d'e-mails marketing",
    pt: "Não quero receber e-mails de marketing",
    zh: "我不想接收营销邮件",
  }),
  noticeTitle: Object.freeze({
    ko: "제품 소식을 이메일로 받아보시겠습니까?",
    en: "Would you like product news by email?",
    de: "Möchten Sie Produktneuigkeiten per E-Mail erhalten?",
    es: "¿Quieres recibir novedades del producto por correo?",
    fr: "Souhaitez-vous recevoir les actualités produit par e-mail ?",
    pt: "Quer receber novidades do produto por e-mail?",
    zh: "是否希望通过邮件接收产品动态？",
  }),
  noticeBody: Object.freeze({
    ko: "Tomverse는 지금까지 제품 소식을 보내드린 적이 없고, 요청하지 않으시면 앞으로도 보내지 않습니다. 켜시면 계정에 등록된 주소로 제품 소식, 뉴스레터, 프로모션을 보내 드립니다. 언제든 끄실 수 있습니다.",
    en: "Tomverse has not sent you product news, and will not unless you ask. Turning this on sends product updates, newsletters and promotions to the address on your account. You can turn it off at any time.",
    de: "Tomverse hat Ihnen bisher keine Produktneuigkeiten gesendet und wird dies ohne Ihre Zustimmung auch nicht tun. Wenn Sie dies aktivieren, senden wir Produkt-Updates, Newsletter und Angebote an die Adresse Ihres Kontos. Sie können es jederzeit deaktivieren.",
    es: "Tomverse no te ha enviado novedades del producto y no lo hará a menos que lo pidas. Si lo activas, enviaremos novedades, boletines y promociones a la dirección de tu cuenta. Puedes desactivarlo en cualquier momento.",
    fr: "Tomverse ne vous a pas envoyé d'actualités produit et ne le fera pas sans votre demande. Si vous l'activez, nous enverrons les actualités produit, les infolettres et les promotions à l'adresse de votre compte. Vous pouvez le désactiver à tout moment.",
    pt: "A Tomverse não lhe enviou novidades do produto e não enviará a menos que você peça. Se ativar, enviaremos novidades, boletins e promoções para o endereço da sua conta. Você pode desativar a qualquer momento.",
    zh: "Tomverse 尚未向您发送过产品动态，未经您同意也不会发送。开启后，我们会向您账户中的地址发送产品动态、资讯邮件和优惠信息。您可以随时关闭。",
  }),
  noticeAccept: Object.freeze({
    ko: "네, 받겠습니다",
    en: "Yes, send them",
    de: "Ja, senden",
    es: "Sí, quiero recibirlas",
    fr: "Oui, envoyez-les",
    pt: "Sim, pode enviar",
    zh: "好，请发送",
  }),
  noticeRefuse: Object.freeze({
    ko: "받지 않겠습니다",
    en: "No, thank you",
    de: "Nein, danke",
    es: "No, gracias",
    fr: "Non, merci",
    pt: "Não, obrigado",
    zh: "不用了",
  }),
  noticeDismiss: Object.freeze({
    ko: "나중에",
    en: "Not now",
    de: "Später",
    es: "Ahora no",
    fr: "Plus tard",
    pt: "Agora não",
    zh: "以后再说",
  }),
});

/**
 * Every version that has ever been rendered, newest last.
 *
 * Old entries are never removed. A `copyHash` stored against a consent in 2026
 * has to resolve to the words it names for as long as that consent stands, and
 * this list is the only thing that makes that true.
 */
export const CONSENT_COPY_VERSIONS: ReadonlyArray<{
  readonly version: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  /**
   * The section of docs/policy/email-consent-copy-draft.md that holds this
   * version approval record: its table of approved sections and its digest.
   *
   * Named here because section 10 adds a new version as a **new section** and
   * forbids editing an approved one, so the section is part of the version
   * identity. A test that assumed section 8 for every version would have made
   * the second version either rewrite the first record or fail.
   */
  readonly recordSection: string;
  /**
   * The rows of that section approval table: the section the owner approved,
   * and what it says was approved. Held here so a second version brings its own
   * table rather than the test naming one version rows for every version.
   */
  readonly approvedSections: ReadonlyArray<readonly [string, string]>;
  /**
   * The digest of that record section's own bytes in the approved document.
   *
   * The document as a whole is pinned by one digest in
   * `tests/emailConsentCopy.test.mjs`, and that pin has to move whenever a
   * version is added -- legitimately. A review pointed out what that covers
   * for: the same commit could edit an earlier version's approval table and
   * record one new document digest, and nothing would tell the two apart.
   *
   * So each version also pins its own record. Adding a version does not touch
   * these, and an edit to an approved record fails against the version it
   * belongs to rather than against a number that was going to change anyway.
   */
  readonly recordDigest: string;
  /**
   * The digest of the approved sections' bytes, plus this version's record
   * section.
   *
   * The document digest has to move whenever a version is added, legitimately,
   * and a review showed what that covers for: the same commit could edit
   * section 4's approved wording and record one new document digest, and the
   * only per-version pin was over the approval table. So each version also pins
   * the body it approved. Adding a version does not touch this, and section
   * 10.1 forbids changing an existing one's.
   *
   * **Which sections** is not written here. The first version carried the list
   * beside this digest, and a review named what that allowed: drop `"4."` from
   * the list, drop §4's row from the approval table, recompute both digests, and
   * §4's approved wording is editable behind a repin that adding a version would
   * have justified. The list is derived from `approvedSections` -- the table the
   * owner signed -- so narrowing the scope means moving that table.
   */
  readonly approvedBodyDigest: string;
  /**
   * Where this version's four devices live in the approved document: the
   * subsection, the bold label its table follows, and the button table's role
   * row. Held per version because a new version's wording is approved in a new
   * section (section 10), so the location is part of the version and not a
   * constant the tests can assume.
   */
  readonly deviceCells: Readonly<
    Record<ConsentCopyKey, { section: string; label: string | null; role: string | null }>
  >;
  /**
   * The subsection that summarises what this version's devices are, and that
   * table's rows.
   *
   * Held here because the summary is prose about the devices rather than a
   * device, so nothing in `deviceCells` implies it -- and a fifth row there is a
   * fifth approved device that the eight keys would not notice. The rest of a
   * version's structure (which tables, which languages, which button roles) is
   * derived from `deviceCells` and the key and language lists, so only the words
   * are written down.
   */
  readonly deviceSummary: {
    readonly section: string;
    /** The bold label its table follows, or null where the heading introduces it. */
    readonly label: string | null;
    readonly rows: ReadonlyArray<readonly string[]>;
  };
  readonly copy: ConsentCopyTable;
}> = Object.freeze([
  Object.freeze({
    version: "2026-09-23",
    approvedBy: "mposition",
    approvedAt: "2026-09-23",
    recordSection: "8.",
    // Recorded, not computed. Moving it means saying that the owner's record
    // for this version has changed.
    recordDigest: "be4413d4121f878a969425836c394e2f",
    approvedBodyDigest: "d46ce9c67452464ca55f92aa6217c608",
    deviceCells: {
      signupOptIn: { section: "3.A", label: null, role: null },
      signupNotice: { section: "3.B", label: null, role: null },
      signupRefuse: { section: "3.C", label: null, role: null },
      noticeTitle: { section: "3.D", label: "제목", role: null },
      noticeBody: { section: "3.D", label: "본문", role: null },
      noticeAccept: { section: "3.D", label: "세 버튼", role: "동의" },
      noticeRefuse: { section: "3.D", label: "세 버튼", role: "거부" },
      noticeDismiss: { section: "3.D", label: "세 버튼", role: "닫기" },
    },
    deviceSummary: {
      section: "3.0",
      label: null,
      rows: [
        ["#", "장치", "어디에", "무엇을 기록하는가"],
        ["A", "opt-in 체크박스 (미체크 상태)", "가입 흐름", "동의 → DOI"],
        ["B", "고지 문장", "가입 흐름, A 옆", "notice_shown"],
        ["C", "독립 거부 수단", "가입 흐름, A와 별개", "objected"],
        ["D", "제품 내 일회성 안내", "기존 계정의 다음 접속", "A·B·C와 같은 세 상태"],
      ],
    },
    approvedSections: [
      ["§1", "R5 — 철회 시까지"],
      ["§2", "동의 장치는 7개 언어, 법률 문서는 fallback 유지"],
      ["§3.A–D", "동의 장치 4개의 문안"],
      ["§4.1–4.3", "통지 3건의 문안"],
      ["§5", "/terms 조항"],
      ["§6", "/privacy 추가 2문장"],
    ] as const,
    copy: V2026_09_23,
  }),
  Object.freeze({
    version: "2026-09-29",
    approvedBy: "mposition",
    approvedAt: "2026-09-29",
    recordSection: "12.",
    recordDigest: "a1ab24637575e81df497891eb45ee8ad",
    approvedBodyDigest: "479b3052f69e2bb097b4c0eb0ac44730",
    deviceCells: {
      signupOptIn: { section: "11.A", label: null, role: null },
      signupNotice: { section: "11.B", label: null, role: null },
      signupRefuse: { section: "11.C", label: null, role: null },
      noticeTitle: { section: "11.D", label: "제목", role: null },
      noticeBody: { section: "11.D", label: "본문", role: null },
      noticeAccept: { section: "11.D", label: "세 버튼", role: "동의" },
      noticeRefuse: { section: "11.D", label: "세 버튼", role: "거부" },
      noticeDismiss: { section: "11.D", label: "세 버튼", role: "닫기" },
    },
    deviceSummary: {
      section: "11.0",
      label: null,
      rows: [
        ["#", "장치", "어디에", "무엇을 기록하는가"],
        ["A", "opt-in 체크박스 (미체크 상태)", "가입 흐름", "동의 → DOI"],
        ["B", "고지 문장", "가입 흐름, A 옆", "notice_shown"],
        ["C", "독립 거부 수단", "가입 흐름, A와 별개", "objected"],
        ["D", "제품 내 일회성 안내", "기존 계정의 다음 접속", "A·B·C와 같은 세 상태"],
      ],
    },
    approvedSections: [["§11", "동의 장치 4개의 문안 — §9.2 포르투갈어 첫 절 수정"]] as const,
    copy: V2026_09_29,
  }),
  Object.freeze({
    version: "2026-09-30",
    approvedBy: "mposition",
    approvedAt: "2026-09-30",
    recordSection: "14.",
    recordDigest: "477c83bf69ba29319a795f2ee89d93e3",
    approvedBodyDigest: "ed24b041826bdd1c9dceaad49ccea857",
    deviceCells: {
      signupOptIn: { section: "13.A", label: null, role: null },
      signupNotice: { section: "13.B", label: null, role: null },
      signupRefuse: { section: "13.C", label: null, role: null },
      noticeTitle: { section: "13.D", label: "제목", role: null },
      noticeBody: { section: "13.D", label: "본문", role: null },
      noticeAccept: { section: "13.D", label: "세 버튼", role: "동의" },
      noticeRefuse: { section: "13.D", label: "세 버튼", role: "거부" },
      noticeDismiss: { section: "13.D", label: "세 버튼", role: "닫기" },
    },
    deviceSummary: {
      section: "13.0",
      label: null,
      rows: [
        ["#", "장치", "어디에", "무엇을 기록하는가"],
        ["A", "opt-in 체크박스 (미체크 상태)", "가입 흐름", "동의 → DOI"],
        ["B", "고지 문장", "가입 흐름, A 옆", "notice_shown"],
        ["C", "독립 거부 수단", "가입 흐름, A와 별개", "objected"],
        ["D", "제품 내 일회성 안내", "기존 계정의 다음 접속", "A·B·C와 같은 세 상태"],
      ],
    },
    approvedSections: [["§13", "동의 장치 4개의 문안 — B·D 고지에서 법이 요구하지 않는 문구 삭제"]] as const,
    copy: V2026_09_30,
  }),
]);

/**
 * Versions whose wording promises we have not been sending, and will not
 * without being asked.
 *
 * The in-product notice opens with exactly that, in all seven languages, and
 * it is the right thing to say to somebody being asked for the first time
 * (draft section 5.5: these accounts have no basis anywhere, and a
 * policy-change notice does not create one).
 *
 * It is also incompatible with the other approved decision about the same
 * people. The owner decided on 2026-09-16 to send to the existing accounts
 * under `risk_accepted` -- without consent, because detection is unlikely.
 * One such send makes "will not unless you ask" false, and after it "has not
 * sent you" is false too. The `copyHash` stored beside the notice would then
 * be evidence that we showed somebody a promise we had already broken, which
 * is the FTC Section 5 exposure section 5.5 cites rather than a wording nit.
 *
 * The owner chose on 2026-09-23: somebody the override actually mails is not
 * shown this notice, and the override stays. So the promise is only ever made
 * to people it is true of, and the wording needs no change.
 *
 * "Actually mails" is the send's question, not membership: S8a's
 * `overrideWouldSend()` requires the approval to be sealed and unwithdrawn,
 * the current address to match, the jurisdiction to be allowed and the
 * purpose not withdrawn. Membership alone was the first implementation, and it
 * left members who had changed address with neither mail nor a way to consent.
 * And once the notice has been shown, no override applies to that account
 * again (`promised_no_unrequested_send`).
 *
 * `consentCopyPromisesNoUnrequestedSend()` is how a surface asks whether the
 * version it is about to render carries that promise.
 *
 * This decided who is shown the wording. It did not make a consent record:
 * section 5.6 rule 1 says we do not write `ConsentRecord(granted)` for these
 * accounts, and section 9.1.1 of the approved document records why.
 */
/**
 * Which approved versions promise we have not sent and will not unless asked.
 *
 * Every version has to be in here or in `MAKES_NO_SEND_PROMISE_VERSIONS`, and a
 * test fails on one that is in neither: whether a version makes that promise
 * decides whether the `risk_accepted` override may mail the person who was
 * shown it (section 9.1), so a new version inheriting a silent default would
 * decide that by accident.
 */
export const PROMISE_NO_UNREQUESTED_SEND_VERSIONS: ReadonlySet<string> =
  // 2026-09-29 corrects one Portuguese clause and keeps the promise. 2026-09-30
  // drops two disclosures from B and D and keeps D's promise sentence byte for
  // byte.
  new Set(["2026-09-23", "2026-09-29", "2026-09-30"]);

/** Versions that deliberately make no such promise. Empty, and stated. */
export const MAKES_NO_SEND_PROMISE_VERSIONS: ReadonlySet<string> = new Set([]);

/**
 * What a version says about sending unasked, as three answers rather than two.
 *
 * A version this deployment has never seen is not the same fact as a version
 * that deliberately makes no promise, and a review found the boolean below
 * answering both with `false`. Section 9.1 uses that value to decide whether the
 * `risk_accepted` override may mail somebody, so `false` means "no promise was
 * made to this person, the override may send" -- and an unread version string
 * would have said that about somebody nobody has read anything to.
 *
 * Where the unknown string comes from: a `copyHash` resolved from a row written
 * by an older deployment, or by a branch that added a version this one does not
 * have. Neither is hypothetical once two deployments run at once.
 */
export type ConsentCopyPromiseState =
  | "promises_no_unrequested_send"
  | "makes_no_promise"
  | "unknown_version";

export const consentCopyPromiseState = (version: string): ConsentCopyPromiseState => {
  if (PROMISE_NO_UNREQUESTED_SEND_VERSIONS.has(version)) {
    return "promises_no_unrequested_send";
  }
  if (MAKES_NO_SEND_PROMISE_VERSIONS.has(version)) return "makes_no_promise";
  return "unknown_version";
};

/**
 * Whether the override must be held back for somebody shown this version.
 *
 * True for a version that promised, **and for a version this deployment does not
 * know**. The name says "promises", and for an unknown version that is not a
 * claim about what was shown -- it is the only answer that fails in the
 * direction section 9.1 cares about, because the cost of being wrong the other
 * way is mailing somebody who was told we would not.
 *
 * A caller that needs to tell the three apart asks `consentCopyPromiseState()`.
 */
export const consentCopyPromisesNoUnrequestedSend = (version: string) =>
  consentCopyPromiseState(version) !== "makes_no_promise";

/** The version a new render uses. Older versions stay readable above. */
export const CURRENT_CONSENT_COPY_VERSION =
  CONSENT_COPY_VERSIONS[CONSENT_COPY_VERSIONS.length - 1]!.version;

export const consentCopyVersion = (version: string) =>
  CONSENT_COPY_VERSIONS.find((entry) => entry.version === version) ?? null;

/**
 * One approved string, or `null` when that version never held one.
 *
 * `null` rather than a fallback to the current version: a caller resolving an
 * old `copyHash` wants the words that were on the screen, and answering with
 * today's words would be the quiet substitution this whole file exists to
 * prevent.
 */
export const consentCopy = (
  key: ConsentCopyKey,
  language: ConsentCopyLanguage,
  version: string = CURRENT_CONSENT_COPY_VERSION
): string | null => consentCopyVersion(version)?.copy[key]?.[language] ?? null;

/**
 * The bytes a hash is taken over.
 *
 * The version and the key and the language are in it, not just the text. Two
 * devices can legitimately carry the same sentence -- a button label repeated,
 * a translation that happens to match -- and a hash over the text alone would
 * make one `copyHash` name both, so a record of what was on the screen could
 * not say which screen.
 */
export const consentCopyCanonical = (input: {
  version: string;
  key: ConsentCopyKey;
  language: ConsentCopyLanguage;
  text: string;
}): string =>
  JSON.stringify([input.version, input.key, input.language, input.text]);

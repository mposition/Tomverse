/**
 * Fixed keyword lists and the matcher (docs/policy/support-triage.md §1).
 *
 * The only thing a report's text can produce is a flag code from these lists.
 * A flag never lowers anything: it raises priority or sends the report to a
 * person-only lane. There is no model, no scoring and no free text out.
 *
 * Every locale's list is matched against every report. A report's `language`
 * is the submitter's UI language, not the language of its text, and a missed
 * flag (a refund request routed as a general report) costs more than an extra
 * one, which only puts a person on it sooner.
 *
 * Matching: the text is NFKC-normalised and lower-cased. A term in a script
 * that separates words with spaces matches from a word start, as itself or
 * with one English inflection (s, es, d, ed, ing), so "sue" matches "sued"
 * but not "issue" and "court" does not match "courtesy"; German compounds are
 * listed as such. A Hangul or Han term matches as a substring with all
 * whitespace removed from both sides, because spacing in those scripts is
 * optional ("죽고 싶" and "죽고싶" are the same words).
 *
 * Known limit (design T13): a phrasing not on these lists is not flagged. The
 * lists are measured against tests/fixtures/supportTriageKeywords/.
 *
 * Pure: no I/O.
 */
import { KEYWORD_FLAGS } from "./supportTriageCore";

export type KeywordFlag = (typeof KEYWORD_FLAGS)[number];

export const KEYWORD_LOCALES = Object.freeze(["en", "ko", "de", "es", "fr", "pt", "zh"] as const);
export type KeywordLocale = (typeof KEYWORD_LOCALES)[number];

export const SUPPORT_TRIAGE_KEYWORDS: Readonly<Record<KeywordFlag, Readonly<Record<KeywordLocale, readonly string[]>>>> =
  Object.freeze({
    money: Object.freeze({
      en: ["refund", "charged", "overcharged", "double charged", "billing", "billed", "invoice", "payment", "payments", "subscription", "credits", "credit card", "chargeback", "money back", "compensation", "cancel my plan"],
      ko: ["환불", "결제", "청구", "요금", "구독", "크레딧", "이중 결제", "카드 결제", "보상", "돈을 돌려"],
      de: ["rückerstattung", "erstattung", "abbuchung", "abgebucht", "rechnung", "zahlung", "abonnement", "abo", "guthaben", "geld zurück"],
      es: ["reembolso", "cobro", "cobrado", "cobraron", "factura", "pago", "suscripción", "créditos", "devolución", "compensación"],
      fr: ["remboursement", "rembourser", "prélèvement", "prélevé", "facture", "paiement", "abonnement", "crédits", "débité"],
      pt: ["reembolso", "cobrança", "cobrado", "fatura", "pagamento", "assinatura", "créditos", "estorno", "devolução"],
      zh: ["退款", "扣费", "扣費", "付款", "支付", "订阅", "訂閱", "发票", "發票", "额度", "額度", "退钱", "退錢"],
    }),
    account_privacy: Object.freeze({
      en: ["delete my account", "account deletion", "close my account", "personal data", "personal information", "privacy", "gdpr", "my data", "data deletion", "delete my data"],
      ko: ["계정 삭제", "회원 탈퇴", "탈퇴", "개인정보", "개인 정보", "내 데이터", "데이터 삭제"],
      de: ["konto löschen", "kontolöschung", "personenbezogene daten", "datenschutz", "datenschutzerklärung", "datenschutzverletzung", "dsgvo", "meine daten"],
      es: ["eliminar mi cuenta", "borrar mi cuenta", "datos personales", "privacidad", "mis datos"],
      fr: ["supprimer mon compte", "suppression de compte", "données personnelles", "confidentialité", "rgpd", "mes données"],
      pt: ["excluir minha conta", "apagar minha conta", "dados pessoais", "privacidade", "lgpd", "meus dados"],
      zh: ["删除账号", "刪除帳號", "删除我的账号", "刪除我的帳號", "删除账户", "刪除帳戶", "注销账号", "註銷帳號", "注销我的账号", "註銷我的帳號", "个人信息", "個人資料", "隐私", "隱私"],
    }),
    security: Object.freeze({
      en: ["hacked", "security", "vulnerability", "phishing", "unauthorized login", "unauthorised login", "breach", "exploit", "someone logged into my account", "password leak", "account takeover"],
      ko: ["해킹", "보안", "취약점", "피싱", "무단 로그인", "도용", "유출"],
      de: ["gehackt", "sicherheit", "sicherheitslücke", "phishing", "unbefugter zugriff", "datenleck"],
      es: ["hackeado", "hackeada", "hackearon", "seguridad", "vulnerabilidad", "phishing", "acceso no autorizado", "filtración"],
      fr: ["piraté", "sécurité", "vulnérabilité", "hameçonnage", "phishing", "accès non autorisé", "fuite"],
      pt: ["hackeado", "hackeada", "hackearam", "segurança", "vulnerabilidade", "phishing", "acesso não autorizado", "vazamento"],
      zh: ["被盗", "被盜", "黑客", "駭客", "漏洞", "钓鱼", "釣魚", "安全", "泄露", "洩露"],
    }),
    legal: Object.freeze({
      en: ["lawsuit", "lawyer", "attorney", "legal action", "sue", "suing", "copyright", "dmca", "court", "subpoena", "press charges"],
      ko: ["소송", "변호사", "법적", "고소", "저작권", "법원"],
      de: ["klage", "anwalt", "anwältin", "rechtsanwalt", "rechtsanwältin", "rechtliche schritte", "urheberrecht", "gericht"],
      es: ["demanda", "abogado", "acciones legales", "derechos de autor", "tribunal"],
      fr: ["poursuite", "avocat", "action en justice", "droit d'auteur", "tribunal"],
      pt: ["processo judicial", "advogado", "ação judicial", "direitos autorais", "tribunal"],
      zh: ["律师", "律師", "起诉", "起訴", "诉讼", "訴訟", "版权", "版權", "法院"],
    }),
    self_harm_threat: Object.freeze({
      en: ["suicide", "suicidal", "kill myself", "end my life", "self harm", "self-harm", "want to die", "hurt myself"],
      ko: ["자살", "자해", "죽고 싶", "살기 싫", "목숨을 끊"],
      de: ["selbstmord", "suizid", "mich umbringen", "nicht mehr leben"],
      es: ["suicidio", "suicidarme", "quitarme la vida", "autolesión", "quiero morir"],
      fr: ["suicide", "me suicider", "me tuer", "automutilation", "envie de mourir"],
      pt: ["suicídio", "me matar", "tirar minha vida", "automutilação", "quero morrer"],
      zh: ["自杀", "自殺", "自残", "自殘", "不想活", "想死"],
    }),
  });

const normalise = (text: string) => text.normalize("NFKC").toLowerCase();
const unspaced = (text: string) => text.replace(/\s+/gu, "");

/** Hangul or Han anywhere in the term: matched as a substring. */
const UNSPACED_SCRIPT = /[\p{Script=Hangul}\p{Script=Han}]/u;

const escape = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Matcher = { readonly flag: KeywordFlag; readonly test: (text: string) => boolean };

const MATCHERS: readonly Matcher[] = KEYWORD_FLAGS.map((flag) => {
  const terms = KEYWORD_LOCALES.flatMap((locale) => SUPPORT_TRIAGE_KEYWORDS[flag][locale]).map(normalise);
  const substrings = terms.filter((term) => UNSPACED_SCRIPT.test(term)).map(unspaced);
  const words = terms.filter((term) => !UNSPACED_SCRIPT.test(term));
  const wordPattern =
    words.length === 0
      ? null
      : new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(escape).join("|")})(?:s|es|d|ed|ing)?(?![\\p{L}\\p{N}])`, "u");
  return {
    flag,
    test: (text: string) => {
      const compact = unspaced(text);
      return substrings.some((term) => compact.includes(term)) || (wordPattern?.test(text) ?? false);
    },
  };
});

/** The flags a report's text raises, distinct, in `KEYWORD_FLAGS` order. */
export const keywordFlagsIn = (text: string): KeywordFlag[] => {
  if (typeof text !== "string" || text.length === 0) return [];
  const normalised = normalise(text);
  return MATCHERS.filter((matcher) => matcher.test(normalised)).map((matcher) => matcher.flag);
};

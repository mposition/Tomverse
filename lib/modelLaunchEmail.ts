import { EMAIL_FONT_STACK } from "@/lib/emailTypography";
import { isLanguage, type Language } from "@/lib/language";

/**
 * "A new model is available" — template A of the model lifecycle set.
 *
 * Marketing, gated on `product_updates`, and carrying an unsubscribe link,
 * because that is what it is: a product announcement to people who are not
 * affected by anything. Classifying it as `service` to reach an audience that
 * has not opted in is the failure docs/policy/email-notifications.md §3.2 names
 * first, and the template table refuses it -- marketing without an unsubscribe
 * link cannot be registered at all.
 *
 * It exists before anything sends it. The three marketing branches of the
 * standard lane -- the jurisdiction re-check, the `List-Unsubscribe` headers
 * and the marketing sending stream -- had never run, because no marketing
 * template existed to run them (EM-03). A fixture registered only in a test
 * would have proved the lane against a message nobody sends; this is the
 * message, and the first real send is now the second time those branches
 * execute rather than the first.
 *
 * Sending is still refused: `MARKETING_EMAIL_FROM` is unset, marketing is
 * disabled in production, and no caller enqueues this. Registering a template
 * sends nothing.
 *
 * Copy rules: docs/policy/email-notifications.md §3, audit §14.3. No
 * superlative, no capability that a provider's own documentation does not
 * state, the plan and the credit cost on the face of it, and one call to
 * action. `tests/modelLaunchEmail.test.mjs` fails the build on the words.
 */

export type ModelLaunchPayload = {
  modelName: string;
  /** Plans the model is reachable on, already formatted, e.g. "Pro and Max". */
  plans: string;
  /** Short factual lines. Each must be checkable against provider docs. */
  highlights: string[];
  /** What a message costs, e.g. "Premium tier - 12 credits per message". */
  creditLine: string;
  ctaUrl: string;
};

type Copy = {
  subject: (modelName: string) => string;
  lead: (modelName: string, plans: string) => string;
  unchanged: string;
  cta: (modelName: string) => string;
  reason: string;
};

const COPY: Record<Language, Copy> = {
  en: {
    subject: (model) => `${model} is now on Tomverse`,
    lead: (model, plans) => `${model} is available from today on the ${plans} plans.`,
    unchanged:
      "It sits alongside the models you already use; nothing about your current selection changes.",
    cta: (model) => `Try ${model}`,
    reason: "You are receiving this because you asked for product updates.",
  },
  ko: {
    subject: (model) => `${model}을 Tomverse에서 쓸 수 있습니다`,
    lead: (model, plans) => `오늘부터 ${plans} 플랜에서 ${model}을 사용할 수 있습니다.`,
    unchanged: "기존 모델과 함께 제공되며, 지금 쓰고 계신 선택은 바뀌지 않습니다.",
    cta: (model) => `${model} 사용해 보기`,
    reason: "제품 소식 수신에 동의하셔서 보내 드립니다.",
  },
  zh: {
    subject: (model) => `Tomverse 现已提供 ${model}`,
    lead: (model, plans) => `自今日起，${plans} 方案可以使用 ${model}。`,
    unchanged: "它与您正在使用的模型并存，您当前的选择不会发生变化。",
    cta: (model) => `试用 ${model}`,
    reason: "您收到这封邮件，是因为您订阅了产品动态。",
  },
  fr: {
    subject: (model) => `${model} est disponible sur Tomverse`,
    lead: (model, plans) =>
      `${model} est disponible dès aujourd'hui sur les formules ${plans}.`,
    unchanged:
      "Il s'ajoute aux modèles que vous utilisez déjà ; votre sélection actuelle ne change pas.",
    cta: (model) => `Essayer ${model}`,
    reason: "Vous recevez ce message parce que vous avez demandé les nouveautés produit.",
  },
  de: {
    subject: (model) => `${model} ist jetzt auf Tomverse verfügbar`,
    lead: (model, plans) => `${model} ist ab heute in den ${plans}-Tarifen verfügbar.`,
    unchanged:
      "Es kommt zu den Modellen hinzu, die Sie bereits nutzen; an Ihrer aktuellen Auswahl ändert sich nichts.",
    cta: (model) => `${model} ausprobieren`,
    reason: "Sie erhalten diese E-Mail, weil Sie Produktneuigkeiten abonniert haben.",
  },
  es: {
    subject: (model) => `${model} ya está en Tomverse`,
    lead: (model, plans) => `${model} está disponible desde hoy en los planes ${plans}.`,
    unchanged:
      "Se suma a los modelos que ya utiliza; su selección actual no cambia.",
    cta: (model) => `Probar ${model}`,
    reason: "Recibe este mensaje porque solicitó novedades de producto.",
  },
  pt: {
    subject: (model) => `${model} já está no Tomverse`,
    lead: (model, plans) => `${model} está disponível a partir de hoje nos planos ${plans}.`,
    unchanged:
      "Ele se junta aos modelos que você já usa; a sua seleção atual não muda.",
    cta: (model) => `Experimentar ${model}`,
    reason: "Você recebe esta mensagem porque pediu novidades do produto.",
  },
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const resolve = (value: string): Language => (isLanguage(value) ? value : "en");

/**
 * Pure and deterministic, like every template the standard lane renders: the
 * drain re-renders from the stored snapshot on each attempt, and a message that
 * came out differently the second time would stop the provider's idempotency
 * key from suppressing the duplicate.
 */
export function buildModelLaunchEmail(
  payload: ModelLaunchPayload,
  language: string
) {
  const copy = COPY[resolve(language)];
  const lines = [...payload.highlights, payload.creditLine];

  const text = [
    copy.lead(payload.modelName, payload.plans),
    "",
    ...lines.map((line) => `- ${line}`),
    "",
    copy.unchanged,
    "",
    `${copy.cta(payload.modelName)}: ${payload.ctaUrl}`,
    "",
    copy.reason,
  ].join("\n");

  const html = `<div style="font-family:${EMAIL_FONT_STACK};font-size:15px;line-height:1.6;color:#18181b">
  <p>${escapeHtml(copy.lead(payload.modelName, payload.plans))}</p>
  <ul style="padding-left:20px;margin:12px 0">${lines
    .map((line) => `<li style="margin:2px 0">${escapeHtml(line)}</li>`)
    .join("")}</ul>
  <p>${escapeHtml(copy.unchanged)}</p>
  <p style="margin:20px 0"><a href="${escapeHtml(payload.ctaUrl)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700">${escapeHtml(copy.cta(payload.modelName))}</a></p>
  <p style="color:#52525b;font-size:13px">${escapeHtml(copy.reason)}</p>
</div>`;

  return { subject: copy.subject(payload.modelName), html, text };
}

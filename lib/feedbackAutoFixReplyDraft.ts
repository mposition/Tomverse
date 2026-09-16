import { isLanguage, type Language } from "@/lib/language";
import {
  AUTOFIX_CASE_STATE,
} from "@/lib/feedbackAutoFixCore";
import {
  FEEDBACK_USER_REPLY_MAX_LENGTH,
  FEEDBACK_USER_REPLY_MIN_LENGTH,
} from "@/lib/feedbackLifecycleCore";

/**
 * The reply an operator starts from once an approved fix is live in
 * production.
 *
 * It exists only for a case in `production_verified` -- the one state in
 * which "we fixed it and it is released" is an observed fact rather than a
 * hope -- and it is a draft: the operator reads it, may edit it, and sends it
 * with the resolve button. Nothing sends it automatically.
 *
 * Deterministic and template-only. No LLM, no report body, no trace ID, error
 * code, model or PR: the completed email quotes this text to the reporter,
 * and lib/feedbackLifecycleEmails.ts already forbids those identifiers in
 * anything a submitter receives. The reporter's own language is used when it
 * is one the product speaks, English otherwise.
 */

const DRAFTS: Record<Language, string> = {
  en: "Thank you for reporting this error. We found the cause, fixed it, and the fix is now live. If you still see the problem, reply to this email and we will look again.",
  ko: "오류를 알려 주셔서 감사합니다. 원인을 확인해 수정했고, 수정 사항이 지금 서비스에 반영되었습니다. 같은 문제가 계속되면 이 메일에 회신해 주세요. 다시 살펴보겠습니다.",
  zh: "感谢您报告此错误。我们已查明原因并完成修复，修复现已上线。如果问题仍然存在，请回复此邮件，我们会再次检查。",
  fr: "Merci d'avoir signalé cette erreur. Nous en avons trouvé la cause et l'avons corrigée, et le correctif est maintenant en ligne. Si le problème persiste, répondez à cet e-mail et nous examinerons à nouveau.",
  de: "Vielen Dank, dass Sie diesen Fehler gemeldet haben. Wir haben die Ursache gefunden und behoben, die Korrektur ist jetzt live. Falls das Problem weiterhin auftritt, antworten Sie auf diese E-Mail, und wir sehen es uns erneut an.",
  es: "Gracias por informar de este error. Encontramos la causa y la corregimos, y la corrección ya está disponible. Si el problema continúa, responde a este correo y lo revisaremos de nuevo.",
  pt: "Obrigado por relatar este erro. Encontramos a causa e a corrigimos, e a correção já está disponível. Se o problema continuar, responda a este e-mail e vamos analisar novamente.",
};

/** The closure outcome the draft is written for: only `fixed` may say fixed. */
export const AUTOFIX_REPLY_OUTCOME = "fixed" as const;

/**
 * The draft for one report, or null when its case has not been observed live
 * in production -- a staging-only or merely merged fix gets no draft.
 */
export const autoFixReplyDraft = (input: {
  caseState: string | null | undefined;
  language: string | null | undefined;
}): { outcomeCode: typeof AUTOFIX_REPLY_OUTCOME; userReply: string } | null => {
  if (input.caseState !== AUTOFIX_CASE_STATE.productionVerified) return null;
  const language: Language = isLanguage(input.language) ? input.language : "en";
  return { outcomeCode: AUTOFIX_REPLY_OUTCOME, userReply: DRAFTS[language] };
};

/** For the test: every draft must be a valid user reply as written. */
export const AUTOFIX_REPLY_DRAFTS_FOR_TEST = DRAFTS;
export const AUTOFIX_REPLY_LENGTH_BOUNDS = {
  min: FEEDBACK_USER_REPLY_MIN_LENGTH,
  max: FEEDBACK_USER_REPLY_MAX_LENGTH,
};

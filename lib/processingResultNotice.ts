import "server-only";

import { prisma } from "@/lib/prisma";
import {
  CONSENT_RESULT_NOTICE_TEMPLATE,
  UNSUBSCRIBE_RESULT_NOTICE_TEMPLATE,
  emailTemplateDefinition,
} from "@/lib/emailTemplateDefinitions";
import { ensureBootstrapPolicyVersion, ensureTemplateVersion } from "@/lib/emailTemplateRegistry";
import { jurisdictionForUser } from "@/lib/emailJurisdiction";
import type { ResolvedJurisdiction } from "@/lib/emailJurisdictionCore";
import { createStandardDeliveryRows } from "@/lib/standardEmailLane";
import type { ConsentRecordedHook } from "@/lib/emailPreferences";

/**
 * The 14-day processing-result notices (Korea's 정보통신망법 제50조제7항,
 * 시행령 제62조의2): a consent, an unsubscribe or a withdrawal is answered with
 * a short transactional message stating the sender, what was processed, the
 * result and the date.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.7 and
 * docs/policy/email-consent-copy-draft.md sections 4.1 and 4.2 (the approved
 * wording, in lib/emailTemplateDefinitions.ts).
 *
 * - **Queued with the change it reports.** The hook runs inside the transaction
 *   that wrote the change (`onConsentRecorded` in lib/emailPreferences.ts; a
 *   turn-off-all request is one transaction for all its purposes), so a
 *   committed consent or all-marketing withdrawal always has its notice in the
 *   outbox and a rolled-back one never does.
 * - **Prepared before that transaction.** The template versions and the policy
 *   version may insert rows; they run here, outside the caller's transaction,
 *   the way every other standard-lane writer does.
 * - **Sent to every address.** The notice reports a result rather than
 *   advertising anything, so it is transactional and goes to the address that
 *   just unsubscribed. Only Korea requires it; nothing makes it wrong
 *   elsewhere, and choosing recipients by a resolved country would drop the
 *   Korean ones whose country is not yet known.
 */

/** The date on the Asia/Seoul calendar, as the Korean decree counts days. */
export const processingResultDate = (at: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

/** The notice language: Korean for a Korean-language account, English otherwise. */
const noticeLanguage = (language: string | null | undefined) => (language === "ko" ? "ko" : "en");

/**
 * Prepares the hook that queues the right notice for the consent record a
 * preference change writes: `granted` and `reconfirmed` answer with the
 * consent notice, `withdrawn` with the unsubscribe notice. Other actions
 * (requests, lapses) are not processing results and queue nothing.
 */
export async function prepareProcessingResultNotice(
  userId: string,
  options: {
    /**
     * Whether this request stops every marketing purpose (the unsubscribe
     * link's `all`, the settings screen's "turn off all"). The approved
     * unsubscribe notice says marketing email to this address stops; only a
     * request that does that may send it. A single purpose's withdrawal
     * queues nothing until a purpose-scoped wording is approved
     * (docs/policy/email-product-news-redesign-draft.md 7.7).
     */
    stopsAllMarketing?: boolean;
    /**
     * The jurisdiction the recorded change was decided under, when the user
     * row does not hold it yet: a sign-up consents in the transaction that
     * records its estimated country, after this hook is prepared
     * (docs/policy/email-double-opt-in.md §14.6).
     */
    jurisdiction?: ResolvedJurisdiction;
  } = {}
): Promise<ConsentRecordedHook> {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { language: true },
  });
  const language = noticeLanguage(settings?.language);
  const [consentTemplate, unsubscribeTemplate, policyVersionId, jurisdiction] = await Promise.all([
    ensureTemplateVersion({ templateKey: CONSENT_RESULT_NOTICE_TEMPLATE, language }),
    ensureTemplateVersion({ templateKey: UNSUBSCRIBE_RESULT_NOTICE_TEMPLATE, language }),
    ensureBootstrapPolicyVersion(),
    options.jurisdiction ?? jurisdictionForUser({ userId }),
  ]);

  return async (tx, record) => {
    const kind =
      record.action === "granted" || record.action === "reconfirmed"
        ? "consent"
        : record.action === "withdrawn" && options.stopsAllMarketing
          ? "unsubscribe"
          : null;
    if (!kind) return;
    const template = kind === "consent" ? consentTemplate : unsubscribeTemplate;
    await createStandardDeliveryRows(tx, {
      templateKey: kind === "consent" ? CONSENT_RESULT_NOTICE_TEMPLATE : UNSUBSCRIBE_RESULT_NOTICE_TEMPLATE,
      emailAddress: record.emailAddress,
      userId: record.userId,
      language,
      payload: { date: processingResultDate(record.occurredAt) },
      referenceType: record.referenceType,
      referenceId: record.id,
      ...template,
      policyVersionId,
      jurisdictionCountry: jurisdiction.countryCode,
      jurisdictionProfileKey: jurisdiction.profileKey,
    });
  };
}

/**
 * The readiness behind Korea's `consent_result_notice_14_days` duty: both
 * notices are registered and render. Whether a given change queued one is the
 * transaction's business; this answers whether the build can.
 */
export const processingResultNoticeReady = (): boolean => {
  try {
    for (const key of [CONSENT_RESULT_NOTICE_TEMPLATE, UNSUBSCRIBE_RESULT_NOTICE_TEMPLATE]) {
      const definition = emailTemplateDefinition(key);
      const rendered = definition.render(definition.placeholderPayload, "ko");
      if (!rendered.subject || !rendered.text) return false;
    }
    return true;
  } catch {
    return false;
  }
};

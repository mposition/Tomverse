import "server-only";

import {
  LOCKED_EMAIL_PURPOSES,
  isEmailPurpose,
  type EmailPurpose,
} from "@/lib/emailPreferenceCore";
import {
  applyPreferenceChange,
  ensureDefaultPreferences,
  lockUserEmail,
} from "@/lib/emailPreferences";
import {
  normalizeSuppressionAddress,
  recordSuppression,
  type RecordSuppressionInput,
} from "@/lib/emailSuppression";
import { holdSuppressionFence } from "@/lib/emailSuppressionAuthority";
import { prisma } from "@/lib/prisma";

/**
 * A spam complaint: the suppression, and the opt-out from the purpose of the
 * message complained about.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
 * (complaint is also a purpose opt-out; user attribution; representation).
 */

export type ComplaintDelivery = {
  id: string;
  userId: string | null;
  emailAddress: string;
  purpose: string | null;
  policyVersionId: string;
  jurisdictionCountry: string;
};

/**
 * The purpose a complaint opts out of: the one the delivery was sent under,
 * when it is a purpose a person may switch off. Security and billing mail cannot
 * be switched off, and a complaint about it changes no preference.
 */
export const complaintOptOutPurpose = (purpose: string | null): EmailPurpose | null =>
  purpose && isEmailPurpose(purpose) && !LOCKED_EMAIL_PURPOSES.has(purpose) ? purpose : null;

export async function recordProviderComplaint(input: {
  /** The global complaint cause, as the webhook handler builds it. */
  suppression: RecordSuppressionInput;
  delivery: ComplaintDelivery | null;
  webhookEventId: string;
  occurredAt: Date;
}) {
  const purpose = complaintOptOutPurpose(input.delivery?.purpose ?? null);
  const delivery = input.delivery;
  const userId = purpose && delivery?.userId ? delivery.userId : null;

  return prisma.$transaction(
    async (tx) => {
      await holdSuppressionFence(tx);

      // Preferences and consent belong to a person, suppressions to a mailbox.
      // The person is the one the message was sent to, and only while that
      // account still has the address it was sent to: a changed or reused
      // address belongs to somebody who did not complain.
      let attributable = false;
      if (userId && delivery) {
        const current = await lockUserEmail(tx, userId);
        attributable =
          current !== null &&
          normalizeSuppressionAddress(current) ===
            normalizeSuppressionAddress(delivery.emailAddress);
      }

      await recordSuppression(input.suppression, tx);
      if (!purpose || !delivery) return { purpose: null, attributed: false };

      // The purpose stop first, whether or not anyone could be attributed and
      // whether or not the preference was already off: it is keyed to the
      // mailbox, so the purpose stays stopped after an operator lifts the
      // complaint.
      const purposeEventKey = `webhook:${input.webhookEventId}:purpose`;
      const purposeStop = await recordSuppression(
        {
          emailAddress: delivery.emailAddress,
          purposeKey: purpose,
          reason: "unsubscribe",
          source: "provider_webhook",
          sourceEventKey: purposeEventKey,
          sourceDeliveryId: delivery.id,
          occurredAt: input.occurredAt,
        },
        tx
      );

      // A redelivered event has already had its effect. Applying the opt-out
      // again would switch off a preference the person has since switched back
      // on, with no new cause behind it.
      if (purposeStop.duplicate) return { purpose, attributed: attributable, duplicate: true };

      if (attributable && userId) {
        // Created here, under the User row lock that established the account
        // still exists, so a deleted account cannot fail the transaction.
        await ensureDefaultPreferences(userId, tx);
        // The withdrawal names the conditions the message went out under -- its
        // policy version and jurisdiction -- because the complaint is a reaction
        // to that message, not to whatever applies today.
        await applyPreferenceChange(tx, {
          userId,
          purpose,
          enabled: false,
          capturedVia: "provider_complaint",
          source: "provider_complaint",
          deliveryId: delivery.id,
          jurisdiction: delivery.jurisdictionCountry,
          jurisdictionSource: "delivery_pinned",
          policyVersionId: delivery.policyVersionId,
          confirmedCountry: null,
          now: input.occurredAt,
          suppressionEventKey: purposeEventKey,
          suppressionSource: "provider_webhook",
        });
      }
      return { purpose, attributed: attributable };
    },
    { timeout: 20_000 }
  );
}

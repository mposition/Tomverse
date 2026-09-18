import "server-only";

import { sendTransactionalEmail } from "@/lib/email";
import type { SenderRole } from "@/lib/emailSendingIdentityCore";
import {
  classifyNotificationError,
  type NotificationAttemptOutcome,
} from "@/lib/notificationRetryCore";

/**
 * The queue's operator alerts, and the only place they reach the provider.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.4 (C41),
 * docs/policy/email-notifications.md section 9.8.
 *
 * Split out of `lib/notificationDeliveries.ts` because the allowlist that
 * `scripts/check-send-entry-points.mjs` enforces is **per file**. The queue
 * carries both kinds -- notices to a customer and alerts to the team -- and a
 * file holding both cannot be allowlisted without also allowing a customer send
 * to skip the address lock in the same file, which is exactly the bypass the
 * check exists to catch. So the operator half lives here, this module is on the
 * allowlist, and `notificationDeliveries.ts` is not.
 *
 * **These deliberately do not take the address lock or ask suppression.** They
 * go to our own mailboxes about somebody else's record: a hard bounce on a
 * customer's address has no bearing on whether the team hears about their
 * report, and a queue-level stop that silenced them would hide the reports
 * rather than the mail.
 */
export async function sendOperatorNotification(input: {
  message: { to: string; subject: string; html: string; text: string };
  senderRole: SenderRole;
  /**
   * The queue row's id, which doubles as the provider idempotency key so every
   * attempt at this alert presents the same one.
   */
  deliveryId: string;
}): Promise<NotificationAttemptOutcome> {
  try {
    const result = await sendTransactionalEmail({
      ...input.message,
      senderRole: input.senderRole,
      idempotencyKey: `notification-delivery:${input.deliveryId}`,
    });
    if (result.skipped) return { kind: "not_configured" };
    return { kind: "delivered" };
  } catch (error) {
    // The throwing shape, kept: the retry policy for these reads the status
    // back out of the message, and that prefix is a contract with
    // `classifyNotificationError` (lib/notificationRetryCore.ts).
    const { errorKind, permanent } = classifyNotificationError(error);
    return { kind: "failed", errorKind, permanent };
  }
}

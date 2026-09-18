import "server-only";

import { sendTransactionalEmail } from "@/lib/email";
import type { SenderRole } from "@/lib/emailSendingIdentityCore";
import {
  classifyNotificationError,
  type NotificationAttemptOutcome,
} from "@/lib/notificationRetryCore";
import { supportNotificationRecipient } from "@/lib/supportNotificationEmail";

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
 *
 * **Which is why it decides the recipient itself.** A module on the allowlist
 * that took an address from its caller would be a way to send anywhere without
 * the lock, and the file-level check would pass it -- the bypass moved rather
 * than closed (independent review, 2026-09-18). The operator address is the one
 * this deployment is configured with, and anything else is refused.
 */

export type OperatorNotificationRefusal =
  /** No operator address is configured, so there is nobody to alert. */
  | "no_operator_address"
  /**
   * The caller asked for an address that is not the operator's. Refused rather
   * than sent: a customer address here would be a send that skipped the address
   * lock and the suppression check.
   */
  | "not_the_operator_address";

export async function sendOperatorNotification(input: {
  message: { to: string; subject: string; html: string; text: string };
  senderRole: SenderRole;
  /**
   * The queue row's id, which doubles as the provider idempotency key so every
   * attempt at this alert presents the same one.
   */
  deliveryId: string;
}): Promise<NotificationAttemptOutcome> {
  const operator = supportNotificationRecipient();
  if (!operator) {
    return { kind: "unsendable", reason: "no_operator_address" };
  }
  if (input.message.to.trim().toLowerCase() !== operator.trim().toLowerCase()) {
    // Not "send it anyway": the address this was asked to write to is not the
    // one this module exists for, and the only way that happens is a caller
    // using it to reach somewhere else.
    console.error(
      JSON.stringify({
        event: "operator_notification_recipient_refused",
        deliveryId: input.deliveryId,
        senderRole: input.senderRole,
      })
    );
    return { kind: "unsendable", reason: "not_the_operator_address" };
  }

  try {
    const result = await sendTransactionalEmail({
      ...input.message,
      // The configured address, not the one that arrived. They are equal by the
      // check above; using this one means a later change to that check cannot
      // leave an unvalidated address on the wire.
      to: operator,
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

import "server-only";

import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";

const RENEWING_STATUSES = new Set(["active", "trialing", "past_due"]);
/**
 * Each Stripe request gives up well inside the transaction, so the lock is
 * never released while this call still waits on Stripe. A request that gave up
 * may still be applied by Stripe afterwards; that residue only ever errs toward
 * the cancellation (no charge), and the customer sees it in Settings > Plan and
 * can turn renewal back on (docs/policy/plan-change.md section 10).
 */
const STRIPE_REQUEST_TIMEOUT_MS = 8_000;
const TRANSACTION_TIMEOUT_MS = 20_000;

export type DeletionCancellationOutcome = {
  /** The account was scheduled for deletion when the row lock was taken. */
  pendingDeletion: boolean;
  /** This call turned a renewing subscription's cancellation back on. */
  cancelled: boolean;
};

/**
 * An account scheduled for deletion never renews (docs/policy/plan-change.md
 * section 10). The one place that turns the cancellation back on.
 *
 * The account row is locked (`SELECT ... FOR UPDATE`) for the whole check and
 * Stripe write. Restoring an account updates that row, so a restore -- and the
 * customer's own renewal resume after it -- waits for this call instead of
 * being undone by it, and a restore that committed first means the row no
 * longer matches and nothing is written. The subscription is read from Stripe
 * inside the lock, so the write is decided on what Stripe has now.
 *
 * Called by the deletion flow after it records pending_deletion, by the renewal
 * resume route after its own write, and by every subscription resync from the
 * webhook. Stripe errors are thrown; each caller decides what a failure means.
 */
export async function keepDeletionCancellation(
  subscriptionId: string
): Promise<DeletionCancellationOutcome> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "User"
        WHERE "stripeSubscriptionId" = ${subscriptionId}
          AND "accountStatus" = 'pending_deletion'
        FOR UPDATE`;
      if (rows.length === 0) return { pendingDeletion: false, cancelled: false };

      const stripe = getStripe();
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {}, {
        timeout: STRIPE_REQUEST_TIMEOUT_MS,
      });
      if (subscription.cancel_at_period_end || !RENEWING_STATUSES.has(subscription.status)) {
        return { pendingDeletion: true, cancelled: false };
      }
      await stripe.subscriptions.update(
        subscriptionId,
        { cancel_at_period_end: true },
        { timeout: STRIPE_REQUEST_TIMEOUT_MS }
      );
      console.warn("billing.subscription.deletion_cancellation_restored", {
        userId: rows[0]!.id,
        subscriptionId,
      });
      return { pendingDeletion: true, cancelled: true };
    },
    { timeout: TRANSACTION_TIMEOUT_MS }
  );
}

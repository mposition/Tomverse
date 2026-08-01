import "server-only";

import {
  DEFAULT_PROCESSING_STALE_AFTER_MS,
  REFUND_STATUS,
  decideReconciliation,
  findRefundForRequest,
  type StripeRefundSnapshot,
} from "@/lib/refundSagaCore";
import {
  NOTIFICATION_KIND,
  enqueueNotificationDelivery,
} from "@/lib/notificationDeliveries";
import { prisma } from "@/lib/prisma";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

/**
 * Resolves refund requests stranded in `processing`.
 *
 * A refund crosses two systems that cannot share a transaction. The route
 * claims `processing` before calling Stripe and leaves it only after the local
 * commit, so anything that dies in between -- a deploy, a timeout, a crash --
 * leaves the row here. That is the one state where money may have moved with
 * nothing recording it, and it is the state this pass exists to clear.
 *
 * It never decides from elapsed time alone. Age only decides when to *ask*
 * Stripe; Stripe's answer decides the outcome:
 *
 *  - a refund exists for this request -> finish what the crashed attempt
 *    started, recording the real refund id, and queue the customer's mail
 *  - no refund exists -> release the claim so an administrator can try again
 *
 * Inventing either answer would be worse than leaving the row alone, which is
 * why an unreachable Stripe leaves it untouched.
 */

export type RefundReconciliationResult = {
  examined: number;
  completed: number;
  released: number;
  waiting: number;
  unresolved: number;
};

/** Reads Stripe for the refund belonging to this request, if any. */
const findProviderRefund = async (
  requestId: string,
  chargeId: string | null,
  subscriptionId: string | null
): Promise<StripeRefundSnapshot | null> => {
  const stripe = getStripe();
  if (chargeId) {
    const refunds = await stripe.refunds.list({ charge: chargeId, limit: 100 });
    return findRefundForRequest(requestId, refunds.data);
  }
  if (!subscriptionId) return null;
  // No charge recorded locally -- the crash may have happened before it was
  // written. Walk back to the charge the same way the approval path does.
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["latest_invoice.payment_intent"],
  });
  const latestInvoice = subscription.latest_invoice;
  const invoice =
    typeof latestInvoice === "string"
      ? await stripe.invoices.retrieve(latestInvoice, {
          expand: ["payment_intent"],
        })
      : latestInvoice;
  const paymentIntent = (
    invoice as { payment_intent?: string | { id?: string } } | null
  )?.payment_intent;
  const paymentIntentId =
    typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id;
  if (!paymentIntentId) return null;
  const charges = await stripe.charges.list({
    payment_intent: paymentIntentId,
    limit: 1,
  });
  const charge = charges.data[0];
  if (!charge) return null;
  const refunds = await stripe.refunds.list({ charge: charge.id, limit: 100 });
  return findRefundForRequest(requestId, refunds.data);
};

export const reconcileProcessingRefundRequests = async ({
  now = new Date(),
  limit = 100,
  staleAfterMs = DEFAULT_PROCESSING_STALE_AFTER_MS,
}: {
  now?: Date;
  limit?: number;
  staleAfterMs?: number;
} = {}): Promise<RefundReconciliationResult> => {
  const result: RefundReconciliationResult = {
    examined: 0,
    completed: 0,
    released: 0,
    waiting: 0,
    unresolved: 0,
  };

  const stranded = await prisma.refundRequest.findMany({
    where: { status: REFUND_STATUS.processing },
    orderBy: { processingStartedAt: "asc" },
    take: limit,
  });
  if (stranded.length === 0) return result;

  for (const request of stranded) {
    result.examined += 1;

    // Age first, so a request still in flight is never reconciled out from
    // under itself -- and so a healthy queue costs no Stripe calls at all.
    // This has to precede the Stripe check as well, or an unconfigured
    // deployment would report every in-flight refund as unresolved.
    const preliminary = decideReconciliation({
      status: request.status,
      processingStartedAt: request.processingStartedAt,
      providerRefund: null,
      now,
      staleAfterMs,
    });
    if (preliminary.action === "wait") {
      result.waiting += 1;
      continue;
    }
    if (preliminary.action === "skip") {
      result.unresolved += 1;
      continue;
    }

    // Without Stripe there is no answer to be had, and guessing is the one
    // thing this must not do. Reported so a misconfigured deployment is
    // visible rather than silently accumulating stranded refunds.
    if (!isStripeConfigured()) {
      result.unresolved += 1;
      console.error(
        JSON.stringify({
          event: "refund_reconciliation_skipped",
          reason: "stripe_not_configured",
          refundRequestId: request.id,
        })
      );
      continue;
    }

    let providerRefund: StripeRefundSnapshot | null = null;
    try {
      providerRefund = await findProviderRefund(
        request.id,
        request.stripeChargeId,
        request.stripeSubscriptionId
      );
    } catch (error) {
      // Leave it exactly as it is: another pass will ask again. Only the error
      // class is logged, never a Stripe payload.
      result.unresolved += 1;
      console.error(
        JSON.stringify({
          event: "refund_reconciliation_lookup_failed",
          refundRequestId: request.id,
          reason: error instanceof Error ? error.name : "unknown",
        })
      );
      continue;
    }

    const decision = decideReconciliation({
      status: request.status,
      processingStartedAt: request.processingStartedAt,
      providerRefund,
      now,
      staleAfterMs,
    });

    if (decision.action === "release") {
      // Conditional on `processing`, so a request that finished normally in
      // the meantime is never dragged back to `pending`.
      const released = await prisma.refundRequest.updateMany({
        where: { id: request.id, status: REFUND_STATUS.processing },
        data: { status: REFUND_STATUS.pending, processingStartedAt: null },
      });
      if (released.count === 1) {
        result.released += 1;
        await prisma.refundRequestTimelineEvent.create({
          data: {
            refundRequestId: request.id,
            eventType: "processing_released",
            message:
              "An approval attempt did not complete and no refund was found at the payment provider. The request is open again.",
          },
        });
      }
      continue;
    }

    if (decision.action === "complete") {
      // The money moved and the crash lost the record of it. Everything below
      // commits together, exactly as the route's own approval does.
      const completed = await prisma.$transaction(async (tx) => {
        const claimed = await tx.refundRequest.updateMany({
          where: { id: request.id, status: REFUND_STATUS.processing },
          data: {
            status: "approved",
            processingStartedAt: null,
            reviewedAt: request.reviewedAt || now,
            stripeRefundId: decision.refund.id,
            stripeRefundStatus: decision.refund.status || "pending",
            stripeChargeId: decision.refund.chargeId || request.stripeChargeId,
            refundAmountCents:
              decision.refund.amountCents ?? request.refundAmountCents,
            refundCurrency: decision.refund.currency || request.refundCurrency,
          },
        });
        if (claimed.count !== 1) return false;

        await tx.refundRequestTimelineEvent.create({
          data: {
            refundRequestId: request.id,
            eventType: "approved",
            message:
              "Recovered by reconciliation: the refund had already been issued by the payment provider, but the approval did not finish recording it.",
            metadata: {
              stripeRefundId: decision.refund.id,
              stripeRefundStatus: decision.refund.status,
              refundAmountCents: decision.refund.amountCents,
              reconciled: true,
            },
          },
        });

        if (request.userId) {
          await tx.user.update({
            where: { id: request.userId },
            data: {
              plan: "Free",
              stripeCustomerId: null,
              stripeSubscriptionId: null,
              stripePriceId: null,
              subscriptionStatus: "cancelled_by_admin",
              subscriptionCurrentPeriodEnd: null,
              subscriptionBillingInterval: null,
            },
          });
        }
        if (request.stripeSubscriptionId) {
          await tx.billingTransaction.updateMany({
            where: { stripeSubscriptionId: request.stripeSubscriptionId },
            data: { status: "refunded" },
          });
        }

        // The customer is still owed the decision email the crashed attempt
        // never queued. Committed with the decision, like every other path.
        await enqueueNotificationDelivery(tx, {
          kind: NOTIFICATION_KIND.refundRequestApproved,
          referenceId: request.id,
        });
        return true;
      });
      if (completed) {
        result.completed += 1;
        console.warn(
          JSON.stringify({
            event: "refund_reconciliation_completed",
            refundRequestId: request.id,
            stripeRefundId: decision.refund.id,
          })
        );
      }
    }
  }

  return result;
};

/**
 * The form the maintenance cron calls: never throws, so it cannot turn a
 * successful reconciliation run into a failed one. A pass that dies is worth
 * knowing about, but not at the cost of the job it rides along with -- the
 * stranded rows are still there for the next tick.
 */
export const reconcileProcessingRefundRequestsQuietly = async (options?: {
  now?: Date;
  limit?: number;
  staleAfterMs?: number;
}): Promise<RefundReconciliationResult & { failed?: true }> => {
  try {
    return await reconcileProcessingRefundRequests(options);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "refund_reconciliation_failed",
        reason: error instanceof Error ? error.name : "unknown",
      })
    );
    return {
      examined: 0,
      completed: 0,
      released: 0,
      waiting: 0,
      unresolved: 0,
      failed: true,
    };
  }
};

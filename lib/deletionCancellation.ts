import "server-only";

import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";

const RENEWING_STATUSES = new Set(["active", "trialing", "past_due"]);
/**
 * Every Stripe request inside the lock draws on one budget that ends well
 * before the transaction does, so the lock is never released while this call
 * still waits on Stripe -- however many requests it makes and however slow the
 * first ones were. A request that gave up may still be applied by Stripe
 * afterwards; that residue only ever errs toward the cancellation (no charge),
 * and the customer sees it in Settings > Plan (docs/policy/plan-change.md
 * section 10).
 */
const STRIPE_REQUEST_TIMEOUT_MS = 8_000;
const STRIPE_BUDGET_MS = 15_000;
const TRANSACTION_TIMEOUT_MS = 20_000;

/** Request options for the next Stripe call, or a throw once the budget is spent. */
export function stripeLockBudget(budgetMs = STRIPE_BUDGET_MS, now: () => number = Date.now) {
  const deadline = now() + budgetMs;
  return () => {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error("Stripe request budget inside the account lock is spent.");
    }
    // No SDK retries: a retry would start its own timeout and could outlive
    // the lock. A failure throws instead, and each caller has its own retry
    // (the webhook's redelivery) or reports it.
    return { timeout: Math.min(STRIPE_REQUEST_TIMEOUT_MS, remaining), maxNetworkRetries: 0 };
  };
}

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
      // Started with the transaction, so waiting for the row lock counts too.
      const budget = stripeLockBudget();
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "User"
        WHERE "stripeSubscriptionId" = ${subscriptionId}
          AND "accountStatus" = 'pending_deletion'
        FOR UPDATE`;
      if (rows.length === 0) return { pendingDeletion: false, cancelled: false };

      const stripe = getStripe();
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {}, budget());
      if (subscription.cancel_at_period_end || !RENEWING_STATUSES.has(subscription.status)) {
        return { pendingDeletion: true, cancelled: false };
      }
      await stripe.subscriptions.update(
        subscriptionId,
        { cancel_at_period_end: true },
        budget()
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

/**
 * Run by the deletion flow once pending_deletion is committed. A renewal
 * invoice created before that commit had its `invoice.created` handled while
 * the account was still active, so nothing stopped it; the drafts still open on
 * the subscription are looked up now and stopped the same way. One created
 * after the commit is stopped by its own webhook. Returns how many were stopped.
 */
export async function stopDeletionPendingDraftRenewals(subscriptionId: string): Promise<number> {
  const drafts = await getStripe().invoices.list(
    { subscription: subscriptionId, status: "draft", limit: 10 },
    { timeout: STRIPE_REQUEST_TIMEOUT_MS }
  );
  let stopped = 0;
  for (const invoice of drafts.data) {
    if (invoice.billing_reason !== "subscription_cycle" || !invoice.id) continue;
    const outcome = await stopDeletionPendingRenewal({ subscriptionId, invoiceId: invoice.id });
    if (outcome.cancelled) stopped += 1;
  }
  return stopped;
}

export type DeletionRenewalOutcome = {
  /** The account was scheduled for deletion when the row lock was taken. */
  pendingDeletion: boolean;
  /** This call ended the subscription, so its renewal invoice is never collected. */
  cancelled: boolean;
  /** The renewal invoice had already left draft before this call saw it. */
  invoiceFinalized: boolean;
};

/**
 * The last line behind {@link keepDeletionCancellation}: an account scheduled
 * for deletion whose subscription renewed anyway (a renewal resume Stripe
 * applied late, then the period ended before its webhook re-cancelled) is never
 * charged for that renewal (docs/policy/plan-change.md section 10).
 *
 * Driven by `invoice.created` for a `subscription_cycle` invoice. Stripe keeps
 * a renewal invoice in draft for about an hour and holds its finalization (up
 * to 72 hours) while that webhook fails, so a failure here throws and the
 * charge waits for the redelivery. Ending the subscription turns off automatic
 * collection on its draft and open invoices; a subscription invoice cannot be
 * deleted, so that is what stops the charge.
 *
 * Same row lock as above: a restore committed first means the row no longer
 * matches and the renewal goes ahead, which is what a restored account wants.
 */
export async function stopDeletionPendingRenewal({
  subscriptionId,
  invoiceId,
}: {
  subscriptionId: string;
  invoiceId: string;
}): Promise<DeletionRenewalOutcome> {
  return prisma.$transaction(
    async (tx) => {
      // Started with the transaction, so waiting for the row lock counts too.
      const budget = stripeLockBudget();
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "User"
        WHERE "stripeSubscriptionId" = ${subscriptionId}
          AND "accountStatus" = 'pending_deletion'
        FOR UPDATE`;
      if (rows.length === 0) {
        return { pendingDeletion: false, cancelled: false, invoiceFinalized: false };
      }

      const stripe = getStripe();
      const invoice = await stripe.invoices.retrieve(invoiceId, {}, budget());
      const invoiceFinalized = invoice.status !== "draft";
      // A renewal that was already paid is a refund for a person to decide,
      // not something to cancel over: ending the subscription now would take
      // the period the customer just paid for and still leave the charge.
      if (invoice.status === "paid") {
        return { pendingDeletion: true, cancelled: false, invoiceFinalized };
      }
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {}, budget());
      if (subscription.status === "canceled") {
        return { pendingDeletion: true, cancelled: false, invoiceFinalized };
      }
      await stripe.subscriptions.cancel(
        subscriptionId,
        { prorate: false, invoice_now: false },
        budget()
      );
      console.warn("billing.subscription.deletion_renewal_stopped", {
        userId: rows[0]!.id,
        subscriptionId,
        invoiceId,
      });
      return { pendingDeletion: true, cancelled: true, invoiceFinalized };
    },
    { timeout: TRANSACTION_TIMEOUT_MS }
  );
}

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

/** Far beyond any real subscription; bounds the deletion request if Stripe returns more. */
const RENEWAL_SCAN_LIMIT = 500;

/**
 * Run by the deletion flow once pending_deletion is committed. A renewal
 * invoice created before that commit had its `invoice.created` handled while
 * the account was still active, so nothing stopped it. The subscription's
 * uncollected renewals -- still draft, or already finalized (`open`) and
 * waiting on payment -- are all found first, and then the subscription is
 * ended once: that stops collection on every one of them, and nothing is read
 * after the cancellation (whose webhook clears the account's subscription id).
 * One created after the commit is stopped by its own webhook.
 *
 * `finalized` counts the open renewals found: their collection is stopped too,
 * but an open invoice can still be paid by hand, so a person checks them.
 */
export async function stopDeletionPendingDraftRenewals(
  subscriptionId: string
): Promise<{ stopped: number; finalized: number }> {
  const renewals: { id: string; status: string }[] = [];
  let scanned = 0;
  let complete = true;
  scan: for (const status of ["open", "draft"] as const) {
    // Every page: manual invoices on the subscription must not hide a renewal.
    for await (const invoice of getStripe().invoices.list(
      { subscription: subscriptionId, status, limit: 100 },
      { timeout: STRIPE_REQUEST_TIMEOUT_MS }
    )) {
      scanned += 1;
      if (scanned > RENEWAL_SCAN_LIMIT) {
        complete = false;
        break scan;
      }
      if (invoice.billing_reason === "subscription_cycle" && invoice.id) {
        renewals.push({ id: invoice.id, status });
      }
    }
  }
  // Renewals found open, plus any that left draft between the list and its
  // re-read under the lock: all of them are for a person to check.
  const finalizedIds = new Set(
    renewals.filter((renewal) => renewal.status === "open").map((renewal) => renewal.id)
  );
  // Each renewal until one ends the subscription: one paid in the meantime is
  // left for a person (see stopDeletionPendingRenewal) and must not stop the
  // check of the others.
  let stopped = 0;
  let index = 0;
  for (; index < renewals.length; index += 1) {
    const renewal = renewals[index]!;
    const outcome = await stopDeletionPendingRenewal({ subscriptionId, invoiceId: renewal.id });
    if (!outcome.pendingDeletion) break;
    if (outcome.invoiceFinalized) finalizedIds.add(renewal.id);
    if (outcome.cancelled) {
      stopped = 1;
      index += 1;
      break;
    }
  }
  // The rest are re-read once the cancellation has turned off their
  // collection: one that left draft before it is for a person to check.
  if (stopped) {
    for (const renewal of renewals.slice(index)) {
      if (finalizedIds.has(renewal.id)) continue;
      const current = await getStripe().invoices.retrieve(renewal.id, {}, {
        timeout: STRIPE_REQUEST_TIMEOUT_MS,
      });
      if (current.status !== "draft") finalizedIds.add(renewal.id);
    }
  }
  // An incomplete scan is a failure for the caller to report: a renewal past
  // the limit may still be collected.
  if (!complete) {
    throw new Error("Uncollected invoices on the subscription exceed the scan limit.");
  }
  return { stopped, finalized: finalizedIds.size };
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
      // Only a renewal Stripe can still collect (draft, or open and awaiting
      // payment) is a reason to end the subscription. A paid one is a refund
      // for a person to decide -- ending the subscription now would take the
      // period just paid for and still leave the charge -- and a void or
      // uncollectible one is no longer collected at all.
      if (invoice.status !== "draft" && invoice.status !== "open") {
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

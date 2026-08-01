/**
 * The decisions in the refund saga that do not need a database or Stripe.
 *
 * A refund spans two systems that cannot share a transaction: Stripe moves the
 * money, PostgreSQL records that it moved. Something has to decide what a
 * half-finished attempt means, and that decision is the part worth testing on
 * its own.
 *
 * The shape:
 *
 *   pending ──claim──▶ processing ──▶ approved
 *                          │
 *                          └──release──▶ pending
 *
 * `processing` is claimed *before* the Stripe call and left only after the
 * local commit. So a crash anywhere in between leaves the row in `processing`,
 * which is the one state that says "money may have moved, and nobody wrote it
 * down". Reconciliation resolves it by asking Stripe.
 */

export const REFUND_STATUS = {
  pending: "pending",
  processing: "processing",
  approved: "approved",
  rejected: "rejected",
} as const;

export type RefundStatus = (typeof REFUND_STATUS)[keyof typeof REFUND_STATUS];

/**
 * The idempotency key presented to Stripe when creating a refund.
 *
 * Scoped to the refund request, so every attempt at the same request -- the
 * original, a retry after a crash, a reconciliation pass -- presents the same
 * key. Stripe answers a repeat from its record of the first, so the second
 * attempt returns the original refund instead of issuing another one. That is
 * what makes the window between `refunds.create` and the local commit safe to
 * re-enter.
 *
 * Stripe keys expire after 24 hours, which is why reconciliation matches on
 * refund metadata as well rather than relying on the key alone.
 */
export const refundIdempotencyKey = (requestId: string) =>
  `tomverse-refund-request:${requestId}`;

/**
 * Written into the Stripe refund's metadata so a later pass can find it.
 *
 * The previous value was the literal string "true", which said a refund came
 * from Tomverse but not which request it belonged to -- so a refund that
 * succeeded while the local write failed could not be matched back to anything.
 */
export const REFUND_REQUEST_METADATA_KEY = "tomverseRefundRequestId";

/**
 * How long a request may sit in `processing` before it is treated as abandoned.
 *
 * Comfortably longer than an approval takes -- the Stripe calls, the
 * cancellation and one transaction -- so a slow request in flight is never
 * mistaken for a crashed one and reconciled out from under itself.
 */
export const DEFAULT_PROCESSING_STALE_AFTER_MS = 10 * 60 * 1_000;

export type StripeRefundSnapshot = {
  id: string;
  status: string | null;
  amountCents: number | null;
  currency: string | null;
  chargeId: string | null;
};

export type ReconciliationDecision =
  | { action: "wait"; reason: "still_recent" }
  | { action: "complete"; refund: StripeRefundSnapshot }
  | { action: "release"; reason: "no_refund_at_provider" }
  | { action: "skip"; reason: "not_processing" | "no_started_at" };

/**
 * What to do with a request sitting in `processing`.
 *
 * `complete` and `release` are deliberately the only two resolutions, and they
 * are decided by Stripe's answer rather than by elapsed time: a refund that
 * exists must be recorded, and a refund that does not exist must not be
 * invented. Time only decides *when to ask*.
 */
export const decideReconciliation = ({
  status,
  processingStartedAt,
  providerRefund,
  now,
  staleAfterMs = DEFAULT_PROCESSING_STALE_AFTER_MS,
}: {
  status: string;
  processingStartedAt: Date | null;
  /** The refund Stripe holds for this request, or null if it holds none. */
  providerRefund: StripeRefundSnapshot | null;
  now: Date;
  staleAfterMs?: number;
}): ReconciliationDecision => {
  if (status !== REFUND_STATUS.processing) {
    return { action: "skip", reason: "not_processing" };
  }
  if (!processingStartedAt) {
    // A processing row with no timestamp cannot be aged, so it cannot be judged
    // abandoned. Left alone rather than guessed at.
    return { action: "skip", reason: "no_started_at" };
  }
  if (now.getTime() - processingStartedAt.getTime() < staleAfterMs) {
    return { action: "wait", reason: "still_recent" };
  }
  if (providerRefund) return { action: "complete", refund: providerRefund };
  return { action: "release", reason: "no_refund_at_provider" };
};

/**
 * Picks this request's refund out of the ones Stripe holds for a charge.
 *
 * Matches on the metadata written at creation time, never on amount or
 * timing: a charge can carry several partial refunds, and matching the wrong
 * one would record someone else's money against this request.
 */
export const findRefundForRequest = (
  requestId: string,
  refunds: Array<{
    id: string;
    status?: string | null;
    amount?: number | null;
    currency?: string | null;
    /** Stripe returns either the id or the expanded object. */
    charge?: string | { id?: string } | null;
    metadata?: Record<string, string> | null;
  }>
): StripeRefundSnapshot | null => {
  const match = refunds.find(
    (refund) => refund.metadata?.[REFUND_REQUEST_METADATA_KEY] === requestId
  );
  if (!match) return null;
  return {
    id: match.id,
    status: match.status ?? null,
    amountCents: typeof match.amount === "number" ? match.amount : null,
    currency: match.currency ? match.currency.toUpperCase() : null,
    chargeId:
      typeof match.charge === "string"
        ? match.charge
        : match.charge?.id || null,
  };
};

import { formatBillingMinor, normalizeBillingCurrency } from "@/lib/billingMarkets";

/**
 * What approving a refund request actually did.
 *
 * `PATCH /api/admin/refund-requests/:id` always resets the customer to Free and
 * cancels the subscription, but whether money moved depends on what Stripe had:
 *
 * | `stripeRefundStatus` | What happened |
 * |---|---|
 * | `succeeded` | A Stripe refund completed. |
 * | `pending` (or any other Stripe status) | A refund was created and is still settling. |
 * | `no_payment_intent` | The subscription had no payment to refund. |
 * | `no_charge` | The payment intent had no charge. |
 * | `already_refunded` | The charge was refunded before this request. |
 * | `null` | Stripe is not configured, or the account had no subscription. |
 *
 * The console used to say "Refund request approved. The user was moved to
 * Free." for every one of those. Four of the six move no money at all, and an
 * operator reading that sentence has no way to tell which they got -- on a
 * financial action, from a message that is the only feedback they receive.
 */

export type AdminRefundApprovalResult = {
  stripeRefundStatus?: string | null;
  stripeRefundId?: string | null;
  refundAmountCents?: number | null;
  refundCurrency?: string | null;
};

export type AdminRefundOutcome = {
  message: string;
  /**
   * `success` only when Stripe actually refunded. Everything else is `info`:
   * the request was approved, but no money moved and somebody may still have
   * to act.
   */
  tone: "success" | "info";
  /** True when a Stripe refund exists for this request. */
  refunded: boolean;
};

const APPROVED_AND_DOWNGRADED =
  "Refund request approved, the subscription cancelled, and the account reset to Free.";

const amountLabel = (result: AdminRefundApprovalResult) => {
  if (typeof result.refundAmountCents !== "number") return null;
  const currency = normalizeBillingCurrency(result.refundCurrency || "") || "USD";
  return formatBillingMinor(result.refundAmountCents, currency, "en");
};

export const describeRefundApproval = (
  result: AdminRefundApprovalResult
): AdminRefundOutcome => {
  const status = (result.stripeRefundStatus || "").trim();
  const amount = amountLabel(result);

  if (status === "succeeded") {
    return {
      message: `${APPROVED_AND_DOWNGRADED} Stripe refunded ${amount || "the charge"}.`,
      tone: "success",
      refunded: true,
    };
  }

  if (result.stripeRefundId || status === "pending") {
    return {
      message: `${APPROVED_AND_DOWNGRADED} A Stripe refund of ${amount || "the charge"} was created and is still ${status || "pending"} -- confirm it settles.`,
      tone: "info",
      refunded: true,
    };
  }

  if (status === "no_payment_intent") {
    return {
      message: `${APPROVED_AND_DOWNGRADED} No Stripe payment was found for the subscription, so no money was refunded.`,
      tone: "info",
      refunded: false,
    };
  }

  if (status === "no_charge") {
    return {
      message: `${APPROVED_AND_DOWNGRADED} The Stripe payment had no charge to refund, so no money was refunded.`,
      tone: "info",
      refunded: false,
    };
  }

  if (status === "already_refunded") {
    return {
      message: `${APPROVED_AND_DOWNGRADED} The charge was already refunded, so no new refund was created.`,
      tone: "info",
      refunded: false,
    };
  }

  if (!status) {
    return {
      message: `${APPROVED_AND_DOWNGRADED} No Stripe refund was created -- the account had no Stripe subscription, or Stripe is not configured.`,
      tone: "info",
      refunded: false,
    };
  }

  // An unrecognised Stripe status is reported verbatim rather than guessed at.
  return {
    message: `${APPROVED_AND_DOWNGRADED} Stripe reported refund status "${status}" -- check the charge before telling the customer.`,
    tone: "info",
    refunded: false,
  };
};

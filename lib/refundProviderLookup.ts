import "server-only";

import type Stripe from "stripe";
import {
  findRefundForRequest,
  type StripeRefundSnapshot,
} from "@/lib/refundSagaCore";

/**
 * Finds the refund Stripe already holds for a refund request, if any.
 *
 * Shared by the approval path and by reconciliation, because they are asking
 * the same question at different moments and must not answer it differently.
 *
 * ## Why the approval path asks at all
 *
 * The refund carries a request-scoped idempotency key, so a retry inside
 * Stripe's replay window is answered from the first call rather than issuing a
 * second refund. **That window is 24 hours.** A request stranded longer than
 * that -- a Stripe outage, a database outage, a queue that backed up over a
 * weekend -- comes back with the key expired, and to Stripe the retry is then
 * an ordinary new request. Nothing in the key mechanism prevents a second
 * refund at that point.
 *
 * Looking the refund up by metadata closes it, because metadata does not
 * expire. The rule the approval path follows is: **ask before creating, and
 * if one already exists, adopt it rather than making another.**
 *
 * ## Why the pages are walked
 *
 * `refunds.list` returns at most 100 per page. A charge that has accumulated
 * more than that -- many partial refunds, or a busy shared charge -- would
 * push an older refund off the first page, and a single-page lookup would
 * answer "no refund exists" about a refund that does. That answer is the one
 * that costs money twice, so every page is read.
 */

/** Bounds the walk so a pathological charge cannot hang a request. */
const MAX_PAGES = 20;

export const findRefundForRequestAtProvider = async (
  stripe: Stripe,
  requestId: string,
  chargeId: string
): Promise<StripeRefundSnapshot | null> => {
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const refunds = await stripe.refunds.list({
      charge: chargeId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const match = findRefundForRequest(requestId, refunds.data);
    if (match) return match;
    if (!refunds.has_more || refunds.data.length === 0) return null;
    startingAfter = refunds.data[refunds.data.length - 1]?.id;
    if (!startingAfter) return null;
  }
  // Ran out of pages without an answer. Reporting "none found" here would be a
  // guess in the direction that refunds twice, so it is refused instead.
  throw new Error(
    `Could not determine whether a refund already exists for ${requestId}: more than ${MAX_PAGES * 100} refunds on the charge.`
  );
};

/**
 * Whether this account would be offered Auto, as the server sees it.
 *
 * Lifted out of `app/api/conversations/[conversationId]/route.ts` when a
 * second caller appeared (`POST /api/products/chat/conversations`). Two
 * routes computing availability separately is exactly the drift the UI
 * contract §1 warns about: the screen and the execution would be free to
 * disagree, and the user would see a control that saves and changes nothing.
 *
 * The flag is checked before the plan is fetched, so a deployment with the
 * rollout off pays nothing for it -- no extra query on a route that loads on
 * every conversation open. That is the difference between a feature that is
 * disabled and one that is merely hidden.
 *
 * Signed-in only: both callers require a session, so `isGuest` is always false
 * here. Guests are excluded from the cohort anyway (their conversation-scoped
 * sticky state does not survive), and saying so in one place beats threading a
 * constant through.
 *
 * **This is availability, not the product decision.** Decision record v1.2 §3
 * requires the product to be settled *before* the cohort is consulted, and one
 * shared function to serve surface entry, `offered` and turn routing. When
 * that function lands it wraps this one; until then this is what all callers
 * read, so at least they agree with each other.
 */

import { autoUiAvailability, isAutoRouterUiEnabled } from "@/lib/autoRoutingUi";
import { getUserBillingPlan } from "@/lib/billingEntitlements";

export const autoAvailabilityFor = async (
  userId: string,
  /**
   * The conversation this is being asked about, or nothing at all.
   *
   * Passing `{ productKey }` says a row exists and this is its stored value --
   * read under an ownership check by the caller, never a request body, a
   * Referer, or the surface the client was on. A NULL stored value on an
   * existing row is resolved through PRODUCT_KEY_READ_MODE, which is Review
   * during the transition.
   *
   * Omitting it says there is no conversation: the surface-entry question,
   * "may this account start a Chat".
   */
  conversation?: { productKey: string | null }
) => {
  if (!isAutoRouterUiEnabled()) {
    return { offered: false, reason: "ui_flag_off" as const, cohort: null };
  }
  const billingPlan = await getUserBillingPlan(userId);
  return autoUiAvailability({
    subjectKey: userId,
    isGuest: false,
    plan: billingPlan.tier,
    productKey: conversation?.productKey ?? null,
    hasConversation: conversation !== undefined,
  });
};

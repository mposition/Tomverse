import type { MobileBillingState } from "./billingClient";

export type PurchaseObservation = {
  before: MobileBillingState;
  productId: string;
};
export type PurchaseConfirmation = { kind: "credits"; credits: number } | { kind: "subscription"; plan: string };

// Presentation only: never infer an entitlement from SDK success or mutate balances.
export function confirmedPurchase(observation: PurchaseObservation, state: MobileBillingState): PurchaseConfirmation | null {
  const { before, productId } = observation;
  if (before.billingId !== state.billingId) return null;
  const product = before.products.find(item => item.productId === productId);
  if (!product) return null;
  if (product.kind === "credits") {
    const credits = product.credits;
    // A consumed, refunded, overlapping or unverified balance change stays unconfirmed.
    return credits && credits > 0 && !state.creditPurchasesNeedingReview && state.purchasedCredits - before.purchasedCredits === credits
      ? { kind: "credits", credits } : null;
  }
  return state.active && !state.verificationPending && !state.subscriptionPurchaseAttempt &&
    state.subscriptionStore === product.store && state.productId === product.productId &&
    state.plan === product.plan && state.interval === product.interval
    ? { kind: "subscription", plan: product.plan } : null;
}

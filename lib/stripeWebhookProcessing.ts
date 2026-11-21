import "server-only";

import type Stripe from "stripe";
import { getBillingPlans, tierForPlanId, type BillingPlanId } from "@/lib/billingConfig";
import { resolveBillingPeriodEnd } from "@/lib/billingEmails";
import { recordBillingCountry } from "@/lib/emailJurisdiction";
import { BILLING_WELCOME_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import { enqueueStandardEmail } from "@/lib/standardEmailLane";
import {
  encodePromotionRiskFlags,
  hashPaymentMethodFingerprint,
  parsePromotionRiskFlags,
  paymentMethodFingerprint,
  releasePromotionCheckout,
} from "@/lib/billingPromotionSecurity";
import { prisma } from "@/lib/prisma";
import { alertOnPromotionBurst } from "@/lib/promotionBurstAlert";
import { getStripe } from "@/lib/stripe";
import {
  analyticsAttributionFromMetadata,
  recordProductAnalyticsEvent,
} from "@/lib/productAnalyticsServer";
import { purchaseAnalyticsFromMetadata } from "@/lib/purchaseAnalytics";
import {
  grantCreditPackFromCheckout,
  handleCreditPackDisputeClosed,
  handleCreditPackDispute,
  handleCreditPackDisputeReinstated,
  handleCreditPackRefund,
} from "@/lib/creditPurchase";
import {
  billingSnapshotFromCheckoutSession,
  recordBillingTransactionFromCheckout,
  type CheckoutBillingSnapshot,
} from "@/lib/billingTransactions";
import {
  billingMinorToMajor,
  normalizeBillingCurrency,
} from "@/lib/billingMarkets";
import { getUsdRevenueSnapshot } from "@/lib/billingPriceCatalog";
import { settlePlanChangesForSubscription } from "@/lib/planChangeService";
import {
  isSubscriptionResyncEvent,
  shouldApplySubscriptionSnapshot,
  subscriptionIdFromEventObject,
} from "@/lib/stripeWebhookSyncCore";
import { applyWebSubscriptionSnapshot } from "@/lib/subscriptionEntitlements";

const subscriptionActiveStatuses = new Set(["active", "trialing", "past_due"]);

const normalizePlanId = (value: unknown): BillingPlanId | null =>
  value === "pro" || value === "max" || value === "free" ? value : null;

const getPeriodEnd = (subscription: Stripe.Subscription) => {
  const value = (subscription as unknown as { current_period_end?: number })
    .current_period_end;
  return typeof value === "number" ? new Date(value * 1000) : null;
};

const getBillingInterval = (
  subscription: Stripe.Subscription
): "monthly" | "annual" | null => {
  const interval = subscription.items.data[0]?.price.recurring?.interval;
  if (interval === "year") return "annual";
  if (interval === "month") return "monthly";
  const metadataInterval = subscription.metadata.billingInterval;
  return metadataInterval === "annual" || metadataInterval === "monthly"
    ? metadataInterval
    : null;
};

const addBillingPeriod = (
  date: Date,
  billingInterval: "monthly" | "annual" | null
) => {
  const next = new Date(date);
  if (billingInterval === "annual") {
    next.setUTCFullYear(next.getUTCFullYear() + 1);
  } else {
    next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next;
};

/**
 * Applies a subscription snapshot that was read from Stripe at `observedAt`.
 *
 * `observedAt` is not decoration. Stripe delivers webhooks out of order, so two
 * handlers can be applying different reads of the same subscription
 * concurrently; the conditional update is what stops the older read from
 * winning. It is expressed as a `updateMany` predicate rather than a
 * read-then-write so the comparison and the write are one statement and cannot
 * interleave.
 */
async function syncSubscription(
  subscription: Stripe.Subscription,
  observedAt: Date,
  options: { promotionDecided?: boolean } = {}
) {
  if (
    !options.promotionDecided &&
    (await promotionCardLimitWithholds(subscription))
  ) {
    console.warn(
      JSON.stringify({
        event: "promotion_payment_method_limit_sync_withheld",
        subscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
      })
    );
    return null;
  }
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  const price = subscription.items.data[0]?.price;
  const priceId = price?.id || null;
  const productId = price
    ? typeof price.product === "string"
      ? price.product
      : price.product.id
    : null;
  const plans = await getBillingPlans();
  const planByPrice = priceId
    ? plans.find(
        (plan) =>
          plan.stripePriceId === priceId || plan.stripeAnnualPriceId === priceId
      )
    : null;
  const planByProduct = productId
    ? plans.find((plan) => plan.stripeProductId === productId)
    : null;
  // What Stripe invoices decides the plan, and metadata is only the fallback.
  // Metadata is a note written when the subscription was created; a plan change
  // replaces the item's price, so reading metadata first would leave an
  // upgraded account on the plan it used to have.
  const planId =
    planByPrice?.id ??
    planByProduct?.id ??
    normalizePlanId(subscription.metadata.planId);
  const active = subscriptionActiveStatuses.has(subscription.status);
  const plan = active && planId ? tierForPlanId(planId) : "Free";
  const billingInterval = getBillingInterval(subscription);
  const periodEnd =
    getPeriodEnd(subscription) || addBillingPeriod(new Date(), billingInterval);

  const user = await prisma.user.findFirst({
    where: { stripeCustomerId: customerId },
    select: {
      id: true,
      email: true,
      subscriptionStore: true,
      plan: true,
      subscriptionStatus: true,
      subscriptionCurrentPeriodEnd: true,
      subscriptionSyncedAt: true,
      settings: {
        select: { language: true },
      },
    },
  });
  if (!user) return null;

  const decision = shouldApplySubscriptionSnapshot({
    storedObservedAt: user.subscriptionSyncedAt,
    observedAt,
  });
  if (!decision.apply) {
    console.warn("Stripe subscription snapshot ignored as stale.", {
      subscriptionId: subscription.id,
      storedObservedAt: user.subscriptionSyncedAt?.toISOString() || null,
      observedAt: observedAt.toISOString(),
    });
    return null;
  }

  const applied = await applyWebSubscriptionSnapshot({
    userId: user.id, plan, subscriptionId: subscription.id, priceId,
    status: subscription.status, periodEnd, interval: billingInterval,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end), observedAt,
  });
  // A concurrent handler applied a newer read between the select and the
  // update. Its state is the correct one, so this snapshot is dropped rather
  // than retried -- retrying would only race again.
  if (!applied) return null;

  return { user, plan, periodEnd, billingInterval };
}

/**
 * Re-reads a subscription from Stripe and applies it.
 *
 * This is the whole point of the hardening: the webhook payload says *that*
 * something changed, and Stripe says *what it is now*. A failure here is left
 * to throw so the route answers 500 and Stripe redelivers -- applying the
 * event's own stale snapshot as a fallback is exactly the behaviour being
 * removed.
 */
export async function resyncSubscriptionFromStripe(
  subscriptionId: string,
  eventType: string | null = null
) {
  // Stamped before the request, not after: a response only proves the state as
  // of when Stripe built it, so timestamping on arrival would let a slow read
  // of older data outrank a fast read of newer data.
  const observedAt = new Date();
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  const synced = await syncSubscription(subscription, observedAt);
  // After the account, not before: a reservation is settled by comparing what
  // was reserved against what the subscription now bills, and that comparison
  // wants the same freshly read subscription rather than a second retrieve.
  await settlePlanChangesForSubscription(subscription, eventType);
  return synced;
}

export type BillingResyncOutcome = {
  result: "synced" | "cleared" | "no_subscription";
  plan: "Free" | "Pro" | "Max";
  subscriptionStatus: string | null;
  stripeSubscriptionId: string | null;
  observedAt: Date;
};

/**
 * Brings one account's stored billing state back in line with Stripe.
 *
 * Used by the admin resync endpoint. The webhook path already re-reads on every
 * event, but that only repairs accounts whose events arrive -- a dropped
 * delivery or a change made in the Stripe dashboard leaves an account stale
 * with nothing to correct it.
 *
 * When Stripe has no subscription for the customer at all, the account is
 * cleared to Free rather than left alone. That is the honest outcome of "make
 * the database say what Stripe says", and it is what a resync is for; the
 * caller audit-logs it.
 */
export async function resyncAccountBillingFromStripe({
  userId,
  stripeCustomerId,
  stripeSubscriptionId,
}: {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
}): Promise<BillingResyncOutcome> {
  const stripe = getStripe();
  const observedAt = new Date();

  let subscription: Stripe.Subscription | null = null;
  if (stripeSubscriptionId) {
    try {
      subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    } catch (error) {
      // A subscription id that Stripe no longer knows is not a failure to
      // report -- it is the answer. Fall through to the customer lookup.
      console.warn("Stored Stripe subscription could not be retrieved.", {
        stripeSubscriptionId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  if (!subscription) {
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 10,
    });
    // Prefer a live subscription over a cancelled one; among equals take the
    // most recently created, which is what `list` already returns first.
    subscription =
      subscriptions.data.find((candidate) =>
        subscriptionActiveStatuses.has(candidate.status)
      ) ||
      subscriptions.data[0] ||
      null;
  }

  if (!subscription) {
    const cleared = await applyWebSubscriptionSnapshot({
      userId, subscriptionId: null, priceId: null, plan: "Free",
      status: null, interval: null, cancelAtPeriodEnd: false, observedAt,
    });
    return {
      result: cleared ? "cleared" : "no_subscription",
      plan: "Free",
      subscriptionStatus: null,
      stripeSubscriptionId: null,
      observedAt,
    };
  }

  const synced = await syncSubscription(subscription, observedAt);
  return {
    result: synced ? "synced" : "no_subscription",
    plan: synced?.plan ?? "Free",
    subscriptionStatus: subscription.status,
    stripeSubscriptionId: subscription.id,
    observedAt,
  };
}

/**
 * A promotion redemption that could not be recorded for a reason a redelivery
 * would not change: the promotion row is gone. Stripe has already applied the
 * discount, so the plan is still granted. (A promotion that was switched off
 * or ran out mid-checkout is still recorded -- see
 * `recordPromotionRedemptionFromCheckout`.) Any other error is left to fail
 * the webhook so Stripe delivers it again.
 */
class PromotionRedemptionNotRecorded extends Error {}

const isUniqueViolation = (error: unknown) =>
  Boolean(
    error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "P2002"
  );

/**
 * Whether a sync of this subscription must not grant its plan because the
 * per-card limit refused it, or has not decided yet.
 *
 * Asked by every sync, not only by checkout completion: Stripe delivers
 * `customer.subscription.created`, `invoice.paid` and the completion in any
 * order, and each resyncs the subscription. Only the completion decides the
 * limit -- under the card lock, and it records the decision -- so a sync that
 * arrives before it waits: it grants nothing until the completion has either
 * recorded a redemption or granted the subscription to the account itself. A
 * read-only count here could not see a concurrent completion on the same card
 * and would let two accounts in through one remaining place.
 *
 * Every zero-charge promotion checkout waits (`billingExpectedAmountMinor`
 * "0"), whatever the promotion's per-card limit is set to right now: the
 * setting can change while a checkout is in flight, and the completion reads
 * it again under the lock. A paid one is never refused, so it has nothing to
 * wait for.
 */
async function promotionCardLimitWithholds(subscription: Stripe.Subscription) {
  const promotionId = subscription.metadata?.promotionId;
  const userId = subscription.metadata?.userId;
  if (!promotionId || !userId) return false;
  const recorded = await prisma.billingPromotionRedemption.findFirst({
    where: { stripeSubscriptionId: subscription.id },
    select: { riskFlags: true },
  });
  if (recorded) {
    return parsePromotionRiskFlags(recorded.riskFlags).includes(
      "payment_method_limit"
    );
  }
  if (subscription.metadata?.billingExpectedAmountMinor !== "0") return false;
  // No redemption recorded: either the completion has not run, or it ran
  // without recording (promotion row gone) and granted the plan anyway -- in
  // which case the account already carries this subscription.
  const account = await prisma.user.findFirst({
    where: { id: userId },
    select: { stripeSubscriptionId: true },
  });
  return account?.stripeSubscriptionId !== subscription.id;
}

/**
 * What a completion that hit a unique violation had decided. Either the same
 * Checkout Session was recorded by a concurrent delivery -- its stored answer
 * stands -- or this account already redeemed the promotion through another
 * Session, in which case a zero-charge duplicate is refused like an over-limit
 * card: the account has had the promotion once.
 */
async function redemptionAfterUniqueViolation(
  session: Stripe.Checkout.Session,
  promotionId: string
): Promise<PromotionRedemptionOutcome> {
  const stored = await prisma.billingPromotionRedemption.findUnique({
    where: { stripeCheckoutSessionId: session.id },
    select: { riskFlags: true },
  });
  if (stored) {
    return {
      promotionId,
      refused: parsePromotionRiskFlags(stored.riskFlags).includes(
        "payment_method_limit"
      ),
    };
  }
  return { promotionId, refused: session.amount_total === 0 };
}

/**
 * What recording the checkout's promotion decided. `refused` means the card
 * was over the promotion's per-card limit: the redemption is recorded with the
 * `payment_method_limit` flag, nothing is counted against the promotion, and
 * the caller must cancel the subscription instead of granting the plan.
 */
type PromotionRedemptionOutcome = { promotionId: string; refused: boolean };

async function recordPromotionRedemptionFromCheckout(
  session: Stripe.Checkout.Session,
  subscriptionId: string,
  paymentMethodFingerprintHash: string | null,
  /** The checkout charged nothing; only then does the per-card limit refuse. */
  chargedNothing: boolean
): Promise<PromotionRedemptionOutcome | null> {
  const promotionId = session.metadata?.promotionId || null;
  const planId = normalizePlanId(session.metadata?.planId);
  const billingInterval = session.metadata?.billingInterval;
  const userId =
    session.client_reference_id ||
    (typeof session.metadata?.userId === "string" ? session.metadata.userId : null);

  if (
    !promotionId ||
    !userId ||
    !planId ||
    (billingInterval !== "monthly" && billingInterval !== "annual")
  ) {
    return null;
  }

  const clientIpHash = /^[a-f0-9]{64}$/.test(
    session.metadata?.promotionIpHash || ""
  )
    ? session.metadata?.promotionIpHash || null
    : null;
  const metadataRiskFlags = parsePromotionRiskFlags(
    session.metadata?.promotionRiskFlags
  );

  try {
    return await prisma.$transaction(async (tx) => {
      // First, before the promotion's current policy is read: a redelivered
      // webhook answers what the first delivery decided, so a refusal whose
      // cancellation failed is retried even if the promotion has since been
      // switched off -- otherwise the retry would fall through to granting
      // the plan.
      const existing = await tx.billingPromotionRedemption.findUnique({
        where: { stripeCheckoutSessionId: session.id },
        select: { riskFlags: true },
      });
      if (existing) {
        return {
          promotionId,
          refused: parsePromotionRiskFlags(existing.riskFlags).includes(
            "payment_method_limit"
          ),
        };
      }

      const promotion = await tx.billingPromotion.findUnique({
        where: { id: promotionId },
        select: {
          id: true,
          isActive: true,
          maxRedemptions: true,
          startsAt: true,
          endsAt: true,
          appliesToPlanIds: true,
          allowAnnualStacking: true,
          maxRedemptionsPerPaymentMethod: true,
        },
      });
      if (!promotion) {
        throw new PromotionRedemptionNotRecorded("Promotion no longer exists.");
      }
      const now = new Date();
      let eligiblePlanIds: unknown = [];
      try {
        eligiblePlanIds = JSON.parse(promotion.appliesToPlanIds || "[]");
      } catch {
        eligiblePlanIds = [];
      }

      // Closed since the checkout started: switched off, expired, or no longer
      // covering this plan. Stripe has already applied the discount, so the
      // plan is still granted as before -- but the completion is still
      // recorded, under the card lock below, so it counts against the card. A
      // closed promotion is not a way past the per-card limit. It is not
      // counted against the promotion's own redemptions.
      const maxRedemptions = promotion.maxRedemptions;
      const promotionOpen = Boolean(
        promotion.isActive &&
          maxRedemptions &&
          promotion.endsAt &&
          !(promotion.startsAt && promotion.startsAt > now) &&
          promotion.endsAt > now &&
          Array.isArray(eligiblePlanIds) &&
          eligiblePlanIds.includes(planId) &&
          !(billingInterval === "annual" && !promotion.allowAnnualStacking)
      );

      // Other accounts this card has already redeemed this promotion on,
      // fetched only as far as the limit needs. Serialised per (promotion,
      // card) so two completions on the same card cannot both read the count
      // from before the other and both fit under the limit.
      const cardLimit = promotion.maxRedemptionsPerPaymentMethod;
      if (paymentMethodFingerprintHash) {
        const cardLockKey = `promotion-card:${promotionId}:${paymentMethodFingerprintHash}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${cardLockKey}))`;
      }
      const otherAccountsOnCard = paymentMethodFingerprintHash
        ? await tx.billingPromotionRedemption.findMany({
            where: {
              promotionId,
              paymentMethodFingerprintHash,
              userId: { not: userId },
              // Refused attempts granted nothing, so they do not use up a
              // place -- raising the limit later admits as many as it says.
              NOT: { riskFlags: { contains: "payment_method_limit" } },
            },
            select: { userId: true },
            distinct: ["userId"],
            take: Math.max(cardLimit ?? 1, 1),
          })
        : [];
      const riskFlags = new Set(metadataRiskFlags);
      if (otherAccountsOnCard.length > 0) riskFlags.add("shared_payment_method");
      // A limited promotion that cannot identify the payer cannot count them;
      // a zero-charge checkout is refused rather than let through uncounted.
      const payerUnverified =
        chargedNothing && cardLimit !== null && !paymentMethodFingerprintHash;
      if (payerUnverified) riskFlags.add("payment_method_unverified");
      const overCardLimit =
        payerUnverified ||
        (chargedNothing &&
          cardLimit !== null &&
          otherAccountsOnCard.length >= cardLimit);

      const recordRedemption = () =>
        tx.billingPromotionRedemption.create({
          data: {
            promotionId,
            userId,
            planId,
            billingInterval,
            stripeCheckoutSessionId: session.id,
            stripeSubscriptionId: subscriptionId,
            clientIpHash,
            paymentMethodFingerprintHash,
            riskFlags: encodePromotionRiskFlags(riskFlags),
          },
        });

      if (overCardLimit) {
        // Recorded so the account cannot try again and the Admin risk count
        // sees it; not counted against the promotion, which granted nothing.
        riskFlags.add("payment_method_limit");
        await recordRedemption();
        return { promotionId, refused: true };
      }

      const counted =
        promotionOpen && maxRedemptions
          ? (
              await tx.billingPromotion.updateMany({
                where: {
                  id: promotionId,
                  isActive: true,
                  endsAt: { gt: now },
                  redeemedCount: { lt: maxRedemptions },
                },
                data: { redeemedCount: { increment: 1 } },
              })
            ).count === 1
          : false;
      if (!counted) {
        // Closed, or its last redemption taken by a concurrent completion:
        // granted and recorded (so the card is counted), not counted.
        console.warn(
          JSON.stringify({
            event: "promotion_redemption_recorded_uncounted",
            promotionId,
            promotionOpen,
          })
        );
      }
      await recordRedemption();
      return { promotionId, refused: false };
    });
  } finally {
    // Unbounded, unlike the expiry handler: once a completion has run, this
    // account has redeemed the promotion (or been refused it), so no later
    // attempt can be holding the lease. A bound on session.created would also
    // be wrong here -- Stripe gives seconds, the lease row milliseconds, so a
    // lease taken in the same second would never be released.
    await releasePromotionCheckout(promotionId, userId).catch(() => undefined);
  }
}

/**
 * Cancels a subscription whose card was over the promotion's per-card limit.
 *
 * Throws on failure, so the webhook is answered with an error and Stripe
 * delivers it again. The retry reads the subscription afresh
 * (`handleCheckoutCompleted`) and finds the refusal already recorded, so an
 * unknown outcome is re-checked against Stripe rather than repeated blindly.
 */
async function cancelOverLimitPromotionSubscription(
  subscription: Stripe.Subscription,
  promotionId: string
) {
  console.warn(
    JSON.stringify({
      event: "promotion_payment_method_limit_refused",
      promotionId,
      subscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
    })
  );
  // Whatever the account already holds through this subscription is taken
  // back now, not left for the deletion event: a plan must not outlive the
  // refusal, however it was granted. Through the same entitlement write the
  // deletion event uses -- under the account lock, the web plan reset and the
  // plan recomputed with any store subscription or pass the account also
  // holds -- and only for the account that carries this subscription.
  const carrier = await prisma.user.findFirst({
    where: { stripeSubscriptionId: subscription.id },
    select: { id: true, stripeSubscriptionId: true },
  });
  if (carrier?.stripeSubscriptionId === subscription.id) {
    await applyWebSubscriptionSnapshot({
      userId: carrier.id,
      plan: "Free",
      subscriptionId: null,
      priceId: null,
      status: "canceled",
      periodEnd: getPeriodEnd(subscription),
      interval: null,
      cancelAtPeriodEnd: false,
      observedAt: new Date(),
      deletedSubscriptionId: subscription.id,
    });
  }
  if (subscription.status === "canceled") return;
  await getStripe().subscriptions.cancel(subscription.id, {
    invoice_now: false,
    prorate: false,
    cancellation_details: {
      comment: "Promotion per-card redemption limit exceeded.",
    },
  });
}

async function getSubscriptionPaymentMethodFingerprintHash(
  subscription: Stripe.Subscription,
  options: { failClosed?: boolean; session?: Stripe.Checkout.Session } = {}
) {
  try {
    const stripe = getStripe();
    const resolve = async (
      value: string | Stripe.PaymentMethod | null | undefined
    ) =>
      typeof value === "string"
        ? await stripe.paymentMethods.retrieve(value)
        : value && typeof value === "object"
          ? value
          : null;
    // Only the method this checkout itself used. Subscription-mode Checkout
    // makes it the subscription's default payment method (all 52 OZBFREE
    // redemptions on 2026-11-17..20 had one); a zero-charge subscription
    // collects it through the subscription's pending SetupIntent; the
    // Session's own SetupIntent / PaymentIntent cover the remaining shapes.
    // Never another method merely attached to the customer -- it may be a
    // different card, which would count the wrong card or refuse for an
    // unrelated one.
    const fromSubscription = paymentMethodFingerprint(
      await resolve(subscription.default_payment_method)
    );
    if (fromSubscription) return hashPaymentMethodFingerprint(fromSubscription);
    const pendingSetupIntent = subscription.pending_setup_intent;
    const pendingSetupIntentId =
      typeof pendingSetupIntent === "string"
        ? pendingSetupIntent
        : pendingSetupIntent?.id;
    if (pendingSetupIntentId) {
      const intent = await stripe.setupIntents.retrieve(pendingSetupIntentId);
      const fromPending = paymentMethodFingerprint(
        await resolve(intent.payment_method)
      );
      if (fromPending) return hashPaymentMethodFingerprint(fromPending);
    }
    const session = options.session;
    const setupIntentId =
      typeof session?.setup_intent === "string"
        ? session.setup_intent
        : session?.setup_intent?.id;
    if (setupIntentId) {
      const intent = await stripe.setupIntents.retrieve(setupIntentId);
      const fromSetup = paymentMethodFingerprint(
        await resolve(intent.payment_method)
      );
      if (fromSetup) return hashPaymentMethodFingerprint(fromSetup);
    }
    const paymentIntentId =
      typeof session?.payment_intent === "string"
        ? session.payment_intent
        : session?.payment_intent?.id;
    if (paymentIntentId) {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      const fromPayment = paymentMethodFingerprint(
        await resolve(intent.payment_method)
      );
      if (fromPayment) return hashPaymentMethodFingerprint(fromPayment);
    }
    return null;
  } catch (error) {
    // For a promotion checkout the card decides the per-card limit, so an
    // unreadable card fails the webhook and Stripe delivers it again, instead
    // of reading as "no card" and passing the limit.
    if (options.failClosed) throw error;
    console.warn("Promotion payment-method risk check skipped.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  if (session.metadata?.purchaseType === "credit_pack") {
    await grantCreditPackFromCheckout(session);
    return;
  }
  if (!session.subscription) return;
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription.id;
  // Stamped before the retrieve, for the same reason
  // resyncSubscriptionFromStripe() does it.
  const observedAt = new Date();
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId, {
    expand: ["default_payment_method"],
  });
  const promotionId = session.metadata?.promotionId || null;
  // Only a promotion checkout needs to know the card.
  const paymentMethodFingerprintHash = promotionId
    ? await getSubscriptionPaymentMethodFingerprintHash(subscription, {
        failClosed: true,
        session,
      })
    : null;
  const redemption = await recordPromotionRedemptionFromCheckout(
    session,
    subscriptionId,
    paymentMethodFingerprintHash,
    session.amount_total === 0
  ).catch(async (error) => {
    // Only the outcomes a redelivery would repeat are absorbed; anything else
    // (a database fault mid-decision) fails the webhook, so a transient error
    // cannot be the way past the per-card limit.
    if (error instanceof PromotionRedemptionNotRecorded) {
      console.error("Promotion redemption not recorded:", error);
      return null;
    }
    if (isUniqueViolation(error) && promotionId) {
      return redemptionAfterUniqueViolation(session, promotionId);
    }
    throw error;
  });
  if (redemption) {
    await alertOnPromotionBurst(redemption.promotionId).catch((error) => {
      console.error("Promotion burst alert failed:", error);
    });
  }
  // Null only when the promotion row itself is gone: there is no limit left
  // to apply.
  const refused = redemption?.refused ?? false;
  if (refused && promotionId) {
    await cancelOverLimitPromotionSubscription(subscription, promotionId);
    // No sync, no welcome mail, no purchase event: the plan was never granted.
    // The cancellation's own customer.subscription.deleted keeps the account
    // on Free.
    return;
  }
  // The completion has just decided the per-card limit itself, so its own
  // sync does not wait for that decision.
  const synced = await syncSubscription(subscription, observedAt, {
    promotionDecided: true,
  });
  let billingSnapshot: CheckoutBillingSnapshot | null = null;
  if (synced && session.amount_total !== null) {
    const legacyCurrency = normalizeBillingCurrency(session.currency);
    const signedBilling = session.metadata?.billingCurrency
      ? billingSnapshotFromCheckoutSession(session)
      : legacyCurrency
        ? {
            currency: legacyCurrency,
            country: "ZZ",
            expectedAmountMinor: session.amount_total,
            amountUsdMicroUsd:
              legacyCurrency === "USD"
                ? BigInt(session.amount_total) * BigInt(10_000)
                : BigInt(0),
            usdConversionRate: legacyCurrency === "USD" ? "1" : null,
            usdConversionSource: "legacy_checkout",
            pricingVersion: 1,
          }
        : null;
    if (signedBilling) {
      const paymentRevenueSnapshot = await getUsdRevenueSnapshot({
        amountMinor: signedBilling.expectedAmountMinor,
        currency: signedBilling.currency,
        fallbackUsdMinor: Number(
          signedBilling.amountUsdMicroUsd / BigInt(10_000)
        ),
      });
      billingSnapshot = {
        ...signedBilling,
        amountUsdMicroUsd: paymentRevenueSnapshot.amountUsdMicroUsd,
        usdConversionRate: paymentRevenueSnapshot.usdConversionRate,
        usdConversionSource: paymentRevenueSnapshot.source,
      };
    }
    if (billingSnapshot) {
      await recordBillingTransactionFromCheckout({
        db: prisma,
        session,
        userId: synced.user.id,
        productType: "subscription",
        productId: `subscription_${
          synced.plan === "Max" ? "max" : synced.plan === "Pro" ? "pro" : "free"
        }_${synced.billingInterval || "monthly"}`,
        billingInterval: synced.billingInterval || "monthly",
        snapshot: billingSnapshot,
      });
    }
  }
  if (synced?.user.id) {
    // What the payment method said, kept beside what the person told us. It
    // does not overwrite their own declaration: paying with a card registered
    // elsewhere is not moving house
    // (docs/policy/email-notifications.md §6.2).
    await recordBillingCountry({
      userId: synced.user.id,
      country: session.metadata?.billingCountry,
    }).catch((error) => {
      console.error("Billing country record failed:", error);
    });
  }
  if (synced && synced.plan !== "Free") {
    // periodEnd is resolved here, not in the renderer: a `new Date()` inside
    // the template would make the drain render a different message from the
    // enqueue, which breaks both the idempotency key and the audit copy.
    await enqueueStandardEmail({
      templateKey: BILLING_WELCOME_TEMPLATE,
      emailAddress: synced.user.email,
      userId: synced.user.id,
      language: synced.user.settings?.language,
      payload: {
        plan: synced.plan,
        billingInterval: synced.billingInterval ?? null,
        periodEnd: resolveBillingPeriodEnd(
          synced.periodEnd,
          synced.billingInterval
        ),
      },
      referenceType: "User",
      referenceId: synced.user.id,
    }).catch((emailError) => {
      console.error("Billing welcome email enqueue failed:", emailError);
    });
  }
  const analytics = analyticsAttributionFromMetadata(session.metadata);
  if (synced && analytics) {
    const completedPlanId =
      synced.plan === "Max" ? "max" : synced.plan === "Pro" ? "pro" : "free";
    const completedBillingInterval = synced.billingInterval || "monthly";
    const purchaseAnalytics = purchaseAnalyticsFromMetadata(session.metadata, {
      currentPlan: "free",
      productId: `subscription_${completedPlanId}_${completedBillingInterval}`,
      creditQuantity:
        synced.plan === "Max" ? 10_000 : synced.plan === "Pro" ? 3_000 : 300,
    });
    await recordProductAnalyticsEvent({
      eventName: "purchase_completed",
      source: "server",
      userId: synced.user.id,
      attribution: analytics,
      modelCount: 0,
      plan: synced.plan,
      properties: {
        billing_interval: completedBillingInterval,
        plan_id: completedPlanId,
        purchase_type: "subscription",
        product_id: purchaseAnalytics.productId,
        monthly_credits_included: purchaseAnalytics.creditQuantity,
        current_plan: purchaseAnalytics.currentPlan,
        trigger: purchaseAnalytics.trigger,
        plan_credits_remaining: purchaseAnalytics.planCreditsRemaining,
        addon_credits_remaining: purchaseAnalytics.addonCreditsRemaining,
        value: billingSnapshot
          ? billingMinorToMajor(
              billingSnapshot.expectedAmountMinor,
              billingSnapshot.currency
            )
          : 0,
        currency: billingSnapshot?.currency || "USD",
        transaction_id: session.id,
      },
      dedupeKey: `stripe-checkout:${session.id}`,
      sendToGa4: true,
    }).catch((analyticsError) => {
      console.warn("Stripe purchase analytics failed.", {
        errorName:
          analyticsError instanceof Error
            ? analyticsError.name
            : "UnknownError",
      });
    });
  }
}

async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
  observedAt: Date
) {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  // Guarded like every other write. A deletion is terminal for *this*
  // subscription, but the account may already have moved on to a newer one --
  // an unguarded downgrade to Free here would undo it.
  const user = await prisma.user.findFirst({ where: { stripeCustomerId: customerId }, select: { id: true } });
  if (!user) return;
  await applyWebSubscriptionSnapshot({
    userId: user.id, plan: "Free", subscriptionId: null, priceId: null,
    status: subscription.status, periodEnd: getPeriodEnd(subscription), interval: null,
    cancelAtPeriodEnd: false, observedAt, deletedSubscriptionId: subscription.id,
  });
}

/**
 * A checkout the customer walked away from.
 *
 * Only the promotion lease is touched: an expired Session redeemed nothing, so
 * there is no subscription to sync and no redemption to record. Without this the
 * lease sits for its full 31-minute TTL and the customer is told "A checkout
 * using this promotion is already in progress" when they try the other plan --
 * a lock held on behalf of an attempt Stripe has already closed.
 *
 * The release is conditional on the lease predating this Session, because a
 * redelivered webhook must not free a lease a later attempt is relying on.
 */
async function handleCheckoutExpired(session: Stripe.Checkout.Session) {
  const promotionId = session.metadata?.promotionId || null;
  const userId =
    session.client_reference_id ||
    (typeof session.metadata?.userId === "string"
      ? session.metadata.userId
      : null);
  if (!promotionId || !userId) return;
  if (typeof session.created !== "number") {
    // Without the Session's own creation time there is no way to tell this
    // lease from a later attempt's, and holding one for its TTL is the
    // behaviour this handler improves on rather than a failure.
    return;
  }
  await releasePromotionCheckout(promotionId, userId, {
    takenAtOrBefore: new Date(session.created * 1000),
  }).catch((error) => {
    console.error("Promotion checkout lease release failed.", {
      stripeCheckoutSessionId: session.id,
      promotionId,
      trigger: "checkout.session.expired",
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  });
}

export async function processStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;
    case "checkout.session.expired":
      await handleCheckoutExpired(event.data.object as Stripe.Checkout.Session);
      break;
    case "charge.refunded":
      await handleCreditPackRefund(event.data.object as Stripe.Charge);
      break;
    case "charge.dispute.created":
    case "charge.dispute.updated":
      await handleCreditPackDispute(event.data.object as Stripe.Dispute);
      break;
    case "charge.dispute.closed":
      await handleCreditPackDisputeClosed(event.data.object as Stripe.Dispute);
      break;
    case "charge.dispute.funds_reinstated":
      await handleCreditPackDisputeReinstated(
        event.data.object as Stripe.Dispute
      );
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(
        event.data.object as Stripe.Subscription,
        new Date()
      );
      break;
    default:
      // Everything that means "this subscription may have moved" -- including
      // the invoice and schedule events a plan change depends on -- resolves to
      // a subscription id and is re-read from Stripe. The payload is the
      // trigger; Stripe is the source of truth.
      //
      // A plan change made with `pending_if_incomplete` does not show up on the
      // subscription until its invoice is paid, so `invoice.paid` is what
      // promotes the account, and `pending_update_expired` is what confirms the
      // change was abandoned.
      if (isSubscriptionResyncEvent(event.type)) {
        const subscriptionId = subscriptionIdFromEventObject(
          event.type,
          event.data.object
        );
        if (subscriptionId) {
          await resyncSubscriptionFromStripe(subscriptionId, event.type);
        }
      }
      break;
  }
}

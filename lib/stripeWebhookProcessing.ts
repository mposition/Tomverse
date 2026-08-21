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
  observedAt: Date
) {
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

  const applied = await prisma.user.updateMany({
    where: {
      id: user.id,
      OR: [
        { subscriptionSyncedAt: null },
        { subscriptionSyncedAt: { lte: observedAt } },
      ],
    },
    data: {
      plan,
      stripeSubscriptionId: subscription.id,
      stripePriceId: priceId,
      subscriptionStatus: subscription.status,
      subscriptionCurrentPeriodEnd: periodEnd,
      subscriptionBillingInterval: billingInterval,
      subscriptionCancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      subscriptionSyncedAt: observedAt,
    },
  });
  // A concurrent handler applied a newer read between the select and the
  // update. Its state is the correct one, so this snapshot is dropped rather
  // than retried -- retrying would only race again.
  if (applied.count === 0) return null;

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
    const cleared = await prisma.user.updateMany({
      where: {
        id: userId,
        OR: [
          { subscriptionSyncedAt: null },
          { subscriptionSyncedAt: { lte: observedAt } },
        ],
      },
      data: {
        plan: "Free",
        stripeSubscriptionId: null,
        stripePriceId: null,
        subscriptionStatus: null,
        subscriptionBillingInterval: null,
        subscriptionCancelAtPeriodEnd: false,
        subscriptionSyncedAt: observedAt,
      },
    });
    return {
      result: cleared.count > 0 ? "cleared" : "no_subscription",
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

async function recordPromotionRedemptionFromCheckout(
  session: Stripe.Checkout.Session,
  subscriptionId: string,
  paymentMethodFingerprintHash: string | null
) {
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
    return;
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
    await prisma.$transaction(async (tx) => {
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
        },
      });
      const now = new Date();
      let eligiblePlanIds: unknown = [];
      try {
        eligiblePlanIds = JSON.parse(promotion?.appliesToPlanIds || "[]");
      } catch {
        eligiblePlanIds = [];
      }

      if (
        !promotion?.isActive ||
        !promotion.maxRedemptions ||
        !promotion.endsAt ||
        (promotion.startsAt && promotion.startsAt > now) ||
        promotion.endsAt <= now ||
        !Array.isArray(eligiblePlanIds) ||
        !eligiblePlanIds.includes(planId) ||
        (billingInterval === "annual" && !promotion.allowAnnualStacking)
      ) {
        throw new Error("Promotion policy is no longer redeemable.");
      }

      const existing = await tx.billingPromotionRedemption.findUnique({
        where: { stripeCheckoutSessionId: session.id },
        select: { id: true },
      });
      if (existing) return;

      const paymentMethodReuse = paymentMethodFingerprintHash
        ? await tx.billingPromotionRedemption.findFirst({
            where: {
              promotionId,
              paymentMethodFingerprintHash,
              userId: { not: userId },
            },
            select: { id: true },
          })
        : null;
      const riskFlags = new Set(metadataRiskFlags);
      if (paymentMethodReuse) riskFlags.add("shared_payment_method");

      const updatedPromotion = await tx.billingPromotion.updateMany({
        where: {
          id: promotionId,
          isActive: true,
          endsAt: { gt: now },
          redeemedCount: { lt: promotion.maxRedemptions },
        },
        data: { redeemedCount: { increment: 1 } },
      });

      if (updatedPromotion.count !== 1) {
        throw new Error("Promotion redemption limit reached.");
      }

      await tx.billingPromotionRedemption.create({
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
    });
  } finally {
    await releasePromotionCheckout(promotionId, userId).catch(() => undefined);
  }
}

async function getSubscriptionPaymentMethodFingerprintHash(
  subscription: Stripe.Subscription
) {
  try {
    const stripe = getStripe();
    const value = subscription.default_payment_method;
    const paymentMethod =
      typeof value === "string"
        ? await stripe.paymentMethods.retrieve(value)
        : value && typeof value === "object"
          ? value
          : null;
    const fingerprint = paymentMethodFingerprint(paymentMethod);
    return fingerprint ? hashPaymentMethodFingerprint(fingerprint) : null;
  } catch (error) {
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
  const paymentMethodFingerprintHash =
    await getSubscriptionPaymentMethodFingerprintHash(subscription);
  await recordPromotionRedemptionFromCheckout(
    session,
    subscriptionId,
    paymentMethodFingerprintHash
  ).catch((error) => {
    console.error("Promotion redemption record failed:", error);
  });
  const synced = await syncSubscription(subscription, observedAt);
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
  await prisma.user.updateMany({
    where: {
      stripeCustomerId: customerId,
      OR: [
        { subscriptionSyncedAt: null },
        { subscriptionSyncedAt: { lte: observedAt } },
      ],
    },
    data: {
      plan: "Free",
      stripeSubscriptionId: null,
      stripePriceId: null,
      subscriptionStatus: subscription.status,
      subscriptionCurrentPeriodEnd: getPeriodEnd(subscription),
      subscriptionBillingInterval: null,
      subscriptionCancelAtPeriodEnd: false,
      subscriptionSyncedAt: observedAt,
    },
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

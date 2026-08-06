/**
 * Executing a Pro <-> Max plan change against Stripe.
 *
 * `lib/planChangeStateMachine.ts` decides *whether* a change may happen and
 * what it is; this module is the only place that talks to Stripe about it and
 * the only place that writes `PlanChangeRequest`. Keeping the two apart is what
 * lets the whole decision matrix be tested without a network.
 *
 * Two execution paths, and they are not symmetrical:
 *
 * - **`immediate_upgrade`** replaces the subscription item's price now, with
 *   `proration_behavior: "always_invoice"` and
 *   `payment_behavior: "pending_if_incomplete"`. Those two parameters -- not
 *   any ordering in this file -- are what stop Max being granted before the
 *   money arrives: Stripe parks the change as a *pending update* until its
 *   invoice is paid, so a failed card or an unfinished SCA challenge leaves the
 *   customer on Pro.
 *
 * - **`scheduled_downgrade`** creates a Subscription Schedule from the live
 *   subscription: the current phase keeps Max until the period ends, and a
 *   second phase starts Pro after it, with `proration_behavior: "none"` so the
 *   boundary itself costs nothing. Stripe's Customer Portal cannot express
 *   this (it refuses more than one price with the same recurring interval on a
 *   Product), so Tomverse drives the Schedule API directly.
 *
 * Nothing here grants an entitlement. The plan on the account only ever moves
 * through `syncSubscription()` in `lib/stripeWebhookProcessing.ts`, from a
 * subscription re-read from Stripe.
 */

import type Stripe from "stripe";
import { getBillingPlans, getBillingPlanByTier } from "@/lib/billingConfig";
import { getUserChatUsageKey } from "@/lib/chatSecurity";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";
import {
  planCreditsAfterPlanChange,
  type PlanChangeCreditOutcome,
} from "@/lib/planChangeCredits";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";
import {
  PLAN_CHANGE_AUDIT_ACTIONS,
  PLAN_CHANGE_PREVIEW_TTL_MS,
  checkPlanChangeCancellation,
  checkPlanChangePreview,
  describePlanChangeForSupport,
  planChangeIdempotencyKey,
  planChangeStateFingerprint,
  resolvePlanChange,
  resolvePlanChangeSettlement,
  transitionPlanChangeReservation,
  type PlanChangeInterval,
  type PlanChangePlan,
  type PlanChangeRefusalCode,
  type PlanChangeReservation,
  type PlanChangeReservationStatus,
  type PlanChangeSubscriptionSnapshot,
  type PlanChangeTier,
} from "@/lib/planChangeStateMachine";

export type PlanChangeErrorCode =
  | PlanChangeRefusalCode
  | "PLAN_CHANGE_PREVIEW_NOT_FOUND"
  | "PLAN_CHANGE_PREVIEW_EXPIRED"
  | "PLAN_CHANGE_PRICE_UNAVAILABLE"
  | "PLAN_CHANGE_ALREADY_APPLIED"
  | "NO_SCHEDULED_PLAN_CHANGE"
  | "STRIPE_ERROR";

export type PlanChangeFailure = {
  ok: false;
  code: PlanChangeErrorCode;
  status: number;
  reason: string;
};

const fail = (
  code: PlanChangeErrorCode,
  reason: string,
  status = 409
): PlanChangeFailure => ({ ok: false, code, status, reason });

/** The customer-facing shape of a quote. */
export type PlanChangeQuote = {
  requestId: string;
  direction: "upgrade" | "downgrade";
  execution: "immediate_upgrade" | "scheduled_downgrade";
  fromTier: PlanChangeTier;
  toTier: PlanChangeTier;
  billingInterval: PlanChangeInterval;
  currency: string;
  /**
   * What Stripe says the customer pays now, in the smallest currency unit.
   * Null for a downgrade, which charges nothing at the boundary.
   *
   * Always Stripe's number, never ours: every live subscription carries a
   * promotion discount, and a locally computed proration would quietly
   * disagree with the invoice.
   */
  amountDueMinor: number | null;
  /**
   * What the change does to this month's plan credits, or null when it does
   * nothing to them yet.
   *
   * Quoted because the money is not the whole story: an upgrade that costs a
   * prorated amount also hands over the whole new monthly allowance
   * immediately, and a dialog showing only the charge undersells it.
   *
   * **Null for a scheduled downgrade, and that is the point.** A downgrade
   * lands at the period boundary, so this month's allowance is still the one
   * the customer is on. Quoting the smaller plan's remaining balance now would
   * be a number that is not true for anyone yet -- and by the time it becomes
   * true the month has usually rolled over and the usage it was computed from
   * is gone. Saying nothing is the only honest option; the effective date
   * beside it already says when the change happens.
   *
   * The arithmetic is `lib/planChangeCredits.ts`, so the preview and the
   * steady-state balance cannot drift apart.
   */
  credits: PlanChangeCreditOutcome | null;
  effectiveAt: string | null;
  renewal: PlanChangePlan["renewal"];
  expiresAt: string;
};

/** First instant of the current UTC month, which is when plan credits reset. */
const monthStartUtc = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/**
 * This month's plan-credit position under the plan being moved *to*.
 *
 * Only meaningful for a change that takes effect immediately -- see the
 * `credits` field on the quote.
 *
 * Reads the same bucket `/api/user/usage` reads, so "remaining after the
 * change" is the number the account page will show once the change lands
 * rather than a second estimate of it.
 */
async function quoteCredits(
  userId: string,
  toTier: PlanChangeTier,
  now: Date
): Promise<PlanChangeCreditOutcome> {
  const [plan, monthBucket, user] = await Promise.all([
    getBillingPlanByTier(toTier),
    prisma.chatUsageBucket.findFirst({
      where: {
        key: getUserChatUsageKey(userId),
        period: "month",
        periodStart: monthStartUtc(now),
      },
      select: { count: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { creditDebtCredits: true },
    }),
  ]);
  return planCreditsAfterPlanChange({
    newMonthlyPlanCredits: plan.monthlyMessageLimit,
    planCreditsUsedThisMonth: usageBucketCount(monthBucket?.count),
    creditDebtCredits: user?.creditDebtCredits ?? 0,
  });
}

/** A reserved change, as the account page needs to describe it. */
export type PlanChangeReservationView = {
  requestId: string;
  direction: "upgrade" | "downgrade";
  execution: "immediate_upgrade" | "scheduled_downgrade";
  fromTier: PlanChangeTier;
  toTier: PlanChangeTier;
  billingInterval: PlanChangeInterval;
  status: PlanChangeReservationStatus;
  appliesAt: string | null;
  cancellable: boolean;
};

const TIER_PLAN_ID: Record<PlanChangeTier, "pro" | "max"> = {
  Pro: "pro",
  Max: "max",
};

const STRIPE_INTERVAL: Record<PlanChangeInterval, "month" | "year"> = {
  monthly: "month",
  annual: "year",
};

const asTier = (value: string): "Free" | PlanChangeTier =>
  value === "Pro" || value === "Max" ? value : "Free";

const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const periodEndOf = (subscription: Stripe.Subscription): Date | null => {
  // The period moved onto the item in this API version; the subscription-level
  // field is still sent by older pinned versions.
  const item = numeric(
    (subscription.items.data[0] as unknown as { current_period_end?: unknown })
      ?.current_period_end
  );
  const legacy = numeric(
    (subscription as unknown as { current_period_end?: unknown })
      .current_period_end
  );
  const seconds = item ?? legacy;
  return seconds === null ? null : new Date(seconds * 1000);
};

const intervalOf = (
  subscription: Stripe.Subscription
): PlanChangeInterval | null => {
  const recurring = subscription.items.data[0]?.price.recurring;
  if (!recurring || recurring.interval_count !== 1) return null;
  if (recurring.interval === "month") return "monthly";
  if (recurring.interval === "year") return "annual";
  return null;
};

const productIdOf = (price: Stripe.Price | undefined): string | null => {
  if (!price) return null;
  return typeof price.product === "string" ? price.product : price.product.id;
};

/**
 * Which plan a live subscription is actually billing.
 *
 * Read from the price rather than from `subscription.metadata`: metadata is a
 * note written when the subscription was created and a plan change does not
 * rewrite history, so after an upgrade it still says "pro". What Stripe
 * invoices is the price, so the price decides.
 */
async function tierOfSubscription(
  subscription: Stripe.Subscription
): Promise<"Free" | PlanChangeTier> {
  const price = subscription.items.data[0]?.price;
  const plans = await getBillingPlans();
  const byPrice = price
    ? plans.find(
        (plan) =>
          plan.stripePriceId === price.id || plan.stripeAnnualPriceId === price.id
      )
    : null;
  if (byPrice) return asTier(byPrice.tier);

  const productId = productIdOf(price);
  const byProduct = productId
    ? plans.find((plan) => plan.stripeProductId === productId)
    : null;
  if (byProduct) return asTier(byProduct.tier);

  return "Free";
}

export async function snapshotFromStripeSubscription(
  subscription: Stripe.Subscription
): Promise<PlanChangeSubscriptionSnapshot> {
  const item = subscription.items.data[0];
  return {
    subscriptionId: subscription.id,
    status: subscription.status,
    tier: await tierOfSubscription(subscription),
    interval: intervalOf(subscription),
    currency: item?.price.currency ?? subscription.currency ?? null,
    itemIds: subscription.items.data.map((entry) => entry.id),
    currentPeriodEnd: periodEndOf(subscription),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    hasPendingUpdate: Boolean(subscription.pending_update),
    scheduleId:
      typeof subscription.schedule === "string"
        ? subscription.schedule
        : (subscription.schedule?.id ?? null),
  };
}

/**
 * The catalogue price to move the subscription item onto.
 *
 * Resolved by (product, interval, currency, tax behaviour) rather than from
 * configuration, so adding a currency to a plan needs no deploy. It is
 * fail-closed on purpose: zero matches means the price is missing, and more
 * than one means the catalogue is ambiguous and a guess would bill the wrong
 * amount. Tax behaviour has to match the price already on the subscription --
 * Stripe rejects a subscription that mixes them, and finding that out at
 * confirm time would be after the customer approved a quote.
 */
async function resolveTargetPrice({
  toTier,
  interval,
  currency,
  taxBehavior,
}: {
  toTier: PlanChangeTier;
  interval: PlanChangeInterval;
  currency: string;
  taxBehavior: Stripe.Price.TaxBehavior | null;
}): Promise<{ priceId: string } | PlanChangeFailure> {
  const plans = await getBillingPlans();
  const plan = plans.find((entry) => entry.id === TIER_PLAN_ID[toTier]);
  if (!plan?.stripeProductId) {
    return fail(
      "PLAN_CHANGE_PRICE_UNAVAILABLE",
      `No Stripe product is configured for the ${toTier} plan.`,
      503
    );
  }

  const prices = await getStripe().prices.list({
    product: plan.stripeProductId,
    active: true,
    type: "recurring",
    currency: currency.toLowerCase(),
    recurring: { interval: STRIPE_INTERVAL[interval] },
    limit: 100,
  });

  const candidates = prices.data.filter(
    (price) =>
      price.recurring?.interval_count === 1 &&
      (taxBehavior === null || price.tax_behavior === taxBehavior)
  );

  if (candidates.length !== 1) {
    return fail(
      "PLAN_CHANGE_PRICE_UNAVAILABLE",
      `Expected exactly one active ${toTier} ${interval} price in ${currency}, found ${candidates.length}.`,
      503
    );
  }

  return { priceId: candidates[0]!.id };
}

const reservationFrom = (
  row: {
    id: string;
    toTier: string;
    billingInterval: string;
    appliesAt: Date | null;
    status: string;
    stripeScheduleId: string | null;
  } | null
): PlanChangeReservation | null => {
  if (!row) return null;
  const status = row.status as PlanChangeReservationStatus;
  return {
    id: row.id,
    targetTier: asTier(row.toTier) === "Max" ? "Max" : "Pro",
    interval: row.billingInterval === "annual" ? "annual" : "monthly",
    appliesAt: row.appliesAt ?? new Date(0),
    status,
    scheduleId: row.stripeScheduleId,
  };
};

/** The one reservation that can block or be cancelled: `pending`, if any. */
async function pendingRequest(userId: string) {
  return prisma.planChangeRequest.findFirst({
    where: { userId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
}

async function loadAccount(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, stripeSubscriptionId: true },
  });
  if (!user) return null;
  return user;
}

type PlanChangeContext = {
  subscription: Stripe.Subscription;
  snapshot: PlanChangeSubscriptionSnapshot;
  reservation: PlanChangeReservation | null;
  pendingRow: Awaited<ReturnType<typeof pendingRequest>>;
};

async function loadContext(
  userId: string
): Promise<PlanChangeContext | PlanChangeFailure> {
  const user = await loadAccount(userId);
  if (!user?.stripeSubscriptionId) {
    return fail(
      "NO_ACTIVE_SUBSCRIPTION",
      "There is no subscription to change; this is a new purchase."
    );
  }

  const subscription = await getStripe().subscriptions.retrieve(
    user.stripeSubscriptionId
  );
  const pendingRow = await pendingRequest(userId);
  return {
    subscription,
    snapshot: await snapshotFromStripeSubscription(subscription),
    reservation: reservationFrom(pendingRow),
    pendingRow,
  };
}

/**
 * Quote a change without making one.
 *
 * The quote is stored, not just returned: the confirm has to prove it is
 * executing what the customer saw, and that proof is the fingerprint written
 * here.
 */
export async function previewPlanChange({
  userId,
  targetTier,
  targetInterval,
  resumeRenewal = false,
}: {
  userId: string;
  targetTier: PlanChangeTier;
  targetInterval: PlanChangeInterval;
  resumeRenewal?: boolean;
}): Promise<{ ok: true; quote: PlanChangeQuote } | PlanChangeFailure> {
  const context = await loadContext(userId);
  if ("ok" in context) return context;

  const decision = resolvePlanChange({
    snapshot: context.snapshot,
    targetTier,
    targetInterval,
    reservation: context.reservation,
    resumeRenewal,
  });
  if (!decision.allowed) {
    return fail(decision.code, decision.reason);
  }

  const currentPrice = context.subscription.items.data[0]?.price ?? null;
  const target = await resolveTargetPrice({
    toTier: decision.plan.toTier,
    interval: decision.plan.interval,
    currency: decision.plan.currency,
    taxBehavior: currentPrice?.tax_behavior ?? null,
  });
  if ("ok" in target) return target;

  const amountDueMinor =
    decision.plan.execution === "immediate_upgrade"
      ? await quoteUpgrade({
          plan: decision.plan,
          targetPriceId: target.priceId,
        })
      : null;
  // Only where "after the change" means now. A scheduled downgrade changes
  // nothing about this month.
  const credits =
    decision.plan.execution === "immediate_upgrade"
      ? await quoteCredits(userId, decision.plan.toTier, new Date())
      : null;

  const created = await prisma.planChangeRequest.create({
    data: {
      userId,
      direction: decision.plan.direction,
      execution: decision.plan.execution,
      fromTier: decision.plan.fromTier,
      toTier: decision.plan.toTier,
      billingInterval: decision.plan.interval,
      currency: decision.plan.currency,
      stripeSubscriptionId: decision.plan.subscriptionId,
      stripeSubscriptionItemId: decision.plan.subscriptionItemId,
      targetStripePriceId: target.priceId,
      fingerprint: planChangeStateFingerprint(context.snapshot),
      renewalDecision: decision.plan.renewal,
      quotedAmountMinor: amountDueMinor,
      status: "previewed",
      appliesAt: decision.plan.effectiveAt,
    },
    select: { id: true, createdAt: true },
  });

  return {
    ok: true,
    quote: {
      requestId: created.id,
      direction: decision.plan.direction,
      execution: decision.plan.execution,
      fromTier: decision.plan.fromTier,
      toTier: decision.plan.toTier,
      billingInterval: decision.plan.interval,
      currency: decision.plan.currency,
      amountDueMinor,
      credits,
      effectiveAt: decision.plan.effectiveAt?.toISOString() ?? null,
      renewal: decision.plan.renewal,
      expiresAt: new Date(
        created.createdAt.getTime() + PLAN_CHANGE_PREVIEW_TTL_MS
      ).toISOString(),
    },
  };
}

/** What Stripe would invoice for the upgrade, discounts and tax included. */
async function quoteUpgrade({
  plan,
  targetPriceId,
}: {
  plan: PlanChangePlan;
  targetPriceId: string;
}): Promise<number | null> {
  const preview = await getStripe().invoices.createPreview({
    subscription: plan.subscriptionId,
    subscription_details: {
      items: [{ id: plan.subscriptionItemId, price: targetPriceId }],
      proration_behavior: "always_invoice",
    },
  });
  return numeric(preview.amount_due);
}

/**
 * Execute a quote the customer confirmed.
 *
 * Idempotent by construction: the Stripe call carries a key derived from the
 * preview, so a double-click, a retried request and a back-button resubmit all
 * resolve to one change at Stripe. A confirm whose quote no longer matches the
 * subscription is refused rather than repriced silently.
 */
export async function confirmPlanChange({
  userId,
  requestId,
  resumeRenewal = false,
}: {
  userId: string;
  requestId: string;
  resumeRenewal?: boolean;
}): Promise<
  { ok: true; reservation: PlanChangeReservationView } | PlanChangeFailure
> {
  const stored = await prisma.planChangeRequest.findFirst({
    where: { id: requestId, userId },
  });
  if (!stored) {
    return fail(
      "PLAN_CHANGE_PREVIEW_NOT_FOUND",
      "That quote does not exist.",
      404
    );
  }
  if (stored.status !== "previewed") {
    // Already confirmed. Report the reservation instead of running it twice.
    return { ok: true, reservation: viewOf(stored) };
  }

  const context = await loadContext(userId);
  if ("ok" in context) return context;

  const targetTier: PlanChangeTier = stored.toTier === "Max" ? "Max" : "Pro";
  const targetInterval: PlanChangeInterval =
    stored.billingInterval === "annual" ? "annual" : "monthly";

  const check = checkPlanChangePreview({
    preview: {
      id: stored.id,
      userId: stored.userId,
      targetTier,
      interval: targetInterval,
      fingerprint: stored.fingerprint,
      createdAt: stored.createdAt,
    },
    snapshot: context.snapshot,
    userId,
    targetTier,
    targetInterval,
    now: new Date(),
  });
  if (!check.usable) {
    await prisma.planChangeRequest.updateMany({
      where: { id: stored.id, status: "previewed" },
      data: { status: "expired", failureCode: check.reason },
    });
    return fail(
      "PLAN_CHANGE_PREVIEW_EXPIRED",
      `The quote is no longer valid (${check.reason}); request a new one.`
    );
  }

  // Re-decide rather than trusting the stored row: between preview and confirm
  // the account may have acquired a pending update or a schedule, and the
  // refusal for that is more useful than a Stripe error.
  const decision = resolvePlanChange({
    snapshot: context.snapshot,
    targetTier,
    targetInterval,
    reservation: context.reservation,
    resumeRenewal,
  });
  if (!decision.allowed) return fail(decision.code, decision.reason);

  const idempotencyKey = planChangeIdempotencyKey(stored.id);
  // The row is the durable record; this line is what makes a change findable
  // in the logs when support is asked about it. It carries identifiers only --
  // no email, no name, no amount.
  console.info(PLAN_CHANGE_AUDIT_ACTIONS.confirmed, {
    ...describePlanChangeForSupport({ plan: decision.plan, previewId: stored.id }),
  });

  try {
    if (decision.plan.execution === "immediate_upgrade") {
      await applyImmediateUpgrade({
        plan: decision.plan,
        targetPriceId: stored.targetStripePriceId,
        idempotencyKey,
      });
      const updated = await prisma.planChangeRequest.update({
        where: { id: stored.id },
        data: {
          status: "pending",
          // Set together with the status, always. The unique index on this
          // column is the only thing standing between two racing confirms and
          // two competing changes to one subscription.
          pendingForUserId: userId,
          confirmedAt: new Date(),
          renewalDecision: decision.plan.renewal,
        },
      });
      return { ok: true, reservation: viewOf(updated) };
    }

    const scheduleId = await scheduleDowngrade({
      plan: decision.plan,
      targetPriceId: stored.targetStripePriceId,
      idempotencyKey,
    });
    const updated = await prisma.planChangeRequest.update({
      where: { id: stored.id },
      data: {
        status: "pending",
        pendingForUserId: userId,
        confirmedAt: new Date(),
        stripeScheduleId: scheduleId,
        appliesAt: decision.plan.effectiveAt,
        renewalDecision: decision.plan.renewal,
      },
    });
    return { ok: true, reservation: viewOf(updated) };
  } catch (error) {
    // The change did not start. Leave the row confirmable-from-scratch rather
    // than pretending a reservation exists.
    await prisma.planChangeRequest.updateMany({
      where: { id: stored.id, status: "previewed" },
      data: { status: "failed", failureCode: "stripe_error" },
    });
    console.error("Plan change confirmation failed.", {
      requestId: stored.id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return fail(
      "STRIPE_ERROR",
      "The payment provider refused the change.",
      502
    );
  }
}

async function applyImmediateUpgrade({
  plan,
  targetPriceId,
  idempotencyKey,
}: {
  plan: PlanChangePlan;
  targetPriceId: string;
  idempotencyKey: string;
}) {
  await getStripe().subscriptions.update(
    plan.subscriptionId,
    {
      items: [{ id: plan.subscriptionItemId, price: targetPriceId }],
      // Together these are the entire "no Max before payment" guarantee: the
      // change is invoiced now and parked as a pending update until that
      // invoice is paid.
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
      // Only ever set to false when the customer opted in separately. Never
      // sent otherwise, so an upgrade cannot resume a cancelled subscription.
      ...(plan.renewal === "cancellation_cleared_by_explicit_consent"
        ? { cancel_at_period_end: false }
        : {}),
      metadata: {
        planId: TIER_PLAN_ID[plan.toTier],
        tier: plan.toTier,
        billingInterval: plan.interval,
      },
    },
    { idempotencyKey }
  );
}

async function scheduleDowngrade({
  plan,
  targetPriceId,
  idempotencyKey,
}: {
  plan: PlanChangePlan;
  targetPriceId: string;
  idempotencyKey: string;
}): Promise<string> {
  const stripe = getStripe();
  const schedule = await stripe.subscriptionSchedules.create(
    { from_subscription: plan.subscriptionId },
    { idempotencyKey }
  );

  const current = schedule.phases[schedule.phases.length - 1];
  if (!current) {
    throw new Error("Stripe returned a schedule with no phases.");
  }

  const updated = await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: "release",
    phases: [
      {
        // The period already paid for, unchanged. Naming the items explicitly
        // keeps Stripe from re-deriving them from the (about to change) price.
        items: current.items.map((item) => ({
          price: typeof item.price === "string" ? item.price : item.price.id,
          quantity: item.quantity ?? 1,
        })),
        start_date: current.start_date,
        end_date: current.end_date,
        proration_behavior: "none",
      },
      {
        items: [{ price: targetPriceId, quantity: 1 }],
        // One period of the new plan, then `end_behavior: "release"` hands the
        // subscription back. Leaving the last phase open-ended instead would
        // keep the subscription under schedule control forever, and every
        // later plan change would refuse it as a schedule conflict.
        duration: { interval: STRIPE_INTERVAL[plan.interval], interval_count: 1 },
        // The boundary itself must cost nothing beyond the new plan's price.
        proration_behavior: "none",
        metadata: {
          planId: TIER_PLAN_ID[plan.toTier],
          tier: plan.toTier,
          billingInterval: plan.interval,
        },
      },
    ],
  });

  return updated.id;
}

/**
 * Call off a reserved downgrade.
 *
 * Releasing the schedule leaves the subscription exactly as it is -- still Max,
 * still renewing -- which is what "cancel the change" means. Cancelling the
 * schedule would cancel the subscription with it.
 */
export async function cancelScheduledPlanChange({
  userId,
}: {
  userId: string;
}): Promise<{ ok: true } | PlanChangeFailure> {
  const row = await pendingRequest(userId);
  if (!row || row.execution !== "scheduled_downgrade") {
    // Checked before the state machine so the answer is about what the
    // customer asked for. An immediate upgrade waiting on payment is not a
    // reservation they can withdraw -- Stripe expires it on its own if the
    // invoice goes unpaid.
    return fail(
      "NO_SCHEDULED_PLAN_CHANGE",
      "There is no scheduled plan change to cancel.",
      404
    );
  }

  const check = checkPlanChangeCancellation({
    reservation: reservationFrom(row),
    now: new Date(),
  });
  if (!check.allowed) {
    return fail(
      check.code,
      check.code === "PLAN_CHANGE_ALREADY_APPLIED"
        ? "The change has already taken effect."
        : "There is no scheduled plan change to cancel.",
      check.code === "NO_SCHEDULED_PLAN_CHANGE" ? 404 : 409
    );
  }

  try {
    if (row.stripeScheduleId) {
      await getStripe().subscriptionSchedules.release(row.stripeScheduleId);
    }
  } catch (error) {
    console.error("Releasing a plan change schedule failed.", {
      requestId: row.id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return fail("STRIPE_ERROR", "The payment provider refused the request.", 502);
  }

  await prisma.planChangeRequest.updateMany({
    where: { id: row.id, status: "pending" },
    // Cleared with the status: a settled row must not keep the account's one
    // in-flight slot, or the customer could never request another change.
    data: { status: "cancelled", pendingForUserId: null, settledAt: new Date() },
  });
  return { ok: true };
}

const viewOf = (row: {
  id: string;
  direction: string;
  execution: string;
  fromTier: string;
  toTier: string;
  billingInterval: string;
  status: string;
  appliesAt: Date | null;
}): PlanChangeReservationView => ({
  requestId: row.id,
  direction: row.direction === "downgrade" ? "downgrade" : "upgrade",
  execution:
    row.execution === "scheduled_downgrade"
      ? "scheduled_downgrade"
      : "immediate_upgrade",
  fromTier: row.fromTier === "Max" ? "Max" : "Pro",
  toTier: row.toTier === "Max" ? "Max" : "Pro",
  billingInterval: row.billingInterval === "annual" ? "annual" : "monthly",
  status: row.status as PlanChangeReservationStatus,
  appliesAt: row.appliesAt?.toISOString() ?? null,
  cancellable:
    row.status === "pending" &&
    row.execution === "scheduled_downgrade" &&
    (row.appliesAt?.getTime() ?? 0) > Date.now(),
});

/** The in-flight change, for the account page. */
export async function getActivePlanChange(
  userId: string
): Promise<PlanChangeReservationView | null> {
  const row = await pendingRequest(userId);
  return row ? viewOf(row) : null;
}

/**
 * Settle any in-flight change against a subscription just re-read from Stripe.
 *
 * Driven from the webhook path rather than from a timer, and written to be safe
 * under at-least-once, out-of-order delivery: it compares the reservation
 * against the *current* subscription, and every write is a conditional update
 * that only matches a row still in `pending`. A redelivered event therefore
 * changes nothing the second time.
 */
export async function settlePlanChangesForSubscription(
  subscription: Stripe.Subscription,
  eventType: string | null = null
): Promise<{ settled: PlanChangeReservationStatus | null }> {
  const rows = await prisma.planChangeRequest.findMany({
    where: { stripeSubscriptionId: subscription.id, status: "pending" },
  });
  if (rows.length === 0) return { settled: null };

  const observedTier = await tierOfSubscription(subscription);
  const hasPendingUpdate = Boolean(subscription.pending_update);
  const scheduleId =
    typeof subscription.schedule === "string"
      ? subscription.schedule
      : (subscription.schedule?.id ?? null);
  const now = new Date();

  let settled: PlanChangeReservationStatus | null = null;

  for (const row of rows) {
    const next = resolvePlanChangeSettlement({
      execution:
        row.execution === "scheduled_downgrade"
          ? "scheduled_downgrade"
          : "immediate_upgrade",
      targetTier: row.toTier === "Max" ? "Max" : "Pro",
      reservationScheduleId: row.stripeScheduleId,
      confirmedAt: row.confirmedAt,
      observedTier,
      hasPendingUpdate,
      subscriptionScheduleId: scheduleId,
      eventType,
      now,
    });

    if (!next) continue;
    const transition = transitionPlanChangeReservation({
      from: "pending",
      to: next,
    });
    if (!transition.applied) continue;

    const applied = await prisma.planChangeRequest.updateMany({
      where: { id: row.id, status: "pending" },
      data: {
        status: next,
        pendingForUserId: null,
        settledAt: new Date(),
        ...(next === "failed" ? { failureCode: "pending_update_discarded" } : {}),
      },
    });
    if (applied.count > 0) settled = next;
  }

  return { settled };
}

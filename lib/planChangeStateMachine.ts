/**
 * The Pro <-> Max plan-change state machine.
 *
 * This module answers four questions and nothing else:
 *
 *   1. May this account change to this plan right now, and in which direction?
 *   2. Is the quote the customer is confirming still the quote we produced?
 *   3. Is this confirm the same confirm we already ran, or a new one?
 *   4. Where is a scheduled change in its life, and may it still be cancelled?
 *
 * It is deliberately **pure**: no Stripe client, no Prisma, no clock of its
 * own. Every decision is a function of values passed in, so the whole matrix --
 * including the out-of-order and duplicate webhook cases that only show up in
 * production -- can be pinned by tests that run in milliseconds.
 *
 * ## It does not presuppose Stripe's Customer Portal
 *
 * The Portal cannot express the approved downgrade. It refuses to offer more
 * than one price with the same recurring interval on a single Product, so the
 * approved same-interval, end-of-period Max -> Pro move does not fit it
 * *regardless of how Pro and Max are split across Products*. Tomverse
 * therefore drives Stripe directly, and this module names execution modes after
 * **what Tomverse does** -- `immediate_upgrade`, `scheduled_downgrade` -- not
 * after which Stripe surface performs it. The Portal remains useful for payment
 * methods, invoices and plain cancellation; it is not the execution path for a
 * plan change.
 *
 * See `docs/policy/plan-change.md` for the approved policy this encodes.
 */

export type PlanChangeTier = "Pro" | "Max";
export type PlanChangeInterval = "monthly" | "annual";
export type PlanChangeDirection = "upgrade" | "downgrade";

/**
 * How the change reaches the payment processor.
 *
 * `immediate_upgrade` -- swap the subscription item's price now, charge the
 * proration now, and grant Max only once that invoice is paid.
 *
 * `scheduled_downgrade` -- leave the current period on Max and reserve Pro for
 * the next one. The reservation lives on the server; it is never a client
 * timer and never "whenever the webhook happens to arrive".
 */
export type PlanChangeExecution = "immediate_upgrade" | "scheduled_downgrade";

const TIER_RANK: Record<PlanChangeTier, number> = { Pro: 1, Max: 2 };

/**
 * Statuses a subscription may be changed from.
 *
 * `past_due` is deliberately absent even though `/api/billing/checkout` counts
 * it as active. The two questions are different: for checkout, `past_due`
 * means "a subscription already exists, do not create a second one"; here it
 * would mean "invoice an upgrade to an account whose last invoice went
 * unpaid", which produces a second failed invoice and an entitlement nobody
 * can answer for. Support resolves the unpaid invoice first.
 */
const CHANGEABLE_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);

export const PLAN_CHANGE_REFUSAL_CODES = [
  "PLAN_CHANGE_NOT_SUPPORTED",
  "NO_ACTIVE_SUBSCRIPTION",
  "SUBSCRIPTION_NOT_CHANGEABLE",
  "BILLING_INTERVAL_CHANGE_NOT_SUPPORTED",
  "SUBSCRIPTION_NOT_SINGLE_ITEM",
  "PLAN_CHANGE_ALREADY_PENDING",
  "PLAN_CHANGE_ALREADY_SCHEDULED",
  "SUBSCRIPTION_SCHEDULE_CONFLICT",
  "PLAN_CHANGE_BLOCKED_BY_CANCELLATION",
] as const;

export type PlanChangeRefusalCode = (typeof PLAN_CHANGE_REFUSAL_CODES)[number];

/**
 * Every refusal here is a conflict with the account's current state rather
 * than a malformed request, so they all answer 409 -- the same status the
 * checkout route already uses for the blocks that stay in place. Parsing and
 * validating the request is the route's job and answers 400 there.
 */
export const PLAN_CHANGE_REFUSAL_STATUS = 409;

/**
 * What the payment processor currently says about the subscription.
 *
 * Field names describe billing facts, not Stripe API shapes, so the caller
 * that reads Stripe is the only place that knows where each value lives.
 */
export type PlanChangeSubscriptionSnapshot = {
  subscriptionId: string | null;
  /** Raw processor status, e.g. "active", "past_due". */
  status: string | null;
  /** The tier this subscription currently bills. */
  tier: "Free" | PlanChangeTier;
  interval: PlanChangeInterval | null;
  /** Lower-case ISO currency, e.g. "usd". The change must stay in it. */
  currency: string | null;
  /** Item ids on the subscription. A plan change requires exactly one. */
  itemIds: readonly string[];
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** A processor-side update waiting on payment or authentication. */
  hasPendingUpdate: boolean;
  /** A processor-side schedule driving this subscription, if any. */
  scheduleId: string | null;
};

export type PlanChangeReservationStatus =
  | "pending"
  | "applied"
  | "cancelled"
  | "expired"
  | "failed";

/** Tomverse's own record of a reserved change. The processor's schedule mirrors it. */
export type PlanChangeReservation = {
  id: string;
  targetTier: PlanChangeTier;
  interval: PlanChangeInterval;
  appliesAt: Date;
  status: PlanChangeReservationStatus;
  scheduleId: string | null;
};

/**
 * What happens to an existing end-of-period cancellation.
 *
 * There is no value meaning "we cleared it because they upgraded". Confirming
 * an upgrade is consent to change plan, not consent to start renewing again;
 * reading one as the other silently re-signs someone up for a subscription
 * they had cancelled. Clearing it requires `resumeRenewal`, which must come
 * from its own control with its own label.
 */
export type PlanChangeRenewalDecision =
  | "unaffected"
  | "cancellation_preserved"
  | "cancellation_cleared_by_explicit_consent";

export type PlanChangePlan = {
  direction: PlanChangeDirection;
  execution: PlanChangeExecution;
  fromTier: PlanChangeTier;
  toTier: PlanChangeTier;
  interval: PlanChangeInterval;
  currency: string;
  subscriptionId: string;
  subscriptionItemId: string;
  /** When the customer's entitlement actually moves. Null == on payment. */
  effectiveAt: Date | null;
  renewal: PlanChangeRenewalDecision;
};

export type PlanChangeResolution =
  | { allowed: true; plan: PlanChangePlan }
  | { allowed: false; code: PlanChangeRefusalCode; reason: string };

const refuse = (
  code: PlanChangeRefusalCode,
  reason: string
): PlanChangeResolution => ({ allowed: false, code, reason });

/**
 * Whether a change is permitted, and if so exactly what it is.
 *
 * Both the preview and the confirm endpoint call this, with the same inputs,
 * so a confirm cannot execute something the preview never offered. Order of
 * the checks is part of the contract: the cheapest and most specific refusals
 * come first so the customer sees the real reason rather than a generic one
 * that happened to match earlier.
 */
export function resolvePlanChange({
  snapshot,
  targetTier,
  targetInterval,
  reservation = null,
  resumeRenewal = false,
}: {
  snapshot: PlanChangeSubscriptionSnapshot;
  targetTier: PlanChangeTier;
  targetInterval: PlanChangeInterval;
  reservation?: PlanChangeReservation | null;
  /** Must originate from a dedicated opt-in, never from the confirm button. */
  resumeRenewal?: boolean;
}): PlanChangeResolution {
  if (!snapshot.subscriptionId) {
    return refuse(
      "NO_ACTIVE_SUBSCRIPTION",
      "There is no subscription to change; this is a new purchase."
    );
  }

  if (snapshot.tier === "Free") {
    // A subscription id with a Free tier means the account and the processor
    // disagree. Changing plans on top of that disagreement would write a
    // third state; a resync has to settle it first.
    return refuse(
      "SUBSCRIPTION_NOT_CHANGEABLE",
      "The stored plan and the subscription do not agree; resync before changing."
    );
  }

  if (!snapshot.status || !CHANGEABLE_STATUSES.has(snapshot.status)) {
    return refuse(
      "SUBSCRIPTION_NOT_CHANGEABLE",
      `A subscription in status "${snapshot.status ?? "unknown"}" cannot be changed.`
    );
  }

  if (snapshot.tier === targetTier) {
    return refuse(
      "PLAN_CHANGE_NOT_SUPPORTED",
      "The account is already on this plan."
    );
  }

  if (!snapshot.interval || snapshot.interval !== targetInterval) {
    // Includes the unknown-interval case on purpose: we cannot prove the
    // intervals match, and the approved policy allows only matching ones.
    return refuse(
      "BILLING_INTERVAL_CHANGE_NOT_SUPPORTED",
      "Only monthly-to-monthly and annual-to-annual changes are supported."
    );
  }

  if (snapshot.itemIds.length !== 1) {
    return refuse(
      "SUBSCRIPTION_NOT_SINGLE_ITEM",
      "A plan change replaces one subscription item; this subscription has " +
        `${snapshot.itemIds.length}.`
    );
  }

  if (!snapshot.currency) {
    return refuse(
      "SUBSCRIPTION_NOT_CHANGEABLE",
      "The subscription currency is unknown; the change would have to guess it."
    );
  }

  if (snapshot.hasPendingUpdate) {
    // An earlier change is waiting on payment or authentication. Starting a
    // second one replaces it at the processor and leaves the customer paying
    // for whichever won.
    return refuse(
      "PLAN_CHANGE_ALREADY_PENDING",
      "An earlier plan change is still waiting on payment or authentication."
    );
  }

  if (reservation?.status === "pending") {
    return refuse(
      "PLAN_CHANGE_ALREADY_SCHEDULED",
      "A plan change is already scheduled; cancel it before requesting another."
    );
  }

  if (snapshot.scheduleId && snapshot.scheduleId !== reservation?.scheduleId) {
    // Something outside this product is driving the subscription. Layering a
    // change on top of a schedule we did not create means two systems editing
    // the same phases, and the loser is discovered by a customer.
    return refuse(
      "SUBSCRIPTION_SCHEDULE_CONFLICT",
      "The subscription is driven by a schedule this product did not create."
    );
  }

  const fromTier = snapshot.tier;
  const direction: PlanChangeDirection =
    TIER_RANK[targetTier] > TIER_RANK[fromTier] ? "upgrade" : "downgrade";

  if (direction === "downgrade") {
    if (snapshot.cancelAtPeriodEnd) {
      // The subscription already ends at the period boundary. Reserving Pro
      // for the period after that would quietly revive a cancelled
      // subscription -- a bigger change than the one being requested.
      return refuse(
        "PLAN_CHANGE_BLOCKED_BY_CANCELLATION",
        "The subscription is already set to end at the period boundary."
      );
    }
    if (!snapshot.currentPeriodEnd) {
      return refuse(
        "SUBSCRIPTION_NOT_CHANGEABLE",
        "The current period end is unknown, so there is no date to reserve."
      );
    }
  }

  const renewal: PlanChangeRenewalDecision = !snapshot.cancelAtPeriodEnd
    ? "unaffected"
    : resumeRenewal
      ? "cancellation_cleared_by_explicit_consent"
      : "cancellation_preserved";

  return {
    allowed: true,
    plan: {
      direction,
      execution:
        direction === "upgrade" ? "immediate_upgrade" : "scheduled_downgrade",
      fromTier,
      toTier: targetTier,
      interval: targetInterval,
      currency: snapshot.currency,
      subscriptionId: snapshot.subscriptionId,
      subscriptionItemId: snapshot.itemIds[0]!,
      effectiveAt: direction === "upgrade" ? null : snapshot.currentPeriodEnd,
      renewal,
    },
  };
}

/** How long a quoted proration stays confirmable. */
export const PLAN_CHANGE_PREVIEW_TTL_MS = 10 * 60 * 1000;

/**
 * A stable description of every subscription fact the quote depends on.
 *
 * If any of these moved between preview and confirm -- a renewal advanced the
 * period, a coupon expired, the customer cancelled in another tab -- the
 * amount we showed is no longer the amount we would charge, and the customer
 * must be re-quoted rather than charged something they never saw.
 */
export function planChangeStateFingerprint(
  snapshot: PlanChangeSubscriptionSnapshot
): string {
  return [
    snapshot.subscriptionId ?? "-",
    snapshot.status ?? "-",
    snapshot.tier,
    snapshot.interval ?? "-",
    snapshot.currency ?? "-",
    [...snapshot.itemIds].sort().join(","),
    snapshot.currentPeriodEnd ? String(snapshot.currentPeriodEnd.getTime()) : "-",
    snapshot.cancelAtPeriodEnd ? "cancelling" : "renewing",
    snapshot.hasPendingUpdate ? "pending" : "settled",
    snapshot.scheduleId ?? "-",
  ].join("|");
}

export type PlanChangePreviewRecord = {
  id: string;
  userId: string;
  targetTier: PlanChangeTier;
  interval: PlanChangeInterval;
  fingerprint: string;
  createdAt: Date;
};

export type PlanChangePreviewCheck =
  | { usable: true }
  | {
      usable: false;
      reason: "expired" | "state_changed" | "different_target" | "not_owner";
    };

/** Whether a stored preview may still back a confirm. */
export function checkPlanChangePreview({
  preview,
  snapshot,
  userId,
  targetTier,
  targetInterval,
  now,
  ttlMs = PLAN_CHANGE_PREVIEW_TTL_MS,
}: {
  preview: PlanChangePreviewRecord;
  snapshot: PlanChangeSubscriptionSnapshot;
  userId: string;
  targetTier: PlanChangeTier;
  targetInterval: PlanChangeInterval;
  now: Date;
  ttlMs?: number;
}): PlanChangePreviewCheck {
  if (preview.userId !== userId) return { usable: false, reason: "not_owner" };
  if (preview.targetTier !== targetTier || preview.interval !== targetInterval) {
    return { usable: false, reason: "different_target" };
  }
  const age = now.getTime() - preview.createdAt.getTime();
  // A negative age means the record was written by a clock ahead of ours.
  // Treat it as expired rather than as infinitely fresh.
  if (age < 0 || age > ttlMs) return { usable: false, reason: "expired" };
  if (preview.fingerprint !== planChangeStateFingerprint(snapshot)) {
    return { usable: false, reason: "state_changed" };
  }
  return { usable: true };
}

/**
 * The key that makes a confirm safe to repeat.
 *
 * Derived from the preview, so a double-click, a retried request and a
 * back-button resubmit all carry the same key and the processor executes the
 * change once. A genuinely new attempt starts from a new preview and therefore
 * a new key -- which is the point: retrying a *failed* charge should re-quote
 * first, because the reason it failed may have changed the quote.
 */
export const planChangeIdempotencyKey = (previewId: string): string =>
  `plan-change:${previewId}`;

const RESERVATION_TRANSITIONS: Record<
  PlanChangeReservationStatus,
  readonly PlanChangeReservationStatus[]
> = {
  pending: ["applied", "cancelled", "expired", "failed"],
  applied: [],
  cancelled: [],
  expired: [],
  failed: [],
};

export type PlanChangeReservationTransition =
  | { applied: true }
  | {
      applied: false;
      reason: "already_in_state" | "terminal_state" | "illegal_transition";
    };

/**
 * Whether a reservation may move to `to`.
 *
 * Terminal states never move again, which is what makes duplicate and
 * out-of-order webhooks harmless: a redelivered `subscription_schedule.released`
 * arriving after the change already applied resolves to `terminal_state` and
 * changes nothing, instead of dragging a completed change back to pending.
 *
 * `already_in_state` is reported separately because it is the ordinary
 * at-least-once redelivery case, not a fault worth alerting on.
 */
export function transitionPlanChangeReservation({
  from,
  to,
}: {
  from: PlanChangeReservationStatus;
  to: PlanChangeReservationStatus;
}): PlanChangeReservationTransition {
  if (from === to) return { applied: false, reason: "already_in_state" };
  const allowed = RESERVATION_TRANSITIONS[from];
  if (allowed.length === 0) return { applied: false, reason: "terminal_state" };
  if (!allowed.includes(to)) {
    return { applied: false, reason: "illegal_transition" };
  }
  return { applied: true };
}

/**
 * How long after a confirm we refuse to conclude anything from absence.
 *
 * Right after a confirm the processor has not necessarily finished writing:
 * the invoice may still be being created, the schedule may not yet be attached
 * to the subscription. A webhook re-read inside that window can legitimately
 * show neither the new plan nor the pending update, and reading that as "the
 * change failed" would tear down a change that is about to succeed.
 */
export const PLAN_CHANGE_SETTLEMENT_GRACE_MS = 10 * 60 * 1000;

/**
 * What an in-flight change has become, judged against a subscription just
 * re-read from the processor. Null means "still in flight, decide later".
 *
 * Absence of evidence is only treated as failure outside the grace window, or
 * when the processor said so outright by expiring the pending update.
 */
export function resolvePlanChangeSettlement({
  execution,
  targetTier,
  reservationScheduleId,
  confirmedAt,
  observedTier,
  hasPendingUpdate,
  subscriptionScheduleId,
  eventType = null,
  now,
  graceMs = PLAN_CHANGE_SETTLEMENT_GRACE_MS,
}: {
  execution: PlanChangeExecution;
  targetTier: PlanChangeTier;
  reservationScheduleId: string | null;
  confirmedAt: Date | null;
  observedTier: "Free" | PlanChangeTier;
  hasPendingUpdate: boolean;
  subscriptionScheduleId: string | null;
  eventType?: string | null;
  now: Date;
  graceMs?: number;
}): PlanChangeReservationStatus | null {
  if (observedTier === targetTier) return "applied";

  // The processor discarded the parked change itself. Nothing to wait for.
  if (
    execution === "immediate_upgrade" &&
    eventType === "customer.subscription.pending_update_expired"
  ) {
    return "failed";
  }

  const settledLongEnough =
    confirmedAt !== null && now.getTime() - confirmedAt.getTime() >= graceMs;
  if (!settledLongEnough) return null;

  if (execution === "immediate_upgrade") {
    return hasPendingUpdate ? null : "failed";
  }

  if (reservationScheduleId && subscriptionScheduleId !== reservationScheduleId) {
    // The schedule that backed the reservation is no longer on the
    // subscription, and the plan did not move. Nothing will apply it.
    return "cancelled";
  }

  return null;
}

export type PlanChangeCancellationCheck =
  | { allowed: true }
  | {
      allowed: false;
      code: "NO_SCHEDULED_PLAN_CHANGE" | "PLAN_CHANGE_ALREADY_APPLIED";
    };

/**
 * Whether a reserved downgrade may still be called off.
 *
 * The period boundary is the cut-off rather than the arrival of a webhook: at
 * `appliesAt` the processor may already have moved the subscription, so
 * accepting a cancellation after it would tell the customer their Max plan
 * continues while the invoice says otherwise.
 */
export function checkPlanChangeCancellation({
  reservation,
  now,
}: {
  reservation: PlanChangeReservation | null;
  now: Date;
}): PlanChangeCancellationCheck {
  if (!reservation || reservation.status !== "pending") {
    if (reservation?.status === "applied") {
      return { allowed: false, code: "PLAN_CHANGE_ALREADY_APPLIED" };
    }
    return { allowed: false, code: "NO_SCHEDULED_PLAN_CHANGE" };
  }
  if (now.getTime() >= reservation.appliesAt.getTime()) {
    return { allowed: false, code: "PLAN_CHANGE_ALREADY_APPLIED" };
  }
  return { allowed: true };
}

export const PLAN_CHANGE_AUDIT_ACTIONS = {
  previewed: "billing.plan_change.previewed",
  confirmed: "billing.plan_change.confirmed",
  cancelled: "billing.plan_change.cancelled",
  settled: "billing.plan_change.settled",
} as const;

/**
 * The fields support needs to answer "what happened to my plan?", and nothing
 * else.
 *
 * No email, no name, no amounts: this is written to the admin audit log and
 * read by people diagnosing a change, so it carries identifiers they can look
 * up rather than personal data they did not need to see.
 */
export function describePlanChangeForSupport({
  plan,
  previewId,
  reservationStatus = null,
}: {
  plan: PlanChangePlan;
  previewId: string;
  reservationStatus?: PlanChangeReservationStatus | null;
}): Record<string, string | boolean | null> {
  return {
    previewId,
    direction: plan.direction,
    execution: plan.execution,
    fromTier: plan.fromTier,
    toTier: plan.toTier,
    interval: plan.interval,
    currency: plan.currency,
    subscriptionId: plan.subscriptionId,
    subscriptionItemId: plan.subscriptionItemId,
    effectiveAt: plan.effectiveAt ? plan.effectiveAt.toISOString() : null,
    renewal: plan.renewal,
    reservationStatus,
  };
}

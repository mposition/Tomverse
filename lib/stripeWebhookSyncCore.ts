/**
 * Which Stripe events mean "re-read this subscription", and whether a given
 * read is still current enough to store.
 *
 * Stripe delivers webhooks at-least-once and **in no guaranteed order**
 * (https://docs.stripe.com/webhooks#event-ordering). The webhook handler used
 * to write `event.data.object` straight into the database, which makes the
 * event payload the source of truth -- so a `customer.subscription.updated`
 * that was generated before an upgrade, but arrives after it, silently reverts
 * the account to the older plan. Nothing detects that; the customer just loses
 * what they paid for.
 *
 * Two rules fix it, and both live here so they can be tested without Stripe or
 * a database:
 *
 *   1. **The event is a trigger, not a fact.** Every handled event resolves to
 *      a subscription id, and the current state is then re-read from Stripe.
 *   2. **A read can still lose a race.** Two events can be in flight at once,
 *      so the read is stamped with when it was taken and refused if the stored
 *      state came from a later read.
 */

/**
 * Event types that mean the subscription's state may have moved.
 *
 * `invoice.*` matters because a Pro -> Max change made with
 * `payment_behavior: pending_if_incomplete` does not take effect until its
 * invoice is paid: the subscription object still reads as Pro while an SCA
 * challenge is outstanding, and it is `invoice.paid` that says otherwise.
 * `pending_update_expired` is the opposite outcome -- the change was never
 * completed and Stripe has discarded it.
 */
export const SUBSCRIPTION_RESYNC_EVENT_TYPES = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "subscription_schedule.created",
  "subscription_schedule.updated",
  "subscription_schedule.released",
  "subscription_schedule.canceled",
  "subscription_schedule.completed",
  "subscription_schedule.aborted",
] as const;

export type SubscriptionResyncEventType =
  (typeof SUBSCRIPTION_RESYNC_EVENT_TYPES)[number];

const RESYNC_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  SUBSCRIPTION_RESYNC_EVENT_TYPES
);

export const isSubscriptionResyncEvent = (
  eventType: string
): eventType is SubscriptionResyncEventType =>
  RESYNC_EVENT_TYPE_SET.has(eventType);

/** Stripe returns either an id or an expanded object in these positions. */
const idOf = (value: unknown): string | null => {
  if (typeof value === "string") return value || null;
  if (value && typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return null;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

/**
 * The subscription an event is about, or null when it is about nothing we
 * track.
 *
 * Deliberately takes a plain object rather than a typed Stripe event: the
 * position of the subscription differs per resource, and the point of the
 * tests is to pin those positions against real payload shapes.
 *
 * The invoice case is the one that is easy to get wrong. In this SDK version an
 * invoice does **not** carry `invoice.subscription` -- it is nested under
 * `parent.subscription_details.subscription`. Reading the old flat field
 * returns `undefined`, and the resync becomes a silent no-op that looks like it
 * ran.
 */
export function subscriptionIdFromEventObject(
  eventType: string,
  object: unknown
): string | null {
  const data = record(object);
  if (!data) return null;

  if (eventType.startsWith("customer.subscription.")) {
    return idOf(data.id);
  }

  if (eventType.startsWith("invoice.")) {
    const parent = record(data.parent);
    const details = record(parent?.subscription_details);
    const fromParent = idOf(details?.subscription);
    if (fromParent) return fromParent;
    // Pre-2025 payload shape, still possible from an older API version pinned
    // on an existing webhook endpoint.
    return idOf(data.subscription);
  }

  if (eventType.startsWith("subscription_schedule.")) {
    return idOf(data.subscription);
  }

  return null;
}

export type SubscriptionSyncDecision = {
  apply: boolean;
  reason: "first_observation" | "newer_observation" | "stale_observation";
};

/**
 * Whether a snapshot read at `observedAt` may overwrite what is stored.
 *
 * Equal timestamps apply: two reads taken in the same millisecond saw the same
 * Stripe state, so neither is stale and refusing both would drop a legitimate
 * update.
 *
 * `observedAt` must be captured **before** the Stripe request, not after. A
 * response only proves the state as of when Stripe built it; timestamping with
 * the later arrival time would let a slow request that read older data claim to
 * be newer than a fast one that read newer data.
 */
export function shouldApplySubscriptionSnapshot({
  storedObservedAt,
  observedAt,
}: {
  storedObservedAt: Date | null | undefined;
  observedAt: Date;
}): SubscriptionSyncDecision {
  if (!storedObservedAt) return { apply: true, reason: "first_observation" };
  if (storedObservedAt.getTime() <= observedAt.getTime()) {
    return { apply: true, reason: "newer_observation" };
  }
  return { apply: false, reason: "stale_observation" };
}

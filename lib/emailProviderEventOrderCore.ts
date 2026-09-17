/**
 * The order of provider events, so that processing them in any order ends in
 * the same state.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
 * (event order, C71, C77, C85).
 *
 * Pure: no database, so every permutation can be exercised without one.
 */

import type { ProviderEventEffect } from "@/lib/emailSuppressionCore";

/**
 * Rank within one instant. At the same time the more blocking event is the
 * later one, so a bounce and a delivery reported for the same second leave the
 * bounce standing.
 */
export const PROVIDER_EVENT_RANK = {
  sent: 0,
  delivered: 1,
  soft_bounce: 2,
  hard_bounce: 3,
  complaint: 4,
} as const;

export type ProviderEventKey = {
  occurredAt: Date;
  rank: number;
  /** The provider's own event id; the last tie-break, compared as a string. */
  eventId: string;
};

/**
 * How far ahead of receipt a provider's own timestamp may be before it is
 * disbelieved. A clock that far off would otherwise let one event outrank every
 * event that follows it.
 */
export const PROVIDER_EVENT_MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * When the event happened: the payload's `created_at` when it is an ISO 8601
 * timestamp no more than five minutes after receipt, otherwise the time the
 * event was first stored.
 */
export const providerEventOccurredAt = (input: {
  createdAt: unknown;
  receivedAt: Date;
}): Date => {
  if (typeof input.createdAt !== "string") return input.receivedAt;
  // ISO 8601 with a date and a time; Date.parse alone accepts far more.
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(input.createdAt)) return input.receivedAt;
  const parsed = Date.parse(input.createdAt);
  if (!Number.isFinite(parsed)) return input.receivedAt;
  if (parsed > input.receivedAt.getTime() + PROVIDER_EVENT_MAX_FUTURE_SKEW_MS) {
    return input.receivedAt;
  }
  return new Date(parsed);
};

/** The rank of an effect, or null for one that takes no part in the order. */
export const providerEventRank = (effect: ProviderEventEffect): number | null => {
  switch (effect.kind) {
    case "delivery_status":
      return effect.status === "delivered"
        ? PROVIDER_EVENT_RANK.delivered
        : PROVIDER_EVENT_RANK.sent;
    case "soft_bounce":
      return PROVIDER_EVENT_RANK.soft_bounce;
    case "suppress":
      return effect.reason === "complaint"
        ? PROVIDER_EVENT_RANK.complaint
        : PROVIDER_EVENT_RANK.hard_bounce;
    default:
      return null;
  }
};

/** Negative when `a` is earlier, positive when later, zero when the same event. */
export const compareProviderEventKeys = (a: ProviderEventKey, b: ProviderEventKey) => {
  const time = a.occurredAt.getTime() - b.occurredAt.getTime();
  if (time !== 0) return time;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
};

/**
 * Whether an event moves a delivery's status: only when it is later than the
 * last event that did. An older event never rolls the status back.
 */
export const providerEventAdvancesStatus = (
  event: ProviderEventKey,
  last: ProviderEventKey | null
) => last === null || compareProviderEventKeys(event, last) > 0;

/**
 * The run of soft bounces that counts toward suppression: deliveries of the
 * address whose latest soft bounce is after its latest delivered event.
 *
 * Compared by time with the rank tie-break folded in -- a soft bounce ranks
 * after a delivery -- so a soft bounce at the same instant as the latest
 * delivery counts, and one strictly earlier does not.
 */
export const softBounceRun = (input: {
  softBounceTimes: Array<Date | null>;
  latestDeliveredAt: Date | null;
}) =>
  input.softBounceTimes.filter(
    (at) =>
      at !== null &&
      (input.latestDeliveredAt === null || at.getTime() >= input.latestDeliveredAt.getTime())
  ).length;

/**
 * Whether a soft bounce may record a cause: not when the address has a later
 * delivered event. The same instant counts as later for the bounce.
 */
export const softBounceStillCurrent = (input: {
  occurredAt: Date;
  latestDeliveredAt: Date | null;
}) =>
  input.latestDeliveredAt === null ||
  input.occurredAt.getTime() >= input.latestDeliveredAt.getTime();

/**
 * Whether a delivered event releases a soft bounce cause: only one strictly
 * earlier. A bounce at the same instant ranks after the delivery and stands.
 */
export const deliveredReleasesSoftBounce = (input: {
  deliveredAt: Date;
  causeOccurredAt: Date;
}) => input.causeOccurredAt.getTime() < input.deliveredAt.getTime();

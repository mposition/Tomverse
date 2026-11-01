/**
 * Marketing touch attribution (docs/policy/marketing-automation.md §10.1).
 *
 * Pure: what the analytics route does with a `marketing_touch` and with the
 * two conversions §10.3 counts, and how a report classifies them. The query
 * that finds the touch is `findLatestMarketingTouch` in
 * lib/productAnalyticsServer.ts; everything decided about it is here, so it is
 * tested without a database.
 *
 * Three outcomes a report must keep apart:
 *
 * - **attributed**: the conversion event arrived and a touch from the same
 *   browser (or account) was received in the seven days before it;
 * - **unattributed**: the conversion event arrived and no such touch did;
 * - **unobserved**: the conversion happened and no event arrived at all --
 *   analytics declined, never decided in an opt-in region, or blocked. Only a
 *   sign-up can be counted this way, because the account row exists whether or
 *   not anybody consented; a guest's first answer leaves nothing to count.
 */

import {
  MARKETING_TOUCH_EVIDENCE_LEVELS,
  type ProductAnalyticsEventName,
  type ProductAnalyticsProperties,
} from "./productAnalyticsShared.ts";

export const MARKETING_TOUCH_EVENT = "marketing_touch" as const;

/** The only evidence level a touch can have today: §10.1's wording. */
export const MARKETING_TOUCH_EVIDENCE = MARKETING_TOUCH_EVIDENCE_LEVELS[0];

/** §10.1: the last touch in the seven days before the conversion was received. */
export const MARKETING_TOUCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Properties only the server writes. A client that sends any of them has them
 * removed before the server sets its own -- a browser cannot claim a touch, an
 * attribution or an evidence level.
 */
export const MARKETING_TOUCH_SERVER_PROPERTY_KEYS = [
  "touch_evidence",
  "touch_attribution",
  "touch_utm_source",
  "touch_utm_medium",
  "touch_utm_campaign",
  "touch_utm_content",
  "touch_received_at",
] as const satisfies ReadonlyArray<keyof ProductAnalyticsProperties>;

export const stripServerOnlyTouchProperties = (
  properties: ProductAnalyticsProperties
): ProductAnalyticsProperties => {
  const copy: Record<string, unknown> = { ...properties };
  for (const key of MARKETING_TOUCH_SERVER_PROPERTY_KEYS) delete copy[key];
  return copy as ProductAnalyticsProperties;
};

/**
 * Which events carry an attribution snapshot: a completed sign-up, and the
 * first answer a *guest* saw (§10.3's lead). A signed-in user's first answer
 * is not a lead -- the sign-up already carries that account's attribution.
 */
export const shouldSnapshotMarketingTouch = (
  eventName: ProductAnalyticsEventName,
  userId: string | null
) =>
  eventName === "signup_completed" ||
  (eventName === "first_response_completed" && !userId);

/** The receive-time window a touch must fall in, both ends inclusive. */
export const marketingTouchWindow = (receivedAt: Date) => ({
  gte: new Date(receivedAt.getTime() - MARKETING_TOUCH_WINDOW_MS),
  lte: receivedAt,
});

export const isWithinMarketingTouchWindow = (touchAt: Date, receivedAt: Date) => {
  const window = marketingTouchWindow(receivedAt);
  return (
    touchAt.getTime() >= window.gte.getTime() &&
    touchAt.getTime() <= window.lte.getTime()
  );
};

/** The touch row's fields an attribution copies. */
export type MarketingTouchRow = {
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmContent: string | null;
  occurredAt: Date;
};

/**
 * The snapshot fixed onto the conversion event. A touch outside the window is
 * treated as no touch, so a caller that passes a stale row cannot attribute
 * with it.
 */
export const marketingTouchSnapshot = (
  touch: MarketingTouchRow | null,
  receivedAt: Date
): ProductAnalyticsProperties => {
  if (!touch || !isWithinMarketingTouchWindow(touch.occurredAt, receivedAt)) {
    return { touch_attribution: "unattributed" };
  }
  return {
    touch_attribution: "attributed",
    touch_evidence: MARKETING_TOUCH_EVIDENCE,
    touch_utm_source: touch.utmSource.slice(0, 100),
    touch_utm_medium: touch.utmMedium.slice(0, 100),
    touch_utm_campaign: touch.utmCampaign.slice(0, 100),
    ...(touch.utmContent ? { touch_utm_content: touch.utmContent.slice(0, 100) } : {}),
    touch_received_at: touch.occurredAt.toISOString(),
  };
};

/** A recorded conversion event, as a report reads it. */
export type MarketingConversionRow = {
  properties: unknown;
};

const recordValue = (properties: unknown, key: string) =>
  properties && typeof properties === "object" && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)[key]
    : undefined;

export type MarketingTouchChannelCount = {
  source: string;
  medium: string;
  campaign: string;
  content: string | null;
  count: number;
  /** §10.3: fewer than ten conversions on a channel is no basis for a decision. */
  held: boolean;
};

export type MarketingTouchAttributionSummary = {
  evidence: typeof MARKETING_TOUCH_EVIDENCE;
  attributed: number;
  unattributed: number;
  /** Null where the conversion leaves no server record to count against. */
  unobserved: number | null;
  channels: MarketingTouchChannelCount[];
};

export const MARKETING_TOUCH_CHANNEL_DECISION_MINIMUM = 10;

/**
 * Attributed / unattributed / unobserved for one kind of conversion. An event
 * with no snapshot at all -- written before touches were recorded -- had no
 * touch to find, so it is unattributed rather than dropped.
 */
export const summarizeMarketingTouchAttribution = (input: {
  conversions: readonly MarketingConversionRow[];
  unobserved: number | null;
  channelLimit?: number;
}): MarketingTouchAttributionSummary => {
  let attributed = 0;
  const channels = new Map<string, MarketingTouchChannelCount>();
  for (const row of input.conversions) {
    if (recordValue(row.properties, "touch_attribution") !== "attributed") continue;
    attributed += 1;
    const text = (key: string) => {
      const value = recordValue(row.properties, key);
      return typeof value === "string" && value ? value : null;
    };
    const source = text("touch_utm_source") ?? "(direct)";
    const medium = text("touch_utm_medium") ?? "(none)";
    const campaign = text("touch_utm_campaign") ?? "(not set)";
    const content = text("touch_utm_content");
    const key = JSON.stringify([source, medium, campaign, content]);
    const existing = channels.get(key);
    if (existing) existing.count += 1;
    else channels.set(key, { source, medium, campaign, content, count: 1, held: true });
  }
  return {
    evidence: MARKETING_TOUCH_EVIDENCE,
    attributed,
    unattributed: input.conversions.length - attributed,
    unobserved: input.unobserved === null ? null : Math.max(0, input.unobserved),
    channels: [...channels.values()]
      .map((channel) => ({
        ...channel,
        held: channel.count < MARKETING_TOUCH_CHANNEL_DECISION_MINIMUM,
      }))
      .sort((left, right) => right.count - left.count)
      .slice(0, input.channelLimit ?? 10),
  };
};

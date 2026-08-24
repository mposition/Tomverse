/**
 * When marketing sending stops itself.
 *
 * Contract: docs/policy/email-notifications.md §14.5,
 * .github/audits/model-lifecycle-email-2026-08-22.md EM-09.
 *
 * §14.5 sets four numbers and one consequence: past a bounce or complaint rate,
 * marketing sending halts. Nothing implemented it, so a campaign that started
 * drawing complaints would have kept sending until somebody watched a
 * dashboard.
 *
 * ## Why the halt is sticky
 *
 * The window rolls. A halt that lifted when the bad sends aged out of it would
 * resume into exactly the reputation it was protecting -- and domain reputation
 * is, by §14.5's own framing, the slowest thing here to recover. So tripping is
 * automatic and clearing is a person's decision.
 *
 * ## Why a rate alone cannot halt
 *
 * One complaint out of a hundred sends is 1%, three times the halt threshold,
 * and it is one person clicking a button. A rate over a tiny denominator is not
 * a rate. So a halt needs the rate *and* enough events to be a pattern.
 *
 * There is deliberately no floor on the denominator. A send of two hundred that
 * draws three complaints has already found its problem, and requiring the
 * ~1,000 recipients that would make 0.3% arithmetically reachable would mean
 * the switch never fires for a small campaign -- which is every campaign this
 * system will send first.
 *
 * Warnings have no minimum at all. A warning costs a log line and is the signal
 * that arrives before the damage.
 */

/** Rolling window the rates are measured over. */
export const MARKETING_HEALTH_WINDOW_DAYS = 7;

export const MARKETING_HEALTH_THRESHOLDS = {
  bounce: { warn: 0.02, halt: 0.05 },
  complaint: { warn: 0.001, halt: 0.003 },
} as const;

/**
 * How many bad events make a rate mean something.
 *
 * Complaints are rarer and worse, so three is a pattern. Bounces happen for
 * mundane reasons -- a mailbox that filled up, a typo in an address somebody
 * typed themselves -- so ten.
 */
export const MARKETING_HEALTH_MINIMUM_EVENTS = {
  bounce: 10,
  complaint: 3,
} as const;

export type MarketingSendCounts = {
  /** Marketing messages the provider accepted in the window. */
  sent: number;
  bounced: number;
  complained: number;
};

export type MarketingHealthMetric = "bounce" | "complaint";

export type MarketingHealthVerdict = {
  level: "ok" | "warning" | "halt";
  /** Which metric decided, absent when nothing did. */
  metric: MarketingHealthMetric | null;
  /** The rate that decided, as a fraction. */
  rate: number;
  /** The count behind that rate, so a log line can be read without the query. */
  observed: number;
  sent: number;
  reason: string | null;
};

const rateOf = (count: number, sent: number) => (sent > 0 ? count / sent : 0);

const percent = (value: number) => `${(value * 100).toFixed(2)}%`;

/**
 * What the numbers say, with no memory of what they said before.
 *
 * Complaints outrank bounces when both are over: a complaint is a recipient
 * telling their mailbox provider this was spam, and it is the metric that
 * closes a sending domain.
 */
export const marketingSendHealth = (
  counts: MarketingSendCounts
): MarketingHealthVerdict => {
  const bounceRate = rateOf(counts.bounced, counts.sent);
  const complaintRate = rateOf(counts.complained, counts.sent);

  const base = { sent: counts.sent };

  if (
    complaintRate > MARKETING_HEALTH_THRESHOLDS.complaint.halt &&
    counts.complained >= MARKETING_HEALTH_MINIMUM_EVENTS.complaint
  ) {
    return {
      ...base,
      level: "halt",
      metric: "complaint",
      rate: complaintRate,
      observed: counts.complained,
      reason: `Complaint rate ${percent(complaintRate)} over ${counts.sent} marketing message(s) is above the ${percent(MARKETING_HEALTH_THRESHOLDS.complaint.halt)} halt threshold (${counts.complained} complaints).`,
    };
  }

  if (
    bounceRate > MARKETING_HEALTH_THRESHOLDS.bounce.halt &&
    counts.bounced >= MARKETING_HEALTH_MINIMUM_EVENTS.bounce
  ) {
    return {
      ...base,
      level: "halt",
      metric: "bounce",
      rate: bounceRate,
      observed: counts.bounced,
      reason: `Bounce rate ${percent(bounceRate)} over ${counts.sent} marketing message(s) is above the ${percent(MARKETING_HEALTH_THRESHOLDS.bounce.halt)} halt threshold (${counts.bounced} bounces).`,
    };
  }

  if (complaintRate > MARKETING_HEALTH_THRESHOLDS.complaint.warn) {
    return {
      ...base,
      level: "warning",
      metric: "complaint",
      rate: complaintRate,
      observed: counts.complained,
      reason: `Complaint rate ${percent(complaintRate)} is above the ${percent(MARKETING_HEALTH_THRESHOLDS.complaint.warn)} warning threshold.`,
    };
  }

  if (bounceRate > MARKETING_HEALTH_THRESHOLDS.bounce.warn) {
    return {
      ...base,
      level: "warning",
      metric: "bounce",
      rate: bounceRate,
      observed: counts.bounced,
      reason: `Bounce rate ${percent(bounceRate)} is above the ${percent(MARKETING_HEALTH_THRESHOLDS.bounce.warn)} warning threshold.`,
    };
  }

  return {
    ...base,
    level: "ok",
    metric: null,
    rate: 0,
    observed: 0,
    reason: null,
  };
};

/** What the stored halt holds. Serialised into AppSetting as JSON. */
export type MarketingHaltState = {
  haltedAt: string;
  metric: MarketingHealthMetric;
  rate: number;
  observed: number;
  sent: number;
  reason: string;
};

export const MARKETING_HALT_SETTING_KEY = "email.marketingHalt";

/**
 * Reads the stored halt, treating anything unreadable as halted.
 *
 * Fail-closed on purpose. The alternative to "we cannot tell whether marketing
 * was halted" is sending, and the reason a halt exists is that sending is the
 * move that cannot be taken back.
 */
export const parseMarketingHalt = (
  raw: string | null | undefined
): { halted: boolean; state: MarketingHaltState | null } => {
  if (raw === null || raw === undefined) return { halted: false, state: null };
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return { halted: false, state: null };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { halted: true, state: null };
    }
    const value = parsed as Record<string, unknown>;
    if (typeof value.haltedAt !== "string" || typeof value.reason !== "string") {
      return { halted: true, state: null };
    }
    return {
      halted: true,
      state: {
        haltedAt: value.haltedAt,
        metric: value.metric === "bounce" ? "bounce" : "complaint",
        rate: typeof value.rate === "number" ? value.rate : 0,
        observed: typeof value.observed === "number" ? value.observed : 0,
        sent: typeof value.sent === "number" ? value.sent : 0,
        reason: value.reason,
      },
    };
  } catch {
    return { halted: true, state: null };
  }
};

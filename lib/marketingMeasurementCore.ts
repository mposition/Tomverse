/**
 * The marketing measurement both reports read (owner request 2026-11-03):
 * the weekly report (policy §10.3's 120-day metrics for one week) and the
 * morning report's figures. Counting, not judging: what the post ledger,
 * the analytics events and the LLM ledger say about one window, plus the
 * queue as it stands now. A metric whose sample is too small is held
 * (`insufficient_evidence`), never reported as a rate or a zero trend.
 *
 * Pure, so it is tested without a database (lib/marketingMeasurement.ts
 * reads the rows). Imports nothing.
 */

/** Sends below which a success rate is held rather than reported. */
export const MARKETING_MEASUREMENT_MIN_SENT = 5;

/** Attributed sign-ups below which a channel decision is held (policy §10.3). */
export const MARKETING_MEASUREMENT_MIN_SIGNUPS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export type MarketingMeasurementWindow = { readonly start: Date; readonly end: Date };

/**
 * The window of one Brisbane week (UTC+10, no daylight saving) from its
 * Monday, or null when the date is not a Monday.
 */
export function marketingWeekWindow(weekStart: string): MarketingMeasurementWindow | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return null;
  const start = new Date(`${weekStart}T00:00:00+10:00`);
  if (Number.isNaN(start.getTime())) return null;
  // The Brisbane weekday of a Brisbane midnight is the UTC weekday ten hours on.
  if (new Date(start.getTime() + 10 * 60 * 60 * 1000).getUTCDay() !== 1) return null;
  return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
}

export type MarketingMeasurementPost = {
  readonly accountSlug: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly approvedAt: Date | null;
  readonly scheduledAt: Date | null;
  readonly publishedAt: Date | null;
  readonly verifiedPublicAt: Date | null;
  readonly outcomeUnknownAt: Date | null;
  readonly approvalExpiresAt: Date | null;
  readonly errorCode: string | null;
  readonly guardCodes: readonly string[];
  /** The dispatch attempts in the post's history (`type: "attempt"` entries). */
  readonly attempts: ReadonlyArray<{
    readonly at: Date;
    readonly attempt: number;
    readonly outcome: string;
    readonly errorCode: string | null;
  }>;
};

export type MarketingMeasurementChannel = {
  readonly accountSlug: string;
  readonly channel: string;
  readonly status: string;
  readonly pauseReasonCode: string | null;
};

export type MarketingConversionCount = { readonly total: number; readonly attributed: number };

export type MarketingMeasurementLlm = {
  readonly calls: number;
  readonly countedMicroUsd: number;
  /** The operator's monthly cap, or null when none is set or it cannot be read. */
  readonly capUsd: number | null;
};

export type MarketingMeasurement = {
  readonly window: { readonly start: string; readonly end: string };
  readonly drafts: { readonly created: number; readonly guardCodes: ReadonlyArray<{ code: string; count: number }> };
  readonly decisions: { readonly approved: number; readonly rejected: number; readonly expired: number };
  readonly dispatch: {
    readonly sent: number;
    readonly published: number;
    readonly verified: number;
    readonly failed: number;
    readonly outcomeUnknown: number;
    /** Verified ÷ sent, or null while fewer than the minimum were sent. */
    readonly successRate: number | null;
    readonly latencyP50Ms: number | null;
    readonly latencyP95Ms: number | null;
    readonly failuresByCode: ReadonlyArray<{ code: string; count: number }>;
  };
  /** The queue now, whatever the window. */
  readonly queue: {
    readonly pendingApproval: number;
    readonly oldestPendingAt: string | null;
    readonly approvedWaiting: number;
    readonly nextApprovalExpiryAt: string | null;
    readonly scheduled: number;
  };
  readonly accounts: ReadonlyArray<{
    readonly accountSlug: string;
    readonly channel: string;
    readonly status: string;
    readonly pauseReasonCode: string | null;
    readonly published: number;
    readonly failed: number;
    readonly pendingApproval: number;
    readonly approvedWaiting: number;
  }>;
  /** Null where the number could not be read; the screen says so instead of zero. */
  readonly touches: number | null;
  readonly signups: MarketingConversionCount | null;
  readonly guestLeads: MarketingConversionCount | null;
  readonly llm: MarketingMeasurementLlm | null;
  /** Metrics held for too small a sample. */
  readonly held: ReadonlyArray<"success_rate" | "latency" | "signups">;
};

const within = (date: Date | null, window: MarketingMeasurementWindow) =>
  date !== null && date.getTime() >= window.start.getTime() && date.getTime() < window.end.getTime();

/** The nearest-rank percentile of sorted values, or null when there are none. */
export function marketingPercentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

const tally = (values: readonly string[]) =>
  [...values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map<string, number>())]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || (left.code < right.code ? -1 : 1));

const earliest = (dates: ReadonlyArray<Date | null>) => {
  const times = dates.filter((date): date is Date => date !== null).map((date) => date.getTime());
  return times.length === 0 ? null : new Date(Math.min(...times)).toISOString();
};

export function summarizeMarketingMeasurement(input: {
  readonly window: MarketingMeasurementWindow;
  readonly posts: readonly MarketingMeasurementPost[];
  readonly channels: readonly MarketingMeasurementChannel[];
  readonly touches: number | null;
  readonly signups: MarketingConversionCount | null;
  readonly guestLeads: MarketingConversionCount | null;
  readonly llm: MarketingMeasurementLlm | null;
}): MarketingMeasurement {
  const { window, posts } = input;
  const created = posts.filter((post) => within(post.createdAt, window));
  // A send is one dispatch attempt of one post: read from the attempt history,
  // not the post's status now, so a failure that was requeued and then
  // published counts as two sends, one failed and one published. An attempt's
  // outcome is its newest entry in the window (an unknown outcome resolved as
  // failed is one send). A post still `publishing` is a send not yet resolved.
  const attempts = new Map<string, { post: MarketingMeasurementPost; at: Date; outcome: string; errorCode: string | null }>();
  posts.forEach((post, index) => {
    for (const entry of post.attempts) {
      if (!within(entry.at, window)) continue;
      const key = `${index}:${entry.attempt}`;
      const seen = attempts.get(key);
      if (!seen || seen.at.getTime() <= entry.at.getTime()) attempts.set(key, { post, ...entry });
    }
  });
  const resolved = [...attempts.values()];
  const inFlight = posts.filter((post) => post.status === "publishing" && within(post.updatedAt, window)).length;
  const published = resolved.filter((entry) => entry.outcome === "published");
  const failed = resolved.filter((entry) => entry.outcome === "failed");
  const unknown = resolved.filter((entry) => entry.outcome === "outcome_unknown");
  const sent = resolved.length + inFlight;
  const verified = published.filter((entry) => entry.post.verifiedPublicAt !== null).length;
  const latencies = published
    .map((entry) => {
      const from = entry.post.scheduledAt ?? entry.post.approvedAt;
      return from ? entry.at.getTime() - from.getTime() : null;
    })
    .filter((value): value is number => value !== null && value >= 0)
    .sort((left, right) => left - right);
  const pending = posts.filter((post) => post.status === "pending_approval");
  const approved = posts.filter((post) => post.status === "approved");

  const held: Array<"success_rate" | "latency" | "signups"> = [];
  if (sent < MARKETING_MEASUREMENT_MIN_SENT) held.push("success_rate");
  if (latencies.length === 0) held.push("latency");
  if (!input.signups || input.signups.attributed < MARKETING_MEASUREMENT_MIN_SIGNUPS) held.push("signups");

  return {
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    drafts: { created: created.length, guardCodes: tally(created.flatMap((post) => post.guardCodes)) },
    decisions: {
      approved: posts.filter((post) => within(post.approvedAt, window)).length,
      rejected: posts.filter((post) => post.status === "rejected" && within(post.updatedAt, window)).length,
      expired: posts.filter((post) => post.status === "approval_expired" && within(post.updatedAt, window)).length,
    },
    dispatch: {
      sent,
      published: published.length,
      verified,
      failed: failed.length,
      outcomeUnknown: unknown.length,
      successRate: sent < MARKETING_MEASUREMENT_MIN_SENT ? null : verified / sent,
      latencyP50Ms: marketingPercentile(latencies, 0.5),
      latencyP95Ms: marketingPercentile(latencies, 0.95),
      failuresByCode: tally(failed.map((entry) => entry.errorCode ?? "unknown")),
    },
    queue: {
      pendingApproval: pending.length,
      oldestPendingAt: earliest(pending.map((post) => post.createdAt)),
      approvedWaiting: approved.length,
      nextApprovalExpiryAt: earliest(approved.map((post) => post.approvalExpiresAt)),
      scheduled: posts.filter((post) => post.status === "scheduled").length,
    },
    accounts: input.channels.map((channel) => {
      const mine = (rows: ReadonlyArray<{ readonly accountSlug: string }>) =>
        rows.filter((row) => row.accountSlug === channel.accountSlug).length;
      const mineSent = (rows: ReadonlyArray<{ readonly post: MarketingMeasurementPost }>) =>
        rows.filter((row) => row.post.accountSlug === channel.accountSlug).length;
      return {
        accountSlug: channel.accountSlug,
        channel: channel.channel,
        status: channel.status,
        pauseReasonCode: channel.pauseReasonCode,
        published: mineSent(published),
        failed: mineSent(failed),
        pendingApproval: mine(pending),
        approvedWaiting: mine(approved),
      };
    }),
    touches: input.touches,
    signups: input.signups,
    guestLeads: input.guestLeads,
    llm: input.llm,
    held,
  };
}

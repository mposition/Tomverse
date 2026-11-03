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

/**
 * Failures the publisher records before it calls the publishing tool
 * (lib/marketingPublisherBatch.ts): no request left, so they are not sends
 * (policy §10.3 counts requests sent to the tool). A test holds this list to
 * the publisher's source.
 */
export const MARKETING_NOT_SENT_ERROR_CODES: readonly string[] = [
  "run_deadline_before_call",
  "approval_expired_before_call",
  "account_ref_missing",
];

/** The statuses a post is in once it is out on a platform. */
const MARKETING_PUBLISHED_STATUSES: readonly string[] = ["published", "verified", "removed_by_platform", "deleted"];

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
  /** The newest dispatch attempt's number. */
  readonly publishAttempt: number;
  /** `approval` or `autonomous`: the mode the post was written under. */
  readonly mode: string;
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
  /**
   * The spans of attempt entries retention has folded into a summary
   * (`retention_summary` entries, after ninety days): sends in them can no
   * longer be counted one by one.
   */
  readonly compactedAttempts: ReadonlyArray<{ readonly firstAt: Date; readonly lastAt: Date }>;
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

export type MarketingDecisionCount = { readonly approved: number; readonly rejected: number; readonly expired: number };

/** Attributed sign-ups of one landing channel (its touch's UTM source, medium and campaign). */
export type MarketingSignupChannel = {
  readonly source: string;
  readonly medium: string;
  readonly campaign: string;
  readonly attributed: number;
  /** Fewer than the minimum: no decision rests on this channel yet (policy §10.3). */
  readonly held: boolean;
};

export type MarketingMeasurementLlm = {
  readonly calls: number;
  readonly countedMicroUsd: number;
  /** The operator's monthly cap, or null when none is set or it cannot be read. */
  readonly capUsd: number | null;
};

export type MarketingMeasurement = {
  readonly window: { readonly start: string; readonly end: string };
  readonly drafts: { readonly created: number; readonly guardCodes: ReadonlyArray<{ code: string; count: number }> };
  /**
   * Approvals (re-approvals after a failure included), rejections and expiries
   * in the window, by the audit record each decision wrote -- not the post's
   * columns, which a later decision overwrites. Null when it cannot be read.
   */
  readonly decisions: MarketingDecisionCount | null;
  /** Posts that went out in the window, by `publishedAt` (the stored weekly KPI's count). */
  readonly publishedInWindow: number;
  readonly dispatch: MarketingSendStats & {
    /** Failures recorded before the tool was called: not sends, counted apart. */
    readonly notSent: number;
    /**
     * Whether retention has already folded some of the window's attempts into
     * summaries. Then the send measures are incomplete: every one of them is
     * held, never shown as a count or a rate.
     */
    readonly compacted: boolean;
    /**
     * Posts `publishing` now: requests out with no outcome recorded. Not yet
     * sends -- a send is counted once, in the window its first outcome is
     * recorded, so it never moves between windows -- and shown apart.
     */
    readonly inFlight: number;
    /** The same measures by the mode each post was written under (policy §10.3). */
    readonly byMode: ReadonlyArray<MarketingSendStats & { readonly mode: string }>;
    /** And by mode and account, each held on its own sample. */
    readonly segments: ReadonlyArray<MarketingSendStats & { readonly mode: string; readonly accountSlug: string }>;
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
    /** Went out in the window, by `publishedAt`. */
    readonly published: number;
    readonly pendingApproval: number;
    readonly approvedWaiting: number;
  }>;
  /** Null where the number could not be read; the screen says so instead of zero. */
  readonly touches: number | null;
  readonly signups: MarketingConversionCount | null;
  /** Attributed sign-ups by landing channel; the sign-up hold is judged per channel. */
  readonly signupChannels: readonly MarketingSignupChannel[] | null;
  readonly guestLeads: MarketingConversionCount | null;
  readonly llm: MarketingMeasurementLlm | null;
  /** Metrics held for too small a sample. */
  readonly held: ReadonlyArray<"success_rate" | "latency" | "signups" | "sends_compacted">;
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

/**
 * The policy §10.3 measures of a set of sends: counts by outcome, verified
 * public, the success rate (verified ÷ sent) and the publish delay, each held
 * when its sample is too small. A send's verification is the post's: one
 * verified after the window is still a verified send of it.
 */
export type MarketingSendStats = {
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
  readonly held: ReadonlyArray<"success_rate" | "latency">;
};

type ResolvedSend = {
  readonly post: MarketingMeasurementPost;
  readonly at: Date;
  readonly outcome: string;
  readonly errorCode: string | null;
};

function marketingSendStats(sends: readonly ResolvedSend[]): MarketingSendStats {
  const published = sends.filter((entry) => entry.outcome === "published");
  const failed = sends.filter((entry) => entry.outcome === "failed");
  const verified = published.filter((entry) => entry.post.verifiedPublicAt !== null).length;
  const latencies = published
    .map((entry) => {
      const from = entry.post.scheduledAt ?? entry.post.approvedAt;
      return from ? entry.at.getTime() - from.getTime() : null;
    })
    .filter((value): value is number => value !== null && value >= 0)
    .sort((left, right) => left - right);
  const held: Array<"success_rate" | "latency"> = [];
  if (sends.length < MARKETING_MEASUREMENT_MIN_SENT) held.push("success_rate");
  if (latencies.length < MARKETING_MEASUREMENT_MIN_SENT) held.push("latency");
  return {
    sent: sends.length,
    published: published.length,
    verified,
    failed: failed.length,
    outcomeUnknown: sends.filter((entry) => entry.outcome === "outcome_unknown").length,
    successRate: sends.length < MARKETING_MEASUREMENT_MIN_SENT ? null : verified / sends.length,
    latencyP50Ms: marketingPercentile(latencies, 0.5),
    latencyP95Ms: marketingPercentile(latencies, 0.95),
    failuresByCode: tally(failed.map((entry) => entry.errorCode ?? "unknown")),
    held,
  };
}

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
  readonly signupChannels: ReadonlyArray<Omit<MarketingSignupChannel, "held">> | null;
  readonly guestLeads: MarketingConversionCount | null;
  readonly llm: MarketingMeasurementLlm | null;
  readonly decisions: MarketingDecisionCount | null;
}): MarketingMeasurement {
  const { window, posts } = input;
  const created = posts.filter((post) => within(post.createdAt, window));
  // A send is one dispatch attempt of one post, read from the attempt history
  // rather than the post's status now, so a failure requeued and then
  // published is two sends. Each attempt belongs to the window of its first
  // entry, and its outcome is its newest entry, wherever that falls: an
  // unknown outcome resolved as failed a week later is one send, in the first
  // week. A post still `publishing` is not yet a send (`inFlight`).
  const resolved: ResolvedSend[] = [];
  let notSent = 0;
  for (const post of posts) {
    const byAttempt = new Map<number, MarketingMeasurementPost["attempts"][number][]>();
    for (const entry of post.attempts) byAttempt.set(entry.attempt, [...(byAttempt.get(entry.attempt) ?? []), entry]);
    for (const [attempt, entries] of byAttempt) {
      const ordered = [...entries].sort((left, right) => left.at.getTime() - right.at.getTime());
      if (!within(ordered[0].at, window)) continue;
      const last = ordered[ordered.length - 1];
      // A person confirming an unknown outcome as published moves the post
      // and writes no attempt entry: the post's state is that resolution.
      if (
        last.outcome === "outcome_unknown" &&
        attempt === post.publishAttempt &&
        MARKETING_PUBLISHED_STATUSES.includes(post.status)
      ) {
        resolved.push({ post, at: post.publishedAt ?? last.at, outcome: "published", errorCode: null });
        continue;
      }
      // Stopped before the publishing tool was called: nothing was sent.
      if (last.outcome === "failed" && last.errorCode !== null && MARKETING_NOT_SENT_ERROR_CODES.includes(last.errorCode)) {
        notSent += 1;
        continue;
      }
      resolved.push({ post, at: last.at, outcome: last.outcome, errorCode: last.errorCode });
    }
  }
  const inFlight = posts.filter((post) => post.status === "publishing").length;
  const signupChannels =
    input.signupChannels === null
      ? null
      : input.signupChannels.map((channel) => ({
          ...channel,
          held: channel.attributed < MARKETING_MEASUREMENT_MIN_SIGNUPS,
        }));
  // Retention summarises old attempt entries but may keep a later entry of the
  // same attempt (an unknown outcome resolved months on): once a post has a
  // summary, its remaining entries cannot be placed by when they were sent.
  // Either way the window's sends are incomplete, and every rate is held.
  const compacted = posts.some(
    (post) =>
      post.compactedAttempts.length > 0 &&
      (post.compactedAttempts.some(
        (span) => span.firstAt.getTime() < window.end.getTime() && span.lastAt.getTime() >= window.start.getTime(),
      ) ||
        post.attempts.some((entry) => within(entry.at, window))),
  );
  // A window retention has partly summarised has an incomplete denominator:
  // no rate or delay is drawn from what is left, at any level.
  const measure = (subset: readonly ResolvedSend[]): MarketingSendStats => {
    const stats = marketingSendStats(subset);
    return compacted
      ? { ...stats, successRate: null, latencyP50Ms: null, latencyP95Ms: null, held: ["success_rate", "latency"] }
      : stats;
  };
  const sends = measure(resolved);
  const pending = posts.filter((post) => post.status === "pending_approval");
  const approved = posts.filter((post) => post.status === "approved");
  const modes = [...new Set(resolved.map((entry) => entry.post.mode))].sort();

  const held: Array<"success_rate" | "latency" | "signups" | "sends_compacted"> = [...sends.held];
  if (compacted) held.push("sends_compacted");
  // Judged per channel: two channels of six each are two held channels, not twelve.
  if (!signupChannels || !signupChannels.some((channel) => !channel.held)) held.push("signups");

  return {
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    drafts: { created: created.length, guardCodes: tally(created.flatMap((post) => post.guardCodes)) },
    decisions: input.decisions,
    // By when the post went out, as the stored weekly KPI counts it -- apart
    // from the sends below, which are placed by when their outcome was first
    // recorded.
    publishedInWindow: posts.filter((post) => within(post.publishedAt, window)).length,
    dispatch: {
      ...sends,
      notSent,
      compacted,
      inFlight,
      byMode: modes.map((mode) => ({ mode, ...measure(resolved.filter((entry) => entry.post.mode === mode)) })),
      // Every mode and account the window sent from, each judged on its own sample.
      segments: [...new Set(resolved.map((entry) => JSON.stringify([entry.post.mode, entry.post.accountSlug])))]
        .sort()
        .map((key) => {
          const [mode, accountSlug] = JSON.parse(key) as [string, string];
          return {
            mode,
            accountSlug,
            ...measure(resolved.filter((entry) => entry.post.mode === mode && entry.post.accountSlug === accountSlug)),
          };
        }),
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
      return {
        accountSlug: channel.accountSlug,
        channel: channel.channel,
        status: channel.status,
        pauseReasonCode: channel.pauseReasonCode,
        published: posts.filter((post) => post.accountSlug === channel.accountSlug && within(post.publishedAt, window))
          .length,
        pendingApproval: mine(pending),
        approvedWaiting: mine(approved),
      };
    }),
    touches: input.touches,
    signups: input.signups,
    signupChannels,
    guestLeads: input.guestLeads,
    llm: input.llm,
    held,
  };
}

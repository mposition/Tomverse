/**
 * The weekly report's traffic and conversion funnel (owner request
 * 2026-11-09): for one Brisbane week, each account's posts published, the
 * landing touches its links brought (`marketing_touch`, the account read from
 * `utm_content`), the sign-ups attributed to those touches, and of those
 * accounts how many have since used the product and how many have paid --
 * with the rates between the steps and the change from the week before.
 *
 * Counts only, from rows the app already stores (lib/marketingWeeklyReportRead.ts
 * reads them); no new collection and no outside API. A number that could not
 * be read is null, and so is a rate with nothing to divide by: the screen
 * shows "none" for both, never a zero it did not count.
 *
 * Pure, so it is tested without a database. Imports nothing.
 */

/** Attributed sign-ups below which a row's conversion rates are held (docs/policy/marketing-automation.md §10.3). */
export const MARKETING_FUNNEL_MIN_SIGNUPS = 10;

/** One account's (or the unmatched remainder's) counted rows for a window. */
export type MarketingFunnelCounts = {
  /** Posts that went out in the window, by `publishedAt`, per account slug. */
  readonly published: ReadonlyArray<{ readonly accountSlug: string; readonly count: number }> | null;
  /** Touches in the window, by the `utm_content` they carried (null when none). */
  readonly touches: ReadonlyArray<{ readonly account: string | null; readonly count: number }> | null;
  /**
   * Attributed sign-ups in the window, by their touch's `utm_content`; of
   * those accounts, how many have a conversation and how many a paid
   * transaction now.
   */
  readonly signups: ReadonlyArray<{
    readonly account: string | null;
    readonly signups: number;
    readonly firstUse: number;
    readonly paid: number;
  }> | null;
};

export type MarketingFunnelStep = {
  readonly published: number | null;
  readonly touches: number | null;
  readonly signups: number | null;
  readonly firstUse: number | null;
  readonly paid: number | null;
  /** touches ÷ published; null when nothing was published or either is unread. */
  readonly touchesPerPost: number | null;
  /** signups ÷ touches. */
  readonly signupRate: number | null;
  /** firstUse ÷ signups. */
  readonly firstUseRate: number | null;
  /** paid ÷ signups. */
  readonly paidRate: number | null;
};

export type MarketingFunnelRow = MarketingFunnelStep & {
  /** An account slug, `*` for the whole week, or `other` for touches no account's link carried. */
  readonly key: string;
  /** Fewer than ten attributed sign-ups: no decision rests on its rates (docs/policy/marketing-automation.md §10.3). */
  readonly held: boolean;
  /** The same row in the week before; null when that week cannot be read whole. */
  readonly previous: MarketingFunnelStep | null;
  /** This week minus the week before; null where either side is. Rates in percentage points. */
  readonly change: {
    readonly published: number | null;
    readonly touches: number | null;
    readonly signups: number | null;
    readonly signupRatePoints: number | null;
    readonly paid: number | null;
  };
};

export type MarketingFunnel = {
  /** `*` first, then each account, then `other` when it has anything. */
  readonly rows: readonly MarketingFunnelRow[];
  /** Whether the week before could be read whole (it is inside the readable horizon). */
  readonly previousAvailable: boolean;
  /** The sources that failed to read this week; their cells are null. */
  readonly unread: ReadonlyArray<"published" | "touches" | "signups">;
};

export const MARKETING_FUNNEL_TOTAL_KEY = "*";
export const MARKETING_FUNNEL_OTHER_KEY = "other";

const ratio = (top: number | null, bottom: number | null): number | null =>
  top === null || bottom === null || bottom === 0 ? null : top / bottom;

const minus = (now: number | null, before: number | null | undefined): number | null =>
  now === null || before === null || before === undefined ? null : now - before;

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** The rows of one window, keyed as the funnel shows them. */
function stepsOf(counts: MarketingFunnelCounts, accounts: readonly string[]): Map<string, MarketingFunnelStep> {
  const known = new Set(accounts);
  const bucket = (account: string | null) =>
    account !== null && known.has(account) ? account : MARKETING_FUNNEL_OTHER_KEY;
  const pick = <T extends { readonly count: number }>(
    rows: ReadonlyArray<T> | null,
    key: (row: T) => string,
    wanted: string,
  ): number | null =>
    rows === null
      ? null
      : wanted === MARKETING_FUNNEL_TOTAL_KEY
        ? sum(rows.map((row) => row.count))
        : sum(rows.filter((row) => key(row) === wanted).map((row) => row.count));
  const pickSignups = (field: "signups" | "firstUse" | "paid", wanted: string): number | null =>
    counts.signups === null
      ? null
      : sum(
          counts.signups
            .filter((row) => wanted === MARKETING_FUNNEL_TOTAL_KEY || bucket(row.account) === wanted)
            .map((row) => row[field]),
        );

  const steps = new Map<string, MarketingFunnelStep>();
  for (const key of [MARKETING_FUNNEL_TOTAL_KEY, ...accounts, MARKETING_FUNNEL_OTHER_KEY]) {
    // Nothing is published from `other`: touches without an account's link.
    const published =
      key === MARKETING_FUNNEL_OTHER_KEY ? null : pick(counts.published, (row) => row.accountSlug, key);
    const touches = pick(counts.touches, (row) => bucket(row.account), key);
    const signups = pickSignups("signups", key);
    const firstUse = pickSignups("firstUse", key);
    const paid = pickSignups("paid", key);
    steps.set(key, {
      published,
      touches,
      signups,
      firstUse,
      paid,
      touchesPerPost: ratio(touches, published),
      signupRate: ratio(signups, touches),
      firstUseRate: ratio(firstUse, signups),
      paidRate: ratio(paid, signups),
    });
  }
  return steps;
}

/**
 * The funnel of one week against the week before. `accounts` is every
 * account slug the channel table holds, in the order the report lists them;
 * an account with nothing this week still has a row (its zeros were counted).
 * `previous` is null when the week before is past what can be read whole.
 */
export function summarizeMarketingFunnel(input: {
  readonly accounts: readonly string[];
  readonly current: MarketingFunnelCounts;
  readonly previous: MarketingFunnelCounts | null;
}): MarketingFunnel {
  const current = stepsOf(input.current, input.accounts);
  const previous = input.previous ? stepsOf(input.previous, input.accounts) : null;
  const rows: MarketingFunnelRow[] = [];
  for (const [key, step] of current) {
    const before = previous?.get(key) ?? null;
    if (
      key === MARKETING_FUNNEL_OTHER_KEY &&
      !step.touches &&
      !step.signups &&
      !before?.touches &&
      !before?.signups
    ) {
      continue;
    }
    const points =
      step.signupRate === null || before?.signupRate === null || before?.signupRate === undefined
        ? null
        : (step.signupRate - before.signupRate) * 100;
    rows.push({
      key,
      ...step,
      held: step.signups === null || step.signups < MARKETING_FUNNEL_MIN_SIGNUPS,
      previous: before,
      change: {
        published: minus(step.published, before?.published),
        touches: minus(step.touches, before?.touches),
        signups: minus(step.signups, before?.signups),
        signupRatePoints: points,
        paid: minus(step.paid, before?.paid),
      },
    });
  }
  const unread: Array<"published" | "touches" | "signups"> = [];
  if (input.current.published === null) unread.push("published");
  if (input.current.touches === null) unread.push("touches");
  if (input.current.signups === null) unread.push("signups");
  return { rows, previousAvailable: input.previous !== null, unread };
}

/** The experiment arms a week shows: counted since the experiment began, not per week. */
export type MarketingWeeklyExperimentArm = {
  readonly arm: string;
  readonly exposures: number;
  readonly conversions: number;
  /** conversions ÷ exposures; null with no exposure. */
  readonly rate: number | null;
};

export type MarketingWeeklyExperiment = {
  readonly experimentId: string;
  readonly bundleId: string | null;
  readonly startsAt: string;
  /** When it stopped, or its planned end. */
  readonly endsAt: string;
  /** `running`, `stopped`, or `result` for one read from a stored result. */
  readonly status: string;
  readonly arms: readonly MarketingWeeklyExperimentArm[];
};

const armOf = (arm: string, exposures: number, conversions: number): MarketingWeeklyExperimentArm => ({
  arm,
  exposures,
  conversions,
  rate: ratio(conversions, exposures),
});

/** Whether a span overlaps the window `[start, end)`. */
export const marketingSpanOverlaps = (spanStart: string, spanEnd: string, start: Date, end: Date): boolean => {
  const from = Date.parse(spanStart);
  const to = Date.parse(spanEnd);
  return Number.isFinite(from) && Number.isFinite(to) && from < end.getTime() && to >= start.getTime();
};

/**
 * The landing experiments a week shows: the stored experiment when its span
 * overlaps the week (its counters run from its start; there is no weekly
 * counter), and every experiment result recorded in the week, one entry per
 * experiment with its arms. A result for the stored experiment replaces the
 * live counters: they are the same counts, frozen at the stop.
 */
export function marketingWeeklyExperiments(input: {
  readonly window: { readonly start: Date; readonly end: Date };
  readonly stored: {
    readonly experimentId: string;
    readonly bundleId: string;
    readonly variantId: string;
    readonly status: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly stoppedAt: string | null;
    readonly counts: {
      readonly controlExposures: number;
      readonly controlConversions: number;
      readonly variantExposures: number;
      readonly variantConversions: number;
    };
  } | null;
  readonly results: ReadonlyArray<unknown>;
}): MarketingWeeklyExperiment[] {
  const byExperiment = new Map<string, MarketingWeeklyExperiment>();
  for (const raw of input.results) {
    const value = (raw ?? {}) as Record<string, unknown>;
    const { experimentId, variantId, startedAt, endedAt, exposures, conversions } = value;
    if (
      typeof experimentId !== "string" ||
      typeof variantId !== "string" ||
      typeof startedAt !== "string" ||
      typeof endedAt !== "string" ||
      typeof exposures !== "number" ||
      typeof conversions !== "number"
    ) {
      continue;
    }
    const existing = byExperiment.get(experimentId);
    const arm = armOf(variantId, exposures, conversions);
    byExperiment.set(experimentId, {
      experimentId,
      bundleId: existing?.bundleId ?? null,
      startsAt: startedAt,
      endsAt: endedAt,
      status: "result",
      arms: [...(existing?.arms ?? []), arm].sort((left, right) => (left.arm < right.arm ? -1 : 1)),
    });
  }
  const stored = input.stored;
  if (stored && !byExperiment.has(stored.experimentId)) {
    const endsAt = stored.stoppedAt ?? stored.endsAt;
    if (marketingSpanOverlaps(stored.startsAt, endsAt, input.window.start, input.window.end)) {
      byExperiment.set(stored.experimentId, {
        experimentId: stored.experimentId,
        bundleId: stored.bundleId,
        startsAt: stored.startsAt,
        endsAt,
        status: stored.status,
        arms: [
          armOf("control", stored.counts.controlExposures, stored.counts.controlConversions),
          armOf(stored.variantId, stored.counts.variantExposures, stored.counts.variantConversions),
        ],
      });
    }
  } else if (stored && byExperiment.has(stored.experimentId)) {
    const entry = byExperiment.get(stored.experimentId)!;
    byExperiment.set(stored.experimentId, { ...entry, bundleId: stored.bundleId });
  }
  return [...byExperiment.values()];
}

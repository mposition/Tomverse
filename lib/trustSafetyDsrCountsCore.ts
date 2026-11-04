/**
 * Counting DSR deadlines for the trust-safety compliance agent's stage 1
 * (docs/policy/trust-safety-compliance-agent.md §1-1, §14).
 *
 * Pure: no I/O, no clock of its own, no database. The caller passes the rows it
 * read through the policy's seven-field select allowlist, the instant to judge
 * against, and the imminence window in days.
 *
 * **The window is an input, not a constant here.** §12 (1)'s approved tables do
 * not state an imminence threshold, so this module cannot invent one: a number
 * written here would look like an approved figure to the next reader. Taking it
 * as an argument lets the counting be built and tested now and lets the operator
 * supply the day count once, where it is recorded.
 *
 * What this module must never grow (§13-1, attestation 금지): a synthesised
 * score, an overall pass field, a compliance verdict, or any sentence about
 * whether the counts are acceptable. It returns counts, and the number of days
 * by which the latest late closure overran. Those are facts; "compliant" is not
 * one this agent is allowed to produce.
 */

/** The seven fields §1-1 allows the observer to read, and nothing else. */
export type DsrObservationRow = {
  readonly id: string;
  readonly requestType: string;
  readonly status: string;
  readonly dueAt: Date;
  readonly legalHold: boolean;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
};

/**
 * One bucket's size, with legal hold as its own dimension.
 *
 * `legalHold` counts a subset of `total`; it is never subtracted from it. §1-1
 * says legal hold does not leave the denominator, because a request held for a
 * legal reason is still a request whose deadline passed, and a count that hides
 * it would answer a question nobody asked.
 */
export type DsrBucket = {
  readonly total: number;
  readonly legalHold: number;
};

export type DsrDeadlineCounts = {
  /** Every row the caller passed. The denominator. */
  readonly observed: DsrBucket;
  /** Not completed, and `dueAt` is at or before the judging instant. */
  readonly overdue: DsrBucket;
  /** Not completed, `dueAt` is after the instant and within the window. */
  readonly imminent: DsrBucket;
  /** Completed, and completed after `dueAt` (§14's "기한을 넘긴 채 종결된 건수"). */
  readonly closedLate: DsrBucket;
  /**
   * Whole days by which the worst late closure overran, or `null` when
   * `closedLate.total` is zero.
   *
   * Null rather than zero: no late closure and a closure that overran by less
   * than a day are different facts, and §14 reads this to decide whether a
   * product feature is needed ("하루 이내에 그치면 … 여러 날에 걸치면"). A zero
   * would make the first case indistinguishable from the second's floor.
   */
  readonly worstLateClosureDays: number | null;
  /** The window the caller supplied, echoed so a reader can see what "imminent" meant. */
  readonly imminentWithinDays: number;
};

const MS_PER_DAY = 86_400_000;

const emptyBucket = (): { total: number; legalHold: number } => ({ total: 0, legalHold: 0 });

const add = (bucket: { total: number; legalHold: number }, row: DsrObservationRow): void => {
  bucket.total += 1;
  if (row.legalHold) bucket.legalHold += 1;
};

/**
 * Counts the rows.
 *
 * `status` is deliberately not read. §1-1 says the counting is "`status`와
 * 무관하게", and the row's own `completedAt` is what says whether it finished:
 * a status string is a label someone set, while `completedAt` is the event.
 * Reading both would give two answers to one question.
 */
export const countDsrDeadlines = ({
  rows,
  now,
  imminentWithinDays,
}: {
  readonly rows: readonly DsrObservationRow[];
  readonly now: Date;
  readonly imminentWithinDays: number;
}): DsrDeadlineCounts => {
  if (!Number.isInteger(imminentWithinDays) || imminentWithinDays < 0) {
    throw new TypeError(
      `imminentWithinDays must be a whole number of days, not ${String(imminentWithinDays)}.`,
    );
  }
  const instant = now.getTime();
  if (!Number.isFinite(instant)) {
    throw new TypeError("now must be a valid Date.");
  }
  const windowEnd = instant + imminentWithinDays * MS_PER_DAY;

  const observed = emptyBucket();
  const overdue = emptyBucket();
  const imminent = emptyBucket();
  const closedLate = emptyBucket();
  let worstLateMs: number | null = null;

  for (const row of rows) {
    // An unreadable date fails every comparison below, so the row would land
    // in `observed` and in none of the buckets -- an overdue request could
    // disappear from `overdue` with nothing saying so. Refusing is the only
    // answer that cannot under-report.
    const due = row.dueAt.getTime();
    if (!Number.isFinite(due)) {
      throw new TypeError(`Request ${row.id} has an unreadable dueAt.`);
    }
    if (row.completedAt !== null && !Number.isFinite(row.completedAt.getTime())) {
      throw new TypeError(`Request ${row.id} has an unreadable completedAt.`);
    }
    add(observed, row);
    if (row.completedAt === null) {
      if (due <= instant) add(overdue, row);
      else if (due <= windowEnd) add(imminent, row);
      continue;
    }
    const completed = row.completedAt.getTime();
    if (completed > due) {
      add(closedLate, row);
      const overran = completed - due;
      if (worstLateMs === null || overran > worstLateMs) worstLateMs = overran;
    }
  }

  return {
    observed,
    overdue,
    imminent,
    closedLate,
    // Whole days, rounded down: "overran by 1 day" must not be produced by
    // something that overran by an hour.
    worstLateClosureDays: worstLateMs === null ? null : Math.floor(worstLateMs / MS_PER_DAY),
    imminentWithinDays,
  };
};

/**
 * The Overview health score, and the arithmetic behind it.
 *
 * Moved out of `lib/adminEnvironmentChecks.ts` and given a breakdown, because a
 * single number an operator cannot take apart is a number they cannot act on.
 * The weights are the ones the console has always used; what is new is that the
 * function says what it did with them, and that it can say "I do not know"
 * instead of counting a failed read as zero.
 *
 * ## Two changes of substance
 *
 * **Only blocking environment rows count.** The input used to be every
 * unconfigured variable, which made an optional Discord webhook cost more than
 * a provider in a limited state and drove correctly-configured deployments
 * toward zero. `blockingEnvCount` is the `required` rows only
 * (`blockingEnvChecks()`); conditional, recommended and optional rows are
 * listed on screen and priced at nothing.
 *
 * **A missing input is not a zero.** Every count is `number | null`. Null means
 * the read failed, and a failed read must not silently improve the score --
 * the same rule `lib/adminNavigationCounts.ts` states for badges ("zero is a
 * claim and an unknown count is not"). A null contributes no deduction and
 * sets `incomplete`, so the screen can say the score is a floor rather than a
 * figure.
 */

/** What each kind of finding costs. One place, so the drill-down cannot drift. */
export const ADMIN_HEALTH_WEIGHTS = {
  outage: 18,
  limited: 8,
  blockingEnv: 10,
  alertFailure: 4,
  pendingRefund: 3,
  openFeedback: 2,
} as const;

export type AdminHealthFactor = keyof typeof ADMIN_HEALTH_WEIGHTS;

/**
 * Order is the order the drill-down renders in: dearest first, so the line an
 * operator should read is the top one.
 */
export const ADMIN_HEALTH_FACTOR_ORDER: readonly AdminHealthFactor[] = [
  "outage",
  "blockingEnv",
  "limited",
  "alertFailure",
  "pendingRefund",
  "openFeedback",
];

export type AdminHealthInput = {
  outageCount: number | null;
  limitedCount: number | null;
  blockingEnvCount: number | null;
  alertFailureCount: number | null;
  pendingRefundCount: number | null;
  openFeedbackCount: number | null;
};

export type AdminHealthLine = {
  factor: AdminHealthFactor;
  /** Null when the read that produces it failed. */
  count: number | null;
  weight: number;
  /** Zero for an unknown count -- an unreadable input buys no deduction. */
  deduction: number;
  known: boolean;
};

export type AdminHealthBreakdown = {
  lines: AdminHealthLine[];
  /** What the deductions add up to before the floor. */
  totalDeduction: number;
  score: number;
  /**
   * True when deductions exceeded 100 and the score stopped at zero. Worth
   * saying out loud: past this point a new outage moves nothing, so the number
   * is at its least informative exactly when the most is wrong.
   */
  floored: boolean;
  /** True when any input could not be read, so the score is a ceiling. */
  incomplete: boolean;
  /** The factors whose reads failed, for a screen that has to name them. */
  unknownFactors: AdminHealthFactor[];
};

const countFor = (input: AdminHealthInput, factor: AdminHealthFactor) => {
  switch (factor) {
    case "outage":
      return input.outageCount;
    case "limited":
      return input.limitedCount;
    case "blockingEnv":
      return input.blockingEnvCount;
    case "alertFailure":
      return input.alertFailureCount;
    case "pendingRefund":
      return input.pendingRefundCount;
    case "openFeedback":
      return input.openFeedbackCount;
  }
};

export const adminHealthBreakdown = (
  input: AdminHealthInput
): AdminHealthBreakdown => {
  const lines: AdminHealthLine[] = ADMIN_HEALTH_FACTOR_ORDER.map((factor) => {
    const raw = countFor(input, factor);
    const known = typeof raw === "number" && Number.isFinite(raw);
    const count = known ? Math.max(0, Math.trunc(raw as number)) : null;
    const weight = ADMIN_HEALTH_WEIGHTS[factor];
    return {
      factor,
      count,
      weight,
      deduction: count === null ? 0 : count * weight,
      known,
    };
  });

  const totalDeduction = lines.reduce((sum, line) => sum + line.deduction, 0);
  const unknownFactors = lines
    .filter((line) => !line.known)
    .map((line) => line.factor);

  return {
    lines,
    totalDeduction,
    score: Math.max(0, Math.min(100, 100 - totalDeduction)),
    floored: totalDeduction > 100,
    incomplete: unknownFactors.length > 0,
    unknownFactors,
  };
};

/**
 * A single 0-100 readiness reading.
 *
 * Derived from the breakdown rather than computed beside it, so the number on
 * the Overview card and the arithmetic on the drill-down cannot disagree.
 */
export const adminHealthScore = (input: AdminHealthInput) =>
  adminHealthBreakdown(input).score;

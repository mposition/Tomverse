/**
 * How many seconds of audio this whole deployment may send a provider in a
 * day and in a month.
 *
 * Contract: docs/policy/voice-input.md §6.1-4.
 *
 * ## Why seconds and not dollars
 *
 * Every other provider budget in this repository is denominated in microUSD.
 * This one is not, and the reason is the whole of it: **there is no approved
 * USD conversion for audio.** The token prices are list prices but the token
 * count is unknowable before the call; the per-minute figure is what the
 * provider's own table calls an "Estimated cost". Converting at reservation
 * time would mean inventing a rate nobody approved, which is the one thing
 * AGENTS.md names outright.
 *
 * So the budget is set in the unit this product can actually measure -- the
 * same seconds `measured_clip` reads and the same seconds the per-subject
 * guardrail counts. A USD form can be *added* once B-3's paid verification
 * produces a verified rate; it is not being guessed at now.
 *
 * ## Why this is not the guardrail in `lib/voiceInputGuardrails.ts`
 *
 * That one is per subject: one person's day. This one is the deployment's day
 * and month, across everybody. A per-subject limit cannot bound total spend --
 * the total is "limit x however many people show up" -- which is exactly the
 * split chat already has between a plan guardrail and a provider budget.
 *
 * ## Why there is no default in production
 *
 * A default here would be a number nobody chose standing between this product
 * and an unbounded third-party bill. Outside production a default keeps
 * development working; in production its absence is a misconfiguration and
 * `/api/ready` says so (`lib/voiceProviderBudgetReadiness.ts`).
 */

export type VoiceProviderBudgetLimits = {
  secondsPerDay: number;
  secondsPerMonth: number;
};

export type VoiceProviderBudgetProblem = {
  envName: string;
  code: "missing" | "not_a_positive_integer" | "month_below_day";
  detail: string;
};

export type ResolvedVoiceProviderBudget = {
  /** Null when production is missing a value, or a value cannot be used. */
  limits: VoiceProviderBudgetLimits | null;
  problems: VoiceProviderBudgetProblem[];
};

export const VOICE_PROVIDER_BUDGET_ENV_NAMES = {
  day: "VOICE_PROVIDER_SECONDS_PER_DAY",
  month: "VOICE_PROVIDER_SECONDS_PER_MONTH",
} as const;

/**
 * Development-only fallbacks. Deliberately small: a developer who never sets
 * these should notice the ceiling rather than discover it on an invoice.
 */
export const VOICE_PROVIDER_BUDGET_DEV_DEFAULTS: VoiceProviderBudgetLimits = {
  secondsPerDay: 1_800,
  secondsPerMonth: 18_000,
};

/** The bucket period names. Never `cost-*` or `op-cost-*` -- see §7. */
export const VOICE_PROVIDER_BUDGET_PERIODS = {
  day: "voice-provider-seconds-day",
  month: "voice-provider-seconds-month",
} as const;

const readSeconds = (
  env: Record<string, string | undefined>,
  envName: string,
  problems: VoiceProviderBudgetProblem[]
): number | null => {
  const raw = env[envName];
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    problems.push({
      envName,
      code: "not_a_positive_integer",
      detail:
        "a budget of zero refuses every request as if the provider were down; turning the feature off is the kill switch's job",
    });
    return null;
  }
  return parsed;
};

export const resolveVoiceProviderBudget = (
  env: Record<string, string | undefined>,
  options: { production: boolean }
): ResolvedVoiceProviderBudget => {
  const problems: VoiceProviderBudgetProblem[] = [];
  const day = readSeconds(env, VOICE_PROVIDER_BUDGET_ENV_NAMES.day, problems);
  const month = readSeconds(env, VOICE_PROVIDER_BUDGET_ENV_NAMES.month, problems);

  if (options.production) {
    for (const [envName, value] of [
      [VOICE_PROVIDER_BUDGET_ENV_NAMES.day, day],
      [VOICE_PROVIDER_BUDGET_ENV_NAMES.month, month],
    ] as const) {
      if (value === null && !problems.some((p) => p.envName === envName)) {
        problems.push({
          envName,
          code: "missing",
          detail: "production has no default for this; it must be set explicitly",
        });
      }
    }
    if (day === null || month === null) return { limits: null, problems };
  }

  const limits: VoiceProviderBudgetLimits = {
    secondsPerDay: day ?? VOICE_PROVIDER_BUDGET_DEV_DEFAULTS.secondsPerDay,
    secondsPerMonth: month ?? VOICE_PROVIDER_BUDGET_DEV_DEFAULTS.secondsPerMonth,
  };

  // A month below a day is not a stricter budget, it is a typo that makes the
  // daily limit unreachable. Reported rather than silently reordered: the
  // operator has to know which of the two numbers they meant.
  if (limits.secondsPerMonth < limits.secondsPerDay) {
    problems.push({
      envName: VOICE_PROVIDER_BUDGET_ENV_NAMES.month,
      code: "month_below_day",
      detail: "the monthly budget is smaller than the daily one",
    });
    if (options.production) return { limits: null, problems };
  }

  return { limits, problems };
};

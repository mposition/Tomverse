/**
 * The operational guardrail for voice input.
 *
 * Contract: docs/policy/voice-input.md §7, and
 * docs/policy/credit-and-cost-limits.md §2 for the layering it must not break.
 *
 * ## This is not an entitlement
 *
 * AGENTS.md, "Credit entitlement vs operational guardrail": a user's
 * entitlement is credits, and an operational guardrail is a separate layer
 * that exists to stop a provider bill running away. The two must not share
 * names, error codes, buckets or metrics, because the moment they do, a
 * spending cap starts reading as a product limit and somebody "fixes" it by
 * raising the wrong number.
 *
 * Voice input keeps that separation and adds a third fact: while
 * docs/policy/voice-input.md §6 is open, voice input has **no** entitlement
 * layer at all. It deducts nothing, refunds nothing and reserves nothing, so
 * everything in this file is guardrail — which is exactly why it is in its own
 * module with its own vocabulary rather than a few extra constants in
 * `lib/chatCostGuardrails.ts`.
 *
 * The distinct vocabulary, in full:
 *
 *   * environment variables `VOICE_INPUT_*`, never `CHAT_*`;
 *   * bucket periods `voice-*`, never `cost-*` or `op-cost-*`;
 *   * the refusal code `VOICE_OPERATIONAL_LIMIT_REACHED`, which is neither
 *     `OPERATIONAL_COST_GUARDRAIL_TRIGGERED` nor any credit code.
 *
 * Pure and framework-free: it derives numbers from an environment object. The
 * counting itself is `lib/voiceInputBudget.ts`, which needs a database.
 */

/** The one refusal this layer produces. Not a credit code. Not a chat code. */
export const VOICE_OPERATIONAL_LIMIT_REACHED = "VOICE_OPERATIONAL_LIMIT_REACHED";

export type VoiceGuardrailLimits = {
  /** Transcription requests one account may make in a day. */
  requestsPerDay: number;
  /** Transcription requests one account may make in a minute. */
  requestsPerMinute: number;
  /**
   * Seconds of audio one account may have transcribed in a day.
   *
   * The one that actually bounds spend: the provider bills per second, so a
   * request count alone would be bounded only by the per-clip ceiling times
   * the request count, which is a much larger number than anyone intends.
   */
  secondsPerDay: number;
};

/**
 * The defaults, and the floor.
 *
 * 40 clips and 20 minutes of audio a day is far more voice than the composer
 * is for, and still a bounded bill. These are deliberately generous for a
 * feature that is off: a guardrail tuned so tightly that ordinary use trips it
 * teaches an operator to raise it without reading why it exists.
 */
export const VOICE_GUARDRAIL_DEFAULTS: VoiceGuardrailLimits = {
  requestsPerDay: 40,
  requestsPerMinute: 6,
  secondsPerDay: 20 * 60,
};

/**
 * The ceiling an environment variable may not exceed.
 *
 * `lib/chatCostGuardrails.ts` enforces the mirror image of this rule — an
 * override may not go *below* the value derived from the plan — because there
 * the derived value is a user's entitlement and lowering it would take away
 * something they paid for. Here there is no entitlement, so the risk runs the
 * other way: the only thing an override can do wrong is let the bill grow, and
 * the number it must not pass is the one an operator agreed to.
 *
 * An override above the ceiling is clamped and reported rather than refused.
 * A deployment that will not start because a budget was typed too large is an
 * outage caused by a spending limit, which is worse than the limit.
 */
export const VOICE_GUARDRAIL_CEILING: VoiceGuardrailLimits = {
  requestsPerDay: 500,
  requestsPerMinute: 30,
  secondsPerDay: 4 * 60 * 60,
};

export type VoiceGuardrailResolution = {
  limits: VoiceGuardrailLimits;
  /** Names of the overrides that were clamped, for the readiness report. */
  clamped: string[];
  /** Names of the overrides that could not be parsed and were ignored. */
  ignored: string[];
};

const ENV_NAMES: Record<keyof VoiceGuardrailLimits, string> = {
  requestsPerDay: "VOICE_INPUT_REQUESTS_PER_DAY",
  requestsPerMinute: "VOICE_INPUT_REQUESTS_PER_MINUTE",
  secondsPerDay: "VOICE_INPUT_SECONDS_PER_DAY",
};

export const resolveVoiceGuardrails = (
  env: Record<string, string | undefined>
): VoiceGuardrailResolution => {
  const limits: VoiceGuardrailLimits = { ...VOICE_GUARDRAIL_DEFAULTS };
  const clamped: string[] = [];
  const ignored: string[] = [];

  for (const key of Object.keys(ENV_NAMES) as (keyof VoiceGuardrailLimits)[]) {
    const raw = env[ENV_NAMES[key]];
    if (raw === undefined || raw.trim() === "") continue;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      // Zero is not a way to disable the feature: the kill switch is, and it
      // says so out loud. A limit of zero would refuse every request with a
      // budget message, which reads as an outage rather than a decision.
      ignored.push(ENV_NAMES[key]);
      continue;
    }
    if (parsed > VOICE_GUARDRAIL_CEILING[key]) {
      limits[key] = VOICE_GUARDRAIL_CEILING[key];
      clamped.push(ENV_NAMES[key]);
      continue;
    }
    limits[key] = parsed;
  }

  return { limits, clamped, ignored };
};

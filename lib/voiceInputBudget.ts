import "server-only";

import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import {
  VOICE_OPERATIONAL_LIMIT_REACHED,
  resolveVoiceGuardrails,
} from "@/lib/voiceInputGuardrails";
import { VOICE_CLIP_MAX_SECONDS } from "@/lib/voiceInputFormats";

/**
 * Counting the seconds of audio an account has had transcribed today.
 *
 * Contract: docs/policy/voice-input.md §7.
 *
 * ## Reserve, then settle
 *
 * The provider bills for the audio it processed, and this endpoint does not
 * know that number until the provider answers. Booking only afterwards would
 * mean a caller could hold any number of requests open at once and pass the
 * daily budget by a multiple of however many they managed to start — the same
 * failure the chat path solves by reserving before the call and settling after
 * it (docs/policy/credit-and-cost-limits.md §4).
 *
 * So the same shape here, with the honest reservation basis:
 *
 *   * the container's declared length when `lib/voiceClipDuration.ts` could
 *     read one, which for real Chromium and Firefox recordings it can;
 *   * otherwise the per-clip ceiling, because a clip that will not say how
 *     long it is has to be assumed to be as long as it is allowed to be. That
 *     is the fail-closed direction, and it is the same `conservative_default`
 *     reasoning the chat reservation uses.
 *
 * `settleVoiceSeconds` then moves the booking to what the provider actually
 * reported, so an unknown-duration clip does not permanently cost a user two
 * minutes of their daily budget for eight seconds of speech.
 *
 * ## Why this is not `lib/apiSecurity.ts`
 *
 * The request *count* is ordinary abuse protection and goes through
 * `consumeApiRateLimit` like every other endpoint's. This is the cost
 * guardrail, and AGENTS.md requires it to keep its own vocabulary: its own
 * bucket periods (`voice-*`), its own refusal code, its own environment
 * variables. A shared helper would have made them share a name sooner or
 * later, and a spending cap that reads as a rate limit gets raised by whoever
 * is annoyed by it.
 */

export class VoiceBudgetError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter?: number
  ) {
    super(message);
    this.name = "VoiceBudgetError";
  }
}

const secret = () => {
  if (!process.env.NEXTAUTH_SECRET) {
    throw new VoiceBudgetError(
      503,
      "SECURITY_NOT_CONFIGURED",
      "Voice input is not configured."
    );
  }
  return process.env.NEXTAUTH_SECRET;
};

/**
 * The bucket key.
 *
 * Hashed with the deployment secret for the same reason every other bucket
 * key is: the table is keyed by something that must not be a user identifier
 * anybody reading a row can reverse.
 */
const bucketKey = (userId: string) =>
  `voice:${createHash("sha256")
    .update(`voice-seconds:${userId}:${secret()}`)
    .digest("hex")}`;

/** `voice-*`, never `cost-*` or `op-cost-*`. See the header. */
const SECONDS_PERIOD = "voice-seconds-day";

const dayStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const secondsUntilTomorrow = (now: Date) => {
  const end = dayStart(now).getTime() + 86_400_000;
  return Math.max(1, Math.ceil((end - now.getTime()) / 1000));
};

/**
 * The reservation basis: what this clip must be assumed to cost.
 *
 * Exported and pure so the choice can be asserted directly rather than
 * inferred from a database row.
 */
export const voiceReservationSeconds = (
  declaredDurationSeconds: number | null
): number => {
  if (
    declaredDurationSeconds === null ||
    !Number.isFinite(declaredDurationSeconds) ||
    declaredDurationSeconds <= 0
  ) {
    return VOICE_CLIP_MAX_SECONDS;
  }
  // Rounded up: a fractional second still costs a second's worth of attention,
  // and rounding down would let a long run of short clips drift under budget.
  return Math.min(
    VOICE_CLIP_MAX_SECONDS,
    Math.max(1, Math.ceil(declaredDurationSeconds))
  );
};

/**
 * Books `seconds` against today's budget, or refuses.
 *
 * The conditional `WHERE` is what makes this safe without a lock: the row is
 * only updated when it still has room, so two concurrent requests cannot both
 * read the same remaining budget and both proceed.
 */
export const reserveVoiceSeconds = async (input: {
  userId: string;
  seconds: number;
  env?: Record<string, string | undefined>;
}): Promise<{ reservedSeconds: number }> => {
  const { limits } = resolveVoiceGuardrails(input.env ?? process.env);
  const now = new Date();
  const seconds = Math.max(1, Math.ceil(input.seconds));
  const key = bucketKey(input.userId);
  const start = dayStart(now);
  const limit = limits.secondsPerDay;

  if (seconds > limit) {
    // A single clip larger than the whole daily budget can never be admitted,
    // and the arithmetic below would silently answer "no room" without saying
    // that the reason is the limit itself rather than today's use.
    throw new VoiceBudgetError(
      429,
      VOICE_OPERATIONAL_LIMIT_REACHED,
      "Voice input has reached its operational limit.",
      secondsUntilTomorrow(now)
    );
  }

  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
    VALUES (${key}, ${SECONDS_PERIOD}, ${start}, ${seconds}, NOW())
    ON CONFLICT ("key", "period", "periodStart")
    DO UPDATE SET
      "count" = "ChatUsageBucket"."count" + ${seconds},
      "updatedAt" = NOW()
    WHERE "ChatUsageBucket"."count" <= ${limit - seconds}
    RETURNING "count"
  `;

  if (rows.length === 0) {
    throw new VoiceBudgetError(
      429,
      VOICE_OPERATIONAL_LIMIT_REACHED,
      "Voice input has reached its operational limit.",
      secondsUntilTomorrow(now)
    );
  }

  return { reservedSeconds: seconds };
};

/**
 * Moves a reservation to what the provider actually charged for.
 *
 * Always called, on success and on failure alike:
 *
 *   * a failed transcription settles to zero, because a provider that refused
 *     the clip did not bill for it, and leaving the reservation in place would
 *     spend a user's daily budget on our own outage;
 *   * a successful one settles to the provider's reported duration, or keeps
 *     the reservation when the provider did not report one.
 *
 * Floored at zero. A settlement can only ever give budget back — it never
 * books more than the reservation already did, so a provider reporting a
 * duration longer than the clip could possibly be cannot be used to charge
 * somebody else's budget.
 */
export const settleVoiceSeconds = async (input: {
  userId: string;
  reservedSeconds: number;
  actualSeconds: number | null;
}): Promise<void> => {
  const actual =
    input.actualSeconds === null || !Number.isFinite(input.actualSeconds)
      ? input.reservedSeconds
      : Math.max(0, Math.ceil(input.actualSeconds));
  const release = Math.max(0, input.reservedSeconds - actual);
  if (release === 0) return;

  const key = bucketKey(input.userId);
  const start = dayStart(new Date());
  await prisma.$executeRaw`
    UPDATE "ChatUsageBucket"
    SET "count" = GREATEST("count" - ${release}, 0), "updatedAt" = NOW()
    WHERE "key" = ${key}
      AND "period" = ${SECONDS_PERIOD}
      AND "periodStart" = ${start}
  `;
};

/** Gives the whole reservation back. Used when nothing was ever sent. */
export const releaseVoiceSeconds = (input: {
  userId: string;
  reservedSeconds: number;
}) =>
  settleVoiceSeconds({
    userId: input.userId,
    reservedSeconds: input.reservedSeconds,
    actualSeconds: 0,
  });

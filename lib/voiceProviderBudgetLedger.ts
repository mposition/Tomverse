import "server-only";

import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import {
  VOICE_OPERATIONAL_LIMIT_REACHED,
  voiceSettlementRelease,
  type VoiceSettlementBasis,
} from "@/lib/voiceInputGuardrails";
import { VoiceBudgetError } from "@/lib/voiceInputBudget";
import {
  resolveVoiceProviderBudget,
  VOICE_PROVIDER_BUDGET_PERIODS,
} from "@/lib/voiceProviderBudget";

/**
 * The deployment's own audio budget, booked before the provider is called.
 *
 * Contract: docs/policy/voice-input.md §6.1-4.
 *
 * ## This bounds exposure, not money
 *
 * It is denominated in seconds because no approved USD conversion for audio
 * exists (§6.1.1). So it is a *usage* budget: it bounds how much audio this
 * deployment can send, which bounds spend only as far as the relationship
 * between seconds and dollars is stable, and this file does not claim to know
 * that relationship. A USD layer belongs on top of a verified rate, after
 * B-3's paid verification — not derived here.
 *
 * ## Why a second layer at all
 *
 * `lib/voiceInputBudget.ts` bounds one subject's day. That cannot bound the
 * total: the total is that limit times however many subjects arrive. This one
 * is the whole deployment's day and month, which is the same split chat draws
 * between a plan guardrail and a provider budget.
 *
 * ## Reserve before the call, settle on every exit
 *
 * Booking afterwards would let any number of concurrent requests read the same
 * remaining budget and all proceed. The conditional `WHERE` is what makes the
 * booking atomic across instances without a lock — the row is only updated
 * while it still has room, so two processes cannot both win it.
 *
 * Two buckets have to move together, and they cannot in one statement. The day
 * is booked first; if the month refuses, the day is given back before the
 * caller ever sees the refusal. A compensating release rather than a
 * transaction because the two rows are independent and the failure direction
 * that matters — booked but not released — is the one this ordering removes.
 */

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
 * One key for the whole deployment. Hashed for the same reason every other
 * bucket key is, even though this one names nobody: the table has one shape.
 */
const providerKey = () =>
  `voice:${createHash("sha256")
    .update(`voice-provider-seconds:${secret()}`)
    .digest("hex")}`;

const dayStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const monthStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const secondsUntilTomorrow = (now: Date) =>
  Math.max(1, Math.ceil((dayStart(now).getTime() + 86_400_000 - now.getTime()) / 1000));

/** One booking in one bucket. `periodStart` travels so settlement cannot drift. */
type ProviderBooking = {
  period: string;
  periodStart: Date;
  seconds: number;
};

export type VoiceProviderReservation = {
  bookings: ProviderBooking[];
  reservedSeconds: number;
  settled: boolean;
};

const book = async (input: {
  key: string;
  period: string;
  periodStart: Date;
  seconds: number;
  limit: number;
}): Promise<boolean> => {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
    VALUES (${input.key}, ${input.period}, ${input.periodStart}, ${input.seconds}, NOW())
    ON CONFLICT ("key", "period", "periodStart")
    DO UPDATE SET
      "count" = "ChatUsageBucket"."count" + ${input.seconds},
      "updatedAt" = NOW()
    WHERE "ChatUsageBucket"."count" <= ${input.limit - input.seconds}
    RETURNING "count"
  `;
  return rows.length > 0;
};

const unbook = async (key: string, booking: ProviderBooking) => {
  await prisma.$executeRaw`
    UPDATE "ChatUsageBucket"
    SET "count" = GREATEST("count" - ${booking.seconds}, 0), "updatedAt" = NOW()
    WHERE "key" = ${key}
      AND "period" = ${booking.period}
      AND "periodStart" = ${booking.periodStart}
  `;
};

export const reserveVoiceProviderSeconds = async (input: {
  seconds: number;
  env?: Record<string, string | undefined>;
  now?: Date;
}): Promise<VoiceProviderReservation> => {
  const env = input.env ?? process.env;
  const { limits } = resolveVoiceProviderBudget(env, {
    production: env.NODE_ENV === "production",
  });
  const now = input.now ?? new Date();
  const seconds = Math.max(1, Math.ceil(input.seconds));

  if (!limits) {
    // Production with no usable budget. /api/ready already refuses, but a
    // request that arrives anyway must not proceed unbounded -- an
    // unconfigured cap is not an absent cap.
    throw new VoiceBudgetError(
      503,
      VOICE_OPERATIONAL_LIMIT_REACHED,
      "Voice input is not configured."
    );
  }

  if (
    seconds > limits.secondsPerDay ||
    seconds > limits.secondsPerMonth
  ) {
    throw new VoiceBudgetError(
      429,
      VOICE_OPERATIONAL_LIMIT_REACHED,
      "Voice input has reached its operational limit.",
      secondsUntilTomorrow(now)
    );
  }

  const key = providerKey();
  const day: ProviderBooking = {
    period: VOICE_PROVIDER_BUDGET_PERIODS.day,
    periodStart: dayStart(now),
    seconds,
  };
  const month: ProviderBooking = {
    period: VOICE_PROVIDER_BUDGET_PERIODS.month,
    periodStart: monthStart(now),
    seconds,
  };

  const dayBooked = await book({ key, ...day, limit: limits.secondsPerDay });
  if (!dayBooked) {
    throw new VoiceBudgetError(
      429,
      VOICE_OPERATIONAL_LIMIT_REACHED,
      "Voice input has reached its operational limit.",
      secondsUntilTomorrow(now)
    );
  }

  const monthBooked = await book({
    key,
    ...month,
    limit: limits.secondsPerMonth,
  });
  if (!monthBooked) {
    // The day was booked and the month refused. Give the day back before the
    // caller sees the refusal, or a month-capped deployment burns its daily
    // budget on requests that never ran.
    await unbook(key, day).catch(() => undefined);
    throw new VoiceBudgetError(
      429,
      VOICE_OPERATIONAL_LIMIT_REACHED,
      "Voice input has reached its operational limit.",
      secondsUntilTomorrow(now)
    );
  }

  return { bookings: [day, month], reservedSeconds: seconds, settled: false };
};

/**
 * Closes the deployment's booking on the same basis as the subject's.
 *
 * Idempotent through the handle, for the reason the subject reservation is:
 * a duplicate callback, or a `catch` running after a `finally`, must not give
 * budget back twice.
 */
export const settleVoiceProviderSeconds = async (input: {
  reservation: VoiceProviderReservation;
  basis: VoiceSettlementBasis;
}): Promise<{ releasedSeconds: number }> => {
  const { reservation } = input;
  if (reservation.settled) return { releasedSeconds: 0 };
  reservation.settled = true;

  const release = voiceSettlementRelease({
    reservedSeconds: reservation.reservedSeconds,
    basis: input.basis,
  });
  if (release === 0) return { releasedSeconds: 0 };

  const key = providerKey();
  for (const booking of reservation.bookings) {
    await unbook(key, { ...booking, seconds: release });
  }
  return { releasedSeconds: release };
};

import type { ReadoutLimits } from "@/lib/chatReadoutAccess";

/**
 * Reserve, call, settle -- the server read-aloud's spending guardrail.
 *
 * Contract: docs/policy/voice-input.md §6.4, the same mechanism as voice
 * input's seconds budget (§6.1-4, §7): an account's day, and the whole
 * deployment's day and month, each booked *before* the provider is called with
 * a conditional upsert, so concurrent requests cannot read the same remaining
 * room and all proceed.
 *
 * The unit is characters, the one quantity known exactly before the call. The
 * provider bills tokens (text in, audio out) and no approved conversion from
 * characters to either exists, so like the voice seconds budget this bounds
 * exposure -- how much text leaves this deployment -- not dollars.
 *
 * Pure: the store is injected. lib/chatReadoutBudget.ts is the database one.
 */

/** `readout-*`, never `cost-*`, `op-cost-*` or the voice periods. */
export const READOUT_BUDGET_PERIODS = {
  accountDay: "readout-account-chars-day",
  providerDay: "readout-provider-chars-day",
  providerMonth: "readout-provider-chars-month",
} as const;

export type ReadoutBooking = {
  key: string;
  period: string;
  /** Carried so settlement updates the bucket it booked, not today's. */
  periodStart: Date;
  characters: number;
};

export type ReadoutBudgetStore = {
  /** Adds `characters` unless that would pass `limit`; true when booked. */
  book(booking: ReadoutBooking & { limit: number }): Promise<boolean>;
  unbook(booking: ReadoutBooking): Promise<void>;
};

export type ReadoutReservation = {
  bookings: ReadoutBooking[];
  characters: number;
  /** Single use: a second settle books nothing. */
  settled: boolean;
};

export type ReadoutBudgetBucket = "account_day" | "provider_day" | "provider_month";

export class ReadoutBudgetError extends Error {
  constructor(
    public readonly bucket: ReadoutBudgetBucket,
    /** Seconds until the refusing bucket opens again. */
    public readonly retryAfterSeconds: number
  ) {
    super(`Read-aloud operational limit reached (${bucket}).`);
    this.name = "ReadoutBudgetError";
  }
}

/**
 * What happened to one provider request, and so what its booking becomes.
 *
 *   billed         the provider answered with audio: keep the booking.
 *   indeterminate  sent, outcome unknown (timeout, dropped connection, 5xx,
 *                  unreadable body): keep the booking. The provider may have
 *                  billed it, and the request is never retried.
 *   refused        the provider answered with a refusal (4xx, 429): release.
 *   not_sent       nothing was sent: release.
 */
export type ReadoutDisposition = "billed" | "indeterminate" | "refused" | "not_sent";

export const readoutKeepsReservation = (disposition: ReadoutDisposition) =>
  disposition === "billed" || disposition === "indeterminate";

/**
 * One request per piece at a time, decided by the server and not by the
 * browser: an account's piece `n` of an answer is leased before it is
 * reserved, and a second request while the lease is held is refused
 * (`READOUT_IN_PROGRESS`) without reaching the budget or the provider.
 *
 * The lease is released when the outcome is known (billed, refused, not sent)
 * and **kept** when it is not: a piece whose paid call may have been billed is
 * not bought a second time until the lease lapses. The lapse is what clears a
 * lease a crashed process never released; it is far longer than the provider
 * timeout, so a live request is never overtaken.
 */
export const READOUT_PIECE_LEASE_SECONDS = 300;

export const readoutKeepsLease = (disposition: ReadoutDisposition) => disposition === "indeterminate";

export type ReadoutLeaseStore = {
  /** True when this request now holds the lease. */
  acquire(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
};

export const readoutDayStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
export const readoutMonthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const secondsUntil = (now: Date, boundary: Date) =>
  Math.max(1, Math.ceil((boundary.getTime() - now.getTime()) / 1000));
const untilTomorrow = (now: Date) => secondsUntil(now, new Date(readoutDayStart(now).getTime() + 86_400_000));
const untilNextMonth = (now: Date) =>
  secondsUntil(now, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));

export async function reserveReadoutCharacters(input: {
  store: ReadoutBudgetStore;
  accountKey: string;
  providerKey: string;
  characters: number;
  limits: ReadoutLimits;
  now?: Date;
}): Promise<ReadoutReservation> {
  const now = input.now ?? new Date();
  const characters = Math.max(1, Math.ceil(input.characters));
  // The account first: refusing one person for their own use is the more
  // specific answer and does not consume the shared budget to say so.
  const plan: Array<{ bucket: ReadoutBudgetBucket; booking: ReadoutBooking; limit: number; retry: number }> = [
    {
      bucket: "account_day",
      booking: { key: input.accountKey, period: READOUT_BUDGET_PERIODS.accountDay, periodStart: readoutDayStart(now), characters },
      limit: input.limits.accountCharactersPerDay,
      retry: untilTomorrow(now),
    },
    {
      bucket: "provider_day",
      booking: { key: input.providerKey, period: READOUT_BUDGET_PERIODS.providerDay, periodStart: readoutDayStart(now), characters },
      limit: input.limits.providerCharactersPerDay,
      retry: untilTomorrow(now),
    },
    {
      bucket: "provider_month",
      booking: { key: input.providerKey, period: READOUT_BUDGET_PERIODS.providerMonth, periodStart: readoutMonthStart(now), characters },
      limit: input.limits.providerCharactersPerMonth,
      retry: untilNextMonth(now),
    },
  ];

  // A piece larger than a whole bucket can never be admitted. Said before any
  // booking, because the upsert's first insert would otherwise admit it.
  for (const step of plan) {
    if (characters > step.limit) throw new ReadoutBudgetError(step.bucket, step.retry);
  }

  const booked: ReadoutBooking[] = [];
  for (const step of plan) {
    if (await input.store.book({ ...step.booking, limit: step.limit })) {
      booked.push(step.booking);
      continue;
    }
    // Give back what this request already took before the caller sees the
    // refusal, or a capped month burns the day on requests that never ran.
    for (const done of booked.reverse()) await input.store.unbook(done).catch(() => undefined);
    throw new ReadoutBudgetError(step.bucket, step.retry);
  }
  return { bookings: booked, characters, settled: false };
}

export async function settleReadoutReservation(input: {
  store: ReadoutBudgetStore;
  reservation: ReadoutReservation;
  disposition: ReadoutDisposition;
}): Promise<{ releasedCharacters: number }> {
  const { reservation } = input;
  if (reservation.settled) return { releasedCharacters: 0 };
  reservation.settled = true;
  if (readoutKeepsReservation(input.disposition)) return { releasedCharacters: 0 };
  for (const booking of reservation.bookings) await input.store.unbook(booking);
  return { releasedCharacters: reservation.characters };
}

import "server-only";

import { createHash, randomInt } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ChatAccessError } from "@/lib/chatSecurity";

export type GuestIdempotencyClaim = {
  key: string;
  period: string;
  periodStart: Date;
};

/**
 * A single-use claim on a client-supplied idempotency key, scoped to one guest
 * identity and one action.
 *
 * A double click, an impatient retry or a flaky connection must not be able to
 * run an 8-credit review twice. The claim is taken *before* the quota
 * reservation and the provider call, in one conditional upsert whose `WHERE`
 * refuses a second insert -- so the second request loses the race in the
 * database rather than in a check the first request has not finished writing.
 *
 * The claim carries no payload: replaying a key reports the duplicate rather
 * than replaying a stored result, because a guest review is never persisted
 * (there is no permanent record to read a result back from, by design). The
 * client generates one key per user-initiated run and disables the control
 * while it is in flight, so the only requests this rejects are genuine
 * duplicates.
 *
 * Claims live in the day bucket of the generic usage table, so they expire
 * with the day's rows and need no schema of their own.
 */
const claimPeriod = (scope: string) => `guest-idempotency-${scope}-day`;

/** A key may be claimed exactly once. Bound as a parameter, like every limit. */
const SINGLE_USE_LIMIT = 1;

const dayStart = () => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
};

// The raw key never reaches storage: it is client-supplied, and hashing it
// together with the subject means one guest cannot probe or collide with
// another guest's claims by guessing keys.
const claimKey = (subjectKey: string, scope: string, idempotencyKey: string) =>
  `idem:${createHash("sha256")
    .update(`${subjectKey}:${scope}:${idempotencyKey}`)
    .digest("hex")}`;

export const claimGuestIdempotencyKey = async (
  subjectKey: string,
  scope: string,
  idempotencyKey: string
): Promise<GuestIdempotencyClaim> => {
  const period = claimPeriod(scope);
  const periodStart = dayStart();
  const key = claimKey(subjectKey, scope, idempotencyKey);
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
    VALUES (${key}, ${period}, ${periodStart}, 1, NOW())
    ON CONFLICT ("key", "period", "periodStart")
    DO UPDATE SET
      "count" = "ChatUsageBucket"."count" + 1,
      "updatedAt" = NOW()
    WHERE "ChatUsageBucket"."count" < ${SINGLE_USE_LIMIT}
    RETURNING "count"
  `;
  if (rows.length === 0) {
    throw new ChatAccessError(
      409,
      "DUPLICATE_REQUEST",
      "This request is already being processed."
    );
  }
  return { key, period, periodStart };
};

/**
 * Releases a claim so the user can genuinely retry. Called when the run failed
 * without producing a result -- the same moment the quota slot goes back.
 */
export const releaseGuestIdempotencyKey = async (
  claim: GuestIdempotencyClaim
) => {
  await prisma.chatUsageBucket.updateMany({
    where: {
      key: claim.key,
      period: claim.period,
      periodStart: claim.periodStart,
      count: { gt: 0 },
    },
    data: { count: { decrement: 1 } },
  });
};

/**
 * A claim on one account run while it is in flight, beside the guest key
 * above and built the same way: one conditional upsert on the generic usage
 * table, so a second request loses in the database rather than in a check the
 * first has not finished writing.
 *
 * What it guards is different, so two things differ. The guest key is
 * single-use for the day; this claim is held only while its run runs:
 *
 *  - It expires. `updatedAt` is the last time its holder showed it was alive
 *    (the claim, then each `renewInFlightRun`), and a claim older than
 *    `ttlSeconds` may be taken over, so a process that dies before its
 *    `finally` cannot lock the run out for good, while a live run however
 *    long keeps it by renewing.
 *  - It is owned. The holder's random token is stored as the row's count, and
 *    release deletes the row only while that token is still there, so a holder
 *    that overran its TTL cannot release the claim of the request that took
 *    over from it.
 *
 * The key starts with the caller's usage subject, so account deletion's
 * prefix sweep removes it. The period names no minute, day or month, so the
 * maintenance sweep (lib/maintenance.ts) only drops it after 90 idle days
 * instead of treating it as an expired time bucket; a released claim is
 * deleted at once anyway.
 */
export type InFlightRunClaim = {
  key: string;
  period: string;
  periodStart: Date;
  token: number;
};

/** One row per run key: the claim is not a time bucket. */
const IN_FLIGHT_PERIOD_START = new Date(0);
const inFlightPeriod = (scope: string) => `${scope}-in-flight`;

/** A positive int4, so the bound parameter needs no BigInt handling. */
const inFlightToken = () => randomInt(1, 2 ** 31);

export const claimInFlightRun = async (
  subjectKey: string,
  scope: string,
  runKey: string,
  ttlSeconds: number
): Promise<InFlightRunClaim> => {
  const key = `${subjectKey}:${scope}:${runKey}`;
  const period = inFlightPeriod(scope);
  const periodStart = IN_FLIGHT_PERIOD_START;
  const token = inFlightToken();
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
    VALUES (${key}, ${period}, ${periodStart}, ${token}, NOW())
    ON CONFLICT ("key", "period", "periodStart")
    DO UPDATE SET
      "count" = EXCLUDED."count",
      "updatedAt" = NOW()
    WHERE "ChatUsageBucket"."updatedAt" < NOW() - ${ttlSeconds}::int * INTERVAL '1 second'
    RETURNING "count"
  `;
  if (rows.length === 0) {
    throw new ChatAccessError(
      409,
      "DUPLICATE_REQUEST",
      "This request is already being processed."
    );
  }
  return { key, period, periodStart, token };
};

/**
 * Moves the claim's `updatedAt` forward while its run is alive, so a run
 * longer than the TTL is not taken over. Only the holder's own token is
 * renewed: false means the claim already expired and was taken over (or
 * released), and nothing was changed.
 */
export const renewInFlightRun = async (claim: InFlightRunClaim) => {
  const renewed = await prisma.$executeRaw`
    UPDATE "ChatUsageBucket"
    SET "updatedAt" = NOW()
    WHERE "key" = ${claim.key}
      AND "period" = ${claim.period}
      AND "periodStart" = ${claim.periodStart}
      AND "count" = ${claim.token}
  `;
  return renewed > 0;
};

/**
 * Hands the claim back once its run is over -- success, failure or exception
 * alike. A no-op when the claim already expired and was taken over.
 */
export const releaseInFlightRun = async (claim: InFlightRunClaim) => {
  await prisma.chatUsageBucket.deleteMany({
    where: {
      key: claim.key,
      period: claim.period,
      periodStart: claim.periodStart,
      count: BigInt(claim.token),
    },
  });
};

import "server-only";

import { createHash } from "node:crypto";
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

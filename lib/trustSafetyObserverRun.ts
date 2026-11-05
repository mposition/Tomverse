/**
 * The single writer of the trust-safety observer's run row
 * (docs/policy/trust-safety-compliance-agent.md §5.3, §5.6 item 2).
 *
 * §5.6 allows exactly one tagged `$queryRaw` in E1's closure, and it has to
 * meet four conditions at once: tagged (never `$queryRawUnsafe`), the fixed
 * statement shape below, inside a single writer module, and on a transaction
 * the wrapper armed. A second raw statement in this module, the same statement
 * in another file, or the same row written through a Prisma delegate are all
 * failures -- the allowance is for this one statement here.
 *
 * Three of the five columns are not the application's to set: `recordedAt` and
 * `deadlineAt` are overwritten by the row's BEFORE INSERT trigger, and
 * `outcome` has one allowed value. They are sent because the columns are NOT
 * NULL, not because the value sent matters.
 *
 * `RETURNING "id"` is here because a tagged `$queryRaw` expects a result set.
 * It returns the id this module just generated, so nothing is read back out of
 * the table -- §5.3 keeps the table unread, and a row count or a recorded time
 * read back would be the first reader.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { type TrustSafetyTx, TrustSafetyRoundRefused } from "@/lib/trustSafetyTransaction";

/**
 * Records one successful round.
 *
 * Nothing is returned. The row is the record (§5.3) and the caller already
 * knows the round succeeded; handing back a row would invite a judgement to
 * read it. A commit that passes the deferred trigger is the success instant,
 * and a late one leaves no row at all -- so a resolved call means the round
 * was inside both the deadline and the window.
 */
export const insertTrustSafetyObserverRun = async ({
  tx,
  observedAt,
}: {
  readonly tx: TrustSafetyTx;
  readonly observedAt: Date;
}): Promise<void> => {
  const id = randomUUID();
  const rows = await tx.statement(
    (client) => client.$queryRaw<{ id: string }[]>`
      INSERT INTO "TrustSafetyObserverRun" ("id", "outcome", "observedAt", "recordedAt", "deadlineAt")
      VALUES (
        ${id},
        'succeeded',
        ${observedAt.toISOString()}::timestamptz,
        clock_timestamp(),
        clock_timestamp())
      RETURNING "id"`,
  );
  // The statement either inserts one row or raises; a different answer means
  // the shape above stopped being the statement this module thinks it is.
  if (rows.length !== 1 || rows[0]?.id !== id) {
    throw new TrustSafetyRoundRefused("trust_safety_run_row_not_inserted");
  }
};

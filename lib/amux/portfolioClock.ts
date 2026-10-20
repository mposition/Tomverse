import type { Prisma } from "@prisma/client";

/** Portfolio guards compare persisted timestamps with the database clock.
 * A service clock a few milliseconds ahead must not turn a valid approval
 * into a refused insert. Never fall back to the service clock.
 * Truncate, never cast: `::TIMESTAMP(3)` rounds to the nearest millisecond,
 * so half of all readings land up to 0.5 ms ahead of the clock, and the
 * guard's `> clock_timestamp()` refuses the insert when it fires sooner. */
export async function readAmuxPortfolioClock(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "now"
  `;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("amux_portfolio_clock_unavailable");
  }
  return now;
}

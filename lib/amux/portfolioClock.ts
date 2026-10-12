import type { Prisma } from "@prisma/client";

/** Portfolio guards compare persisted timestamps with the database clock.
 * A service clock a few milliseconds ahead must not turn a valid approval
 * into a refused insert. Never fall back to the service clock. */
export async function readAmuxPortfolioClock(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("amux_portfolio_clock_unavailable");
  }
  return now;
}

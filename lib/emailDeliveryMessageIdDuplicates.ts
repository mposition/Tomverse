import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Whether `EmailDelivery(providerAccount, providerMessageId)` can carry a
 * unique index.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.4 (C72),
 * docs/policy/email-notifications.md section 9.8.
 *
 * S1b-2b made the webhook match a delivery by `(providerAccount,
 * providerMessageId)` and left the column pair indexed but not unique, because
 * the build before it wrote neither. The contraction adds the unique index --
 * and an index build fails, mid-deploy, on the first duplicate it meets.
 *
 * So the question is asked of the real data first, read-only, before the
 * migration is allowed near an environment. **Counts only**: a duplicate is
 * interesting as a number and as a fact about which account it happened in,
 * and a report naming a message id or an address would be a report nobody can
 * paste into a ticket.
 *
 * A row with either column null is not a duplicate of anything: Postgres does
 * not compare nulls, and the index is partial for the same reason -- a delivery
 * that never reached the provider has no message id, and there are many of
 * them.
 */

export type MessageIdDuplicateReport = {
  /** Rows the index would cover: both columns present. */
  indexable: number;
  /** `(account, message id)` pairs that appear more than once. */
  duplicatePairs: number;
  /** Rows belonging to those pairs -- what a unique build would refuse. */
  duplicateRows: number;
  /** The worst pair's row count, so "two" and "two hundred" are different. */
  largestPair: number;
  /** Which accounts the duplicates are in, without naming a message. */
  accounts: Array<{ providerAccount: string; duplicatePairs: number }>;
  /** True when the unique index can be created as written. */
  safeToAddUnique: boolean;
};

export async function emailDeliveryMessageIdDuplicates(): Promise<MessageIdDuplicateReport> {
  const [totals] = await prisma.$queryRaw<
    Array<{ indexable: bigint; duplicate_pairs: bigint; duplicate_rows: bigint; largest_pair: bigint }>
  >`
    WITH pairs AS (
      SELECT "providerAccount", "providerMessageId", count(*) AS rows
        FROM "EmailDelivery"
       WHERE "providerAccount" IS NOT NULL
         AND "providerMessageId" IS NOT NULL
       GROUP BY "providerAccount", "providerMessageId"
    )
    SELECT
      COALESCE(sum(rows), 0)                                   AS indexable,
      COALESCE(count(*) FILTER (WHERE rows > 1), 0)            AS duplicate_pairs,
      COALESCE(sum(rows) FILTER (WHERE rows > 1), 0)           AS duplicate_rows,
      COALESCE(max(rows), 0)                                   AS largest_pair
      FROM pairs
  `;

  const accounts = await prisma.$queryRaw<
    Array<{ providerAccount: string; duplicate_pairs: bigint }>
  >`
    WITH pairs AS (
      SELECT "providerAccount", "providerMessageId", count(*) AS rows
        FROM "EmailDelivery"
       WHERE "providerAccount" IS NOT NULL
         AND "providerMessageId" IS NOT NULL
       GROUP BY "providerAccount", "providerMessageId"
    )
    SELECT "providerAccount", count(*) AS duplicate_pairs
      FROM pairs
     WHERE rows > 1
     GROUP BY "providerAccount"
     ORDER BY "providerAccount"
  `;

  const duplicatePairs = Number(totals?.duplicate_pairs ?? 0);
  return {
    indexable: Number(totals?.indexable ?? 0),
    duplicatePairs,
    duplicateRows: Number(totals?.duplicate_rows ?? 0),
    largestPair: Number(totals?.largest_pair ?? 0),
    accounts: accounts.map((row) => ({
      providerAccount: row.providerAccount,
      duplicatePairs: Number(row.duplicate_pairs),
    })),
    safeToAddUnique: duplicatePairs === 0,
  };
}

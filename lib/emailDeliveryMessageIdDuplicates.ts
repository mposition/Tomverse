import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Whether `EmailDelivery(providerAccount, providerMessageId)` carries a
 * duplicate right now.
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
 * migration is allowed near an environment.
 *
 * **This is a reason to stop, not a permission to go.** It reads at one moment
 * and the migration runs at another, and nothing here holds a lock in between;
 * a duplicate written after the reading is one the reading cannot know about.
 * The index build is the only statement that decides, which is why the
 * migration is ordered to survive its own failure -- and why the field below is
 * called what it is rather than `safeToAddUnique`.
 *
 * One statement, not two. The totals and the per-account breakdown come out of
 * a single `READ COMMITTED` snapshot, because two queries are two snapshots and
 * could report no duplicates beside a list of the accounts the duplicates are
 * in.
 *
 * **Counts only.** A duplicate is interesting as a number and as a fact about
 * which account it happened in; a report naming a message id or an address
 * would be a report nobody can paste into a ticket. `providerAccount` is a lane
 * name from a closed set, and the database says so --
 * `EmailDelivery_provider_account_check` (20260916150000) admits only NULL,
 * `transactional` and `marketing`.
 *
 * A row with either column null is not a duplicate of anything: Postgres does
 * not compare nulls, which is also why the index is plain rather than partial
 * -- a delivery that never reached the provider has no message id, and there
 * are many of them, and they conflict with nothing either way.
 */

export type MessageIdDuplicateReport = {
  /** Every row in the table, so a lock-duration decision has its input. */
  totalRows: number;
  /** Rows the uniqueness applies to: both columns present. */
  indexable: number;
  /** `(account, message id)` pairs that appear more than once. */
  duplicatePairs: number;
  /** Rows belonging to those pairs -- what a unique build would refuse. */
  duplicateRows: number;
  /** The worst pair's row count, so "two" and "two hundred" are different. */
  largestPair: number;
  /** Which accounts the duplicates are in, without naming a message. */
  accounts: Array<{ providerAccount: string; duplicatePairs: number }>;
  /** No duplicate existed at the moment of the read. Not a guarantee. */
  noDuplicatesAtReadTime: boolean;
};

type Row = {
  total_rows: bigint;
  indexable: bigint;
  duplicate_pairs: bigint;
  duplicate_rows: bigint;
  largest_pair: bigint;
  accounts: Array<{ providerAccount: string; duplicatePairs: number }> | null;
};

export async function emailDeliveryMessageIdDuplicates(): Promise<MessageIdDuplicateReport> {
  const [row] = await prisma.$queryRaw<Array<Row>>`
    WITH pairs AS (
      SELECT "providerAccount", "providerMessageId", count(*) AS rows
        FROM "EmailDelivery"
       WHERE "providerAccount" IS NOT NULL
         AND "providerMessageId" IS NOT NULL
       GROUP BY "providerAccount", "providerMessageId"
    ),
    per_account AS (
      SELECT "providerAccount", count(*) AS duplicate_pairs
        FROM pairs
       WHERE rows > 1
       GROUP BY "providerAccount"
    )
    SELECT
      (SELECT count(*) FROM "EmailDelivery")              AS total_rows,
      COALESCE((SELECT sum(rows) FROM pairs), 0)          AS indexable,
      COALESCE((SELECT count(*) FROM pairs WHERE rows > 1), 0)   AS duplicate_pairs,
      COALESCE((SELECT sum(rows) FROM pairs WHERE rows > 1), 0)  AS duplicate_rows,
      COALESCE((SELECT max(rows) FROM pairs), 0)          AS largest_pair,
      (
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'providerAccount', "providerAccount",
                   'duplicatePairs', duplicate_pairs
                 )
                 ORDER BY "providerAccount"
               )
          FROM per_account
      )                                                   AS accounts
  `;

  const duplicatePairs = Number(row?.duplicate_pairs ?? 0);
  return {
    totalRows: Number(row?.total_rows ?? 0),
    indexable: Number(row?.indexable ?? 0),
    duplicatePairs,
    duplicateRows: Number(row?.duplicate_rows ?? 0),
    largestPair: Number(row?.largest_pair ?? 0),
    accounts: (row?.accounts ?? []).map((account) => ({
      providerAccount: account.providerAccount,
      duplicatePairs: Number(account.duplicatePairs),
    })),
    noDuplicatesAtReadTime: duplicatePairs === 0,
  };
}

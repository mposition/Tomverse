/**
 * Marketing retention (S3 plan, S3h1; docs/policy/marketing-automation.md §12.2).
 *
 * One bounded batch per table per run, each in its own transaction, through
 * the store's one retention writer. What may go is the database's decision --
 * its delete triggers refuse anything §12.2 keeps -- and what went is in the
 * audit chain and a `retention_run` report. Run by the daily maintenance
 * cleanup; a table with more due than one batch finishes on later days.
 *
 * Not here yet: purging the content of published posts after 24 months and
 * compacting history entries after 90 days (S3h2), and the public image bucket,
 * which has no port to delete through.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";

import {
  purgeExpiredMarketingRows,
  runMarketingTransaction,
  type MarketingRetentionTable,
} from "@/lib/marketingStore";

const TABLES: readonly MarketingRetentionTable[] = [
  "MarketingReport",
  "AiVisibilityRun",
  "MarketingPost",
];

export async function runMarketingRetention(
  client: PrismaClient,
): Promise<Record<MarketingRetentionTable, number>> {
  const purged = {} as Record<MarketingRetentionTable, number>;
  for (const table of TABLES) {
    const result = await runMarketingTransaction(
      client,
      (tx) => purgeExpiredMarketingRows(tx, table),
      { maxWait: 5_000, timeout: 60_000 },
    );
    purged[table] = result.purged;
  }
  return purged;
}

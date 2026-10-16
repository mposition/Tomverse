/**
 * Marketing retention (S3 plan, S3h1; docs/policy/marketing-automation.md §12.2).
 *
 * One bounded batch per table per run, each in its own transaction, through
 * the store's one retention writer. What may go is the database's decision --
 * its delete triggers refuse anything §12.2 keeps -- and what went is in the
 * audit chain and a `retention_run` report. Run by the daily maintenance
 * cleanup; a table with more due than one batch finishes on later days.
 *
 * The LLM cost ledger (S3c3c) is the fourth table: closed calls past their 24
 * months and not on legal hold, through the ledger's own writer.
 *
 * Posts that are kept have two more rules (S3h2), each its own step: content
 * purged twenty-four months after publication, and attempt and webhook entries
 * in a post's history summarised after ninety days.
 *
 * Not here yet: the public image bucket, which has no port to delete through.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";

import { purgeExpiredMarketingLlmCalls } from "@/lib/marketingLlmBudgetStore";
import {
  compactMarketingPostHistory,
  purgeExpiredMarketingPostContent,
  purgeExpiredMarketingRows,
  runMarketingTransaction,
  type MarketingRetentionTable,
} from "@/lib/marketingStore";

const TABLES: readonly MarketingRetentionTable[] = [
  "MarketingReport",
  "AiVisibilityRun",
  "MarketingPost",
];

/** What one run changed, by step: rows deleted, or posts changed in place. */
export type MarketingRetentionResult = Record<
  MarketingRetentionTable | "MarketingLlmCall" | "MarketingPostContent" | "MarketingPostHistory",
  number
>;

export async function runMarketingRetention(client: PrismaClient): Promise<MarketingRetentionResult> {
  const purged = {} as MarketingRetentionResult;
  for (const table of TABLES) {
    const result = await runMarketingTransaction(
      client,
      (tx) => purgeExpiredMarketingRows(tx, table),
      { maxWait: 5_000, timeout: 60_000 },
    );
    purged[table] = result.purged;
  }
  const ledger = await client.$transaction((tx) => purgeExpiredMarketingLlmCalls(tx), {
    maxWait: 5_000,
    timeout: 60_000,
  });
  purged.MarketingLlmCall = ledger.purged;
  const content = await runMarketingTransaction(
    client,
    (tx) => purgeExpiredMarketingPostContent(tx),
    { maxWait: 5_000, timeout: 60_000 },
  );
  purged.MarketingPostContent = content.purged;
  const history = await runMarketingTransaction(
    client,
    (tx) => compactMarketingPostHistory(tx),
    { maxWait: 5_000, timeout: 60_000 },
  );
  purged.MarketingPostHistory = history.compacted;
  return purged;
}

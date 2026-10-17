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
 * **Nothing runs while the marketing kill switch is on.** The switch stops
 * everything but reading the record (docs/policy/marketing-automation.md §6.1),
 * and retention is the one step whose effect cannot be undone: a row, a post's
 * content or its history detail deleted during an incident is gone from the
 * investigation. The run says it was skipped rather than reporting zeros, so
 * "nothing was due" and "nothing was allowed" stay different answers; the
 * rows wait for the next run after the switch is off.
 *
 * Not here yet: the public image bucket, which has no port to delete through.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";

import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
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

type MarketingRetentionStep =
  | MarketingRetentionTable
  | "MarketingLlmCall"
  | "MarketingPostContent"
  | "MarketingPostHistory";

/**
 * What one run changed, by step -- rows deleted, or posts changed in place --
 * or that it did not run because the kill switch was on.
 */
export type MarketingRetentionResult =
  | ({ readonly skipped: null } & Record<MarketingRetentionStep, number>)
  | { readonly skipped: "kill_switch" };

/** The same reading as every marketing gate: any non-empty value is on. */
const killSwitchOn = (env: Readonly<Record<string, string | undefined>>) => {
  const value = env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
  return typeof value === "string" && value.trim().length > 0;
};

export async function runMarketingRetention(
  client: PrismaClient,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MarketingRetentionResult> {
  if (killSwitchOn(env)) return { skipped: "kill_switch" };
  const purged = {} as Record<MarketingRetentionStep, number>;
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
  return { skipped: null, ...purged };
}

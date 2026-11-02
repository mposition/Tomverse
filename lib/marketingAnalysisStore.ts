/**
 * The analysis behind a marketing brief, stored beside it (operator decision
 * 2026-11-01; table `MarketingAnalysis`).
 *
 * Its own module and raw SQL, not the marketing store: `lib/marketingStore.ts`
 * and `lib/marketingAutomationSchema.ts` are in the autonomous-admission
 * manifest and the webhook fingerprint, and nothing here decides whether a
 * post goes out. The payload is the generator's reading for a person; the
 * schema check here and the table's CHECKs are what it must meet.
 */

import "server-only";

import { randomBytes } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import {
  MARKETING_ANALYSIS_ENABLED_KEY,
  MarketingAnalysisSettingsRefusedError,
  marketingAnalysisEnabledFromValue,
  marketingAnalysisPayloadSchema,
  type MarketingAnalysisPayload,
} from "@/lib/marketingAnalysisCore";
import { MARKETING_RETENTION_SETTING } from "@/lib/marketingAutomationSchema";
import { MARKETING_RETENTION_ACTIONS } from "@/lib/marketingStore";

type Tx = Prisma.TransactionClient;

/** What a stored analysis row says wrote it. */
export const MARKETING_ANALYSIS_SOURCE_VERSION = "marketing-analysis-v1";

/** Rows one retention run deletes; the rest wait for the next run. */
export const MARKETING_ANALYSIS_RETENTION_BATCH_LIMIT = 200;

const newAnalysisId = () => `a${randomBytes(12).toString("hex")}`;

/**
 * Store the analysis for a brief the caller has just inserted, in the
 * caller's transaction. Parsed again here: the report schema already checked
 * it, and this is the one writer of the table.
 */
export async function insertMarketingAnalysis(
  tx: Pick<Tx, "$executeRaw">,
  input: { readonly briefReportId: string; readonly analysis: MarketingAnalysisPayload },
): Promise<{ readonly id: string }> {
  const payload = marketingAnalysisPayloadSchema.parse(input.analysis);
  const id = newAnalysisId();
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "MarketingAnalysis" ("id", "briefReportId", "payload", "sourceVersion")
    VALUES (${id}, ${input.briefReportId}, ${JSON.stringify(payload)}::jsonb, ${MARKETING_ANALYSIS_SOURCE_VERSION})
  `);
  return { id };
}

// ---------------------------------------------------------------------------
// The Admin switch
// ---------------------------------------------------------------------------

export type MarketingAnalysisSettingRead = {
  readonly enabled: boolean;
  /** The row's last change, the compare-and-set token; null while unset. */
  readonly version: string | null;
};

export async function readMarketingAnalysisSetting(
  client: Pick<PrismaClient, "appSetting">,
): Promise<MarketingAnalysisSettingRead> {
  const row = await client.appSetting.findUnique({
    where: { key: MARKETING_ANALYSIS_ENABLED_KEY },
    select: { value: true, updatedAt: true },
  });
  return {
    enabled: marketingAnalysisEnabledFromValue(row?.value),
    version: row ? row.updatedAt.toISOString() : null,
  };
}

/**
 * Turn the analysis and brief on or off (operator decision 2026-11-01:
 * default off, the operator turns it on). Compare-and-set against the version
 * the screen read, and a save that changes nothing is refused, so every audit
 * row the route writes beside this is a change. The ledger reads the same row
 * inside every `brief` reservation.
 */
export async function writeMarketingAnalysisSetting(
  tx: Pick<Tx, "appSetting">,
  input: { readonly enabled: boolean; readonly expectedVersion: string | null },
): Promise<MarketingAnalysisSettingRead> {
  const row = await tx.appSetting.findUnique({
    where: { key: MARKETING_ANALYSIS_ENABLED_KEY },
    select: { value: true, updatedAt: true },
  });
  const version = row ? row.updatedAt.toISOString() : null;
  if (version !== input.expectedVersion) {
    throw new MarketingAnalysisSettingsRefusedError("settings_conflict", "The switch changed since the screen read it");
  }
  if (marketingAnalysisEnabledFromValue(row?.value) === input.enabled) {
    throw new MarketingAnalysisSettingsRefusedError("settings_change_is_noop", "The switch is already in that position");
  }
  const value = input.enabled ? "true" : "false";
  if (!row) {
    // No row yet, so the unique key is the condition: a second writer racing
    // to create it fails on the constraint instead of overwriting.
    await tx.appSetting.create({ data: { key: MARKETING_ANALYSIS_ENABLED_KEY, value } });
  } else {
    const moved = await tx.appSetting.updateMany({
      where: { key: MARKETING_ANALYSIS_ENABLED_KEY, updatedAt: row.updatedAt },
      data: { value },
    });
    if (moved.count !== 1) {
      throw new MarketingAnalysisSettingsRefusedError("settings_conflict", "The switch changed since the screen read it");
    }
  }
  return readMarketingAnalysisSetting(tx);
}

/**
 * Delete analyses past their retention, one bounded batch, each with its
 * audit row -- the retention writers' shape (lib/marketingRetention.ts).
 */
export async function purgeExpiredMarketingAnalyses(
  tx: Tx,
  limit: number = MARKETING_ANALYSIS_RETENTION_BATCH_LIMIT,
): Promise<{ readonly purged: number }> {
  await tx.$queryRaw(Prisma.sql`SELECT set_config(${MARKETING_RETENTION_SETTING}, 'on', true)`);
  await takeAuditChainLock(tx);
  const take = Math.max(0, Math.min(Math.floor(limit), MARKETING_ANALYSIS_RETENTION_BATCH_LIMIT));
  const due = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "MarketingAnalysis"
    WHERE "retentionUntil" <= (clock_timestamp() AT TIME ZONE 'UTC')
    ORDER BY "retentionUntil", "id"
    LIMIT ${take}
    FOR UPDATE SKIP LOCKED
  `);
  let purged = 0;
  for (const { id } of due) {
    await writeSystemAuditLog({
      tx,
      systemActor: "marketing-retention",
      action: MARKETING_RETENTION_ACTIONS.rowPurged,
      targetType: "MarketingAnalysis",
      targetId: id,
      summary: "Deleted a marketing analysis its retention period had ended for.",
      metadata: { table: "MarketingAnalysis" },
    });
    const deleted = await tx.$executeRaw(Prisma.sql`DELETE FROM "MarketingAnalysis" WHERE "id" = ${id}`);
    if (deleted !== 1) throw new Error("marketing_analysis_retention_lost_its_row");
    purged += 1;
  }
  return { purged };
}

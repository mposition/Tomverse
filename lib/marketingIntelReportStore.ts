/**
 * The generator's internal reports, recorded in one transaction (S3 plan, S3f).
 *
 * One named writer: statement bounds, the audit chain lock, the read-back of a
 * report already recorded under the same key, then -- for a new report -- the
 * deadline bound, the kill switch, the app's own checks, the report row through
 * the store's `insertMarketingReport()` and the `marketing-generator` audit
 * row. The generator's report is data: it chose the words of a brief and the
 * facts it found, and the app decides what of that is kept.
 *
 * Not in `lib/marketingStore.ts`, for the reason the draft intake is not: the
 * store's slice the webhook fingerprint hashes stays as it is.
 */

import "server-only";

import { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { marketingClaimById } from "@/lib/marketingClaims";
import {
  boundMarketingGeneratorStatements,
  boundMarketingGeneratorWriteByDeadline,
} from "@/lib/marketingDraftIntakeStore";
import {
  MARKETING_GENERATOR_REPORT_ACTION,
  marketingGeneratorReportDigest,
  marketingGeneratorReportKey,
  marketingGeneratorReportProvenanceDigest,
  marketingGeneratorReportStoredPayload,
  type MarketingGeneratorReport,
} from "@/lib/marketingIntelReportCore";
import { insertMarketingReport, type MarketingTransaction } from "@/lib/marketingStore";

/** What a recorded report's row says wrote it. */
export const MARKETING_GENERATOR_REPORT_SOURCE_VERSION = "marketing-generator-report-v1";

export type MarketingGeneratorReportOutcome =
  | { readonly status: "refused"; readonly reasons: readonly string[] }
  | { readonly status: "conflict" }
  | {
      readonly status: "recorded";
      readonly reportRowId: string;
      readonly existing: boolean;
      readonly droppedFactCount: number;
    };

const killSwitchOn = (value: string | undefined) =>
  typeof value === "string" && value.trim().length > 0;

export async function recordMarketingGeneratorReport(
  tx: MarketingTransaction,
  input: {
    readonly report: MarketingGeneratorReport;
    readonly killSwitchValue: string | undefined;
  },
): Promise<MarketingGeneratorReportOutcome> {
  await boundMarketingGeneratorStatements(tx);
  // First, before any read an answer rests on: a second record of the same key
  // waits here for the first, and then reads it back.
  await takeAuditChainLock(tx);

  const report = input.report;
  const reportKey = marketingGeneratorReportKey(report);
  const reportDigest = marketingGeneratorReportDigest(report);

  const recorded = await tx.adminAuditLog.findFirst({
    where: {
      action: MARKETING_GENERATOR_REPORT_ACTION,
      targetType: "MarketingReport",
      metadata: { path: ["reportKey"], equals: reportKey },
    },
    select: { targetId: true, metadata: true },
  });
  if (recorded) {
    // The same report only if it was the same bytes. Answered before every
    // gate, so a record whose answer was lost is learned after the kill
    // switch is on or the deadline has passed -- it is not a new success.
    const metadata = recorded.metadata as { reportDigest?: unknown; droppedFactCount?: unknown } | null;
    if (metadata?.reportDigest !== reportDigest || !recorded.targetId) return { status: "conflict" };
    return {
      status: "recorded",
      reportRowId: recorded.targetId,
      existing: true,
      droppedFactCount: typeof metadata.droppedFactCount === "number" ? metadata.droppedFactCount : 0,
    };
  }

  const bounded = await boundMarketingGeneratorWriteByDeadline(tx, new Date(report.deadlineAt));
  if ("refused" in bounded) return { status: "refused", reasons: [bounded.refused] };

  // Stopped means stopped (docs/policy/marketing-automation.md §6.1).
  if (killSwitchOn(input.killSwitchValue)) return { status: "refused", reasons: ["kill_switch"] };

  // A brief names claims the drafts will rest on; a claim the registry does not
  // have is not one a draft can use, and a brief naming it would be a plan
  // built on nothing.
  if (report.kind === "brief" && report.payload.claimIds.some((claimId) => marketingClaimById(claimId) === null)) {
    return { status: "refused", reasons: ["report_claim_unknown"] };
  }

  const stored = marketingGeneratorReportStoredPayload(report);
  const row = await insertMarketingReport(tx, {
    kind: report.kind,
    periodStart: new Date(report.periodStart),
    periodEnd: new Date(report.periodEnd),
    payload: stored.payload,
    sourceVersion: MARKETING_GENERATOR_REPORT_SOURCE_VERSION,
  });

  // The last statement before the audit row, as in the draft intake: past the
  // deadline by the database's clock, the whole record rolls back.
  const late = await tx.$queryRaw<Array<{ late: boolean }>>(Prisma.sql`
    SELECT clock_timestamp() > ${new Date(report.deadlineAt)}::timestamptz AS "late"
  `);
  if (late[0]?.late !== false) {
    throw new Error("The report reached its success record after the service's deadline");
  }

  await writeSystemAuditLog({
    tx,
    systemActor: "marketing-generator",
    action: MARKETING_GENERATOR_REPORT_ACTION,
    targetType: "MarketingReport",
    targetId: row.id,
    summary:
      report.kind === "brief"
        ? "Recorded the marketing generator's brief."
        : "Recorded the market facts the marketing generator found.",
    metadata: {
      reportKey,
      reportDigest,
      generatorRunId: report.generatorRunId,
      reportId: report.reportId,
      kind: report.kind,
      provenanceDigest: marketingGeneratorReportProvenanceDigest(report.provenance),
      droppedFactCount: stored.droppedFactCount,
    },
  });

  return { status: "recorded", reportRowId: row.id, existing: false, droppedFactCount: stored.droppedFactCount };
}

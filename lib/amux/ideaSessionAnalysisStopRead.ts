import "server-only";

import type { Prisma } from "@prisma/client";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StopSnapshot = {
  namespace: string;
  claimStatus: string;
  closedAt: Date | null;
  resolutionAuditLogId: string | null;
  reservationStatus: string;
  operatingScopeSettingId: string;
  latestScopeId: string | null;
  submissionOrigin: string;
  ideaState: string;
  cancelledAt: Date | null;
  analysisCompletedAt: Date | null;
  analysisDeadlineAt: Date;
  rawAvailable: boolean;
  provenanceAvailable: boolean;
  rawPurgedAt: Date | null;
  now: Date;
};

export class AmuxSessionAnalysisStopReadError extends Error {
  constructor(readonly code: "not_found" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxSessionAnalysisStopReadError";
  }
}

/** Only a still-owned, unexpired claim permits the local CLI to continue. */
export function shouldAmuxSessionAnalysisStop(row: StopSnapshot): boolean {
  return !(row.namespace === AMUX_V4_ANALYSIS_NAMESPACE &&
    row.claimStatus === "in_flight" && row.closedAt === null &&
    row.resolutionAuditLogId === null && row.reservationStatus === "queued" &&
    row.latestScopeId === row.operatingScopeSettingId &&
    row.submissionOrigin === "session" &&
    ["submitted", "analyzing"].includes(row.ideaState) &&
    row.cancelledAt === null && row.analysisCompletedAt === null &&
    row.analysisDeadlineAt > row.now && row.rawAvailable === true &&
    row.provenanceAvailable === true && row.rawPurgedAt === null);
}

/** Content-free, transaction-scoped stop poll for one exact v19 claim. */
export async function readAmuxSessionAnalysisStopState(
  tx: Prisma.TransactionClient, claimId: string, reservationId: string,
  ideaId: string,
): Promise<{ claimId: string; reservationId: string; stop: boolean }> {
  if (!UUID.test(claimId) || !UUID.test(reservationId) || !UUID.test(ideaId)) {
    throw new AmuxSessionAnalysisStopReadError("not_found");
  }
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit,
           set_config('TimeZone', 'UTC', true) AS transaction_zone
  `;
  const rows = await tx.$queryRaw<StopSnapshot[]>`
    SELECT c."namespace", c."status" AS "claimStatus", c."closedAt",
           c."resolutionAuditLogId", r."status" AS "reservationStatus",
           r."operatingScopeSettingId",
           (SELECT s."id" FROM "AmuxIdeaOperatingScopeSetting" s
            ORDER BY s."version" DESC LIMIT 1) AS "latestScopeId",
           i."submissionOrigin", i."state" AS "ideaState",
           i."cancelledAt", i."analysisCompletedAt",
           i."analysisDeadlineAt", i."rawPurgedAt",
           i."rawCiphertext" IS NOT NULL AS "rawAvailable",
           i."sourceProvenanceCiphertext" IS NOT NULL AS "provenanceAvailable",
           (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    FROM "AmuxIdeaSessionAnalysisBudgetClaim" c
    JOIN "AmuxIdeaSessionAnalysisReservation" r ON r."id" = c."reservationId"
    JOIN "AmuxIdeaSubmission" i ON i."id" = r."ideaId"
    WHERE c."id" = ${claimId} AND c."reservationId" = ${reservationId}
      AND r."ideaId" = ${ideaId}
  `;
  if (rows.length !== 1) throw new AmuxSessionAnalysisStopReadError("not_found");
  const row = rows[0]!;
  if (!(row.now instanceof Date) || !Number.isFinite(row.now.getTime()) ||
      !(row.analysisDeadlineAt instanceof Date)) {
    throw new AmuxSessionAnalysisStopReadError("integrity_unavailable");
  }
  return { claimId, reservationId, stop: shouldAmuxSessionAnalysisStop(row) };
}

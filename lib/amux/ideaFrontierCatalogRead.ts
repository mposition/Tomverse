import "server-only";

import { Prisma } from "@prisma/client";

import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { prisma } from "@/lib/prisma";
import {
  verifyAmuxIdeaFrontierCatalog,
  type AmuxIdeaFrontierAuditRow,
  type AmuxIdeaFrontierCatalogRow,
} from "./ideaFrontierCatalogCore.ts";
import {
  checkAmuxIdeaFrontierSelection,
  type AmuxIdeaFrontierApproval,
  type AmuxIdeaFrontierSelectionDecision,
  type AmuxIdeaModelSelection,
} from "./ideaFrontierSelectionCore.ts";

type VerifiedCatalogRead =
  | { decision: "catalog_current"; approvals: AmuxIdeaFrontierApproval[]; databaseNow: Date }
  | { decision: "hold"; reason: string };

/**
 * Read-side pre-call check. Its result is a snapshot observation, not a lease
 * or permission to spawn a CLI; the future call boundary must repeat it after
 * binding the transfer receipt and before spending Agent budget. Prisma's
 * 15-second callback timeout is an app limit, not a DB-enforced transaction
 * bound; this path is read-only and records no late success.
 */
async function readVerifiedAmuxIdeaFrontierCatalog(): Promise<VerifiedCatalogRead> {
  const integrityKeys = adminAuditIntegrityKeys(process.env);
  if (integrityKeys.length === 0) {
    return { decision: "hold", reason: "model_catalog_unverified" };
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
      `;
      const rows = await tx.amuxIdeaFrontierModelApproval.findMany({
        take: 257,
        orderBy: [{ provider: "asc" }, { modelId: "asc" }, { version: "asc" }],
      });
      if (rows.length > 256) {
        return { decision: "hold", reason: "model_catalog_unverified" };
      }
      const catalogRows: AmuxIdeaFrontierCatalogRow[] = rows.map((row) => ({
        id: row.id,
        provider: row.provider as AmuxIdeaFrontierCatalogRow["provider"],
        modelId: row.modelId,
        allowedEfforts: row.allowedEfforts as AmuxIdeaFrontierCatalogRow["allowedEfforts"],
        version: row.version,
        status: row.status as AmuxIdeaFrontierCatalogRow["status"],
        approvedAt: row.approvedAt,
        approvedByUserId: row.approvedByUserId,
        approvalAuditLogId: row.approvalAuditLogId,
        revokedAt: row.revokedAt,
        revokedByUserId: row.revokedByUserId,
        revocationAuditLogId: row.revocationAuditLogId,
      }));
      const auditRows = await tx.adminAuditLog.findMany({
        // Query by target, not only the IDs still stored on the row. An
        // unreferenced revocation must be detected as a catalog conflict.
        where: {
          targetType: "AmuxIdeaFrontierModelApproval",
          targetId: { in: rows.map((row) => row.id) },
        },
        take: 513,
        select: {
          id: true, previousHash: true, actorUserId: true, actorEmail: true,
          action: true, targetType: true, targetId: true, summary: true,
          metadata: true, ipAddress: true, userAgent: true,
          entryHash: true, createdAt: true,
        },
      });
      if (auditRows.length > 512) {
        return { decision: "hold", reason: "model_catalog_unverified" };
      }
      const predecessorIds = auditRows.flatMap((row) =>
        row.previousHash ? [row.previousHash] : []);
      const predecessorRows = await tx.adminAuditLog.findMany({
        where: { entryHash: { in: predecessorIds } },
        select: { entryHash: true },
      });
      const audits: AmuxIdeaFrontierAuditRow[] = auditRows.map((row) => ({
        id: row.id,
        previousHash: row.previousHash,
        actorUserId: row.actorUserId,
        actorEmail: row.actorEmail,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        summary: row.summary,
        metadata: row.metadata ?? null,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        entryHash: row.entryHash,
        createdAt: row.createdAt.toISOString(),
      }));
      const catalog = verifyAmuxIdeaFrontierCatalog(
        catalogRows,
        audits,
        new Set(predecessorRows.flatMap((row) => row.entryHash ? [row.entryHash] : [])),
        integrityKeys,
      );
      if (!catalog.ok) {
        console.error("AMUX v4 frontier catalog rejected", { reason: catalog.reason });
        return { decision: "hold", reason: catalog.reason };
      }
      const databaseTime = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS "now"
      `;
      const databaseNow = databaseTime[0]?.now;
      if (!(databaseNow instanceof Date) || !Number.isFinite(databaseNow.getTime())) {
        return { decision: "hold", reason: "model_catalog_unverified" };
      }
      return { decision: "catalog_current", approvals: catalog.approvals, databaseNow };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 15_000,
    });
  } catch (error) {
    // A missing migration, lost DB connection or timeout cannot mean approved.
    const rawCode = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code : null;
    const code = typeof rawCode === "string" && /^[A-Z0-9_]{2,20}$/.test(rawCode)
      ? rawCode : "unknown";
    console.error("AMUX v4 frontier catalog read unavailable", { code });
    return { decision: "hold", reason: "model_catalog_unavailable" };
  }
}

/** Owner-visible eligibility snapshot only. The exact model and effort must
 * still be rechecked at confirmation and immediately before the CLI call. */
export async function listApprovedAmuxIdeaFrontierModels(): Promise<
  | { decision: "catalog_current"; models: Array<{
      approvalId: string; approvalVersion: number; provider: string;
      modelId: string; allowedEfforts: string[];
    }> }
  | { decision: "hold"; reason: string }
> {
  const catalog = await readVerifiedAmuxIdeaFrontierCatalog();
  if (catalog.decision !== "catalog_current") return catalog;
  return { decision: "catalog_current", models: catalog.approvals
    .filter((row) => row.status === "approved" && row.approvedAt <= catalog.databaseNow)
    .map((row) => ({ approvalId: row.id, approvalVersion: row.version,
      provider: row.provider, modelId: row.modelId,
      allowedEfforts: [...row.allowedEfforts] })) };
}

export async function readCurrentAmuxIdeaFrontierSelection(
  selected: AmuxIdeaModelSelection,
): Promise<AmuxIdeaFrontierSelectionDecision> {
  const catalog = await readVerifiedAmuxIdeaFrontierCatalog();
  if (catalog.decision !== "catalog_current") return catalog;
  return checkAmuxIdeaFrontierSelection(selected, catalog.approvals, catalog.databaseNow);
}

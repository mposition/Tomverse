import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import {
  AMUX_V4_FRONTIER_CATALOG_WRITE_ENV,
  AMUX_V4_FRONTIER_CATALOG_READ_ENV,
  decideFrontierCatalogApprovalVersion,
  frontierApprovalAuditMetadata,
  frontierCatalogWritePermitted,
  frontierCatalogReadPermitted,
  frontierRevocationAuditMetadata,
  type FrontierCatalogWriteRequest,
} from "@/lib/amux/ideaFrontierCatalogWriteCore";

const TARGET_TYPE = "AmuxIdeaFrontierModelApproval";
type Client = Prisma.TransactionClient;

export class FrontierCatalogWriteError extends Error {
  constructor(
    readonly code: "write_disabled" | "forbidden" | "audit_unavailable" |
      "catalog_revision_changed" | "catalog_state_unverified" |
      "request_already_seen" | "outcome_unknown" | "catalog_unavailable",
    readonly httpStatus: number,
    readonly approvalId?: string,
  ) {
    super(code);
    this.name = "FrontierCatalogWriteError";
  }
}

const requireOwner = (session: Session): string => {
  const userId = session.user?.id;
  if (!userId || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new FrontierCatalogWriteError("forbidden", 403);
  }
  return userId;
};

const databaseNow = async (tx: Client): Promise<Date> => {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"
  `;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new FrontierCatalogWriteError("catalog_unavailable", 503);
  }
  return now;
};

const setDatabaseTimeouts = async (tx: Client): Promise<void> => {
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
};

/** The same per-model advisory lock as the DB insert trigger. */
const lockModel = async (tx: Client, provider: string, modelId: string): Promise<void> => {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended('amux-v4-frontier:' || ${provider} || ':' || ${modelId}, 0)
    )
  `;
};

export type FrontierCatalogWriteResult = {
  approvalId: string;
  version: number;
  status: "approved" | "revoked";
  auditId: string;
};

/** Transaction body for synthetic DB tests; the public route remains latched. */
export async function commitFrontierCatalogDecision(
  tx: Client,
  input: { session: Session; request: Request; decision: FrontierCatalogWriteRequest },
): Promise<FrontierCatalogWriteResult> {
  const actorUserId = requireOwner(input.session);
  await setDatabaseTimeouts(tx);
  await takeAuditChainLock(tx);
  const decision = input.decision;
  if (decision.action === "approve") {
    await lockModel(tx, decision.provider, decision.modelId);
    const seenId = await tx.amuxIdeaFrontierModelApproval.findUnique({
      where: { id: decision.approvalId }, select: { id: true },
    });
    if (seenId) {
      throw new FrontierCatalogWriteError("request_already_seen", 409,
        decision.approvalId);
    }
    const latest = await tx.amuxIdeaFrontierModelApproval.findFirst({
      where: { provider: decision.provider, modelId: decision.modelId },
      orderBy: { version: "desc" },
      select: { version: true, status: true },
    });
    const versionDecision = decideFrontierCatalogApprovalVersion(
      latest,
      decision.expectedPreviousVersion,
    );
    if (versionDecision.decision !== "allow") {
      throw new FrontierCatalogWriteError(
        versionDecision.reason, versionDecision.decision === "conflict" ? 409 : 503,
        decision.approvalId,
      );
    }
    // The DB trigger replaces approvedAt with the audit row's createdAt.
    // `now` only satisfies the required Prisma insert shape.
    const now = await databaseNow(tx);
    const auditId = await writeAdminAuditLog({
      session: input.session, request: input.request,
      action: "amux.idea.frontier_model.approved",
      targetType: TARGET_TYPE, targetId: decision.approvalId,
      summary: "Owner approved one exact AMUX v4 Frontier model and effort set.",
      metadata: frontierApprovalAuditMetadata(decision, versionDecision.nextVersion),
      tx,
    });
    await tx.amuxIdeaFrontierModelApproval.create({
      data: {
        id: decision.approvalId,
        provider: decision.provider,
        modelId: decision.modelId,
        allowedEfforts: decision.allowedEfforts,
        version: versionDecision.nextVersion,
        status: "approved",
        approvedAt: now,
        approvedByUserId: actorUserId,
        approvalAuditLogId: auditId,
        updatedAt: now,
      },
    });
    return { approvalId: decision.approvalId,
      version: versionDecision.nextVersion, status: "approved", auditId };
  }

  // Read immutable model identity, then acquire the same advisory lock as
  // approval before taking a row lock. Recheck every mutable field below.
  const identity = await tx.amuxIdeaFrontierModelApproval.findUnique({
    where: { id: decision.approvalId },
    select: { provider: true, modelId: true },
  });
  if (!identity) {
    throw new FrontierCatalogWriteError("catalog_revision_changed", 409, decision.approvalId);
  }
  await lockModel(tx, identity.provider, identity.modelId);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaFrontierModelApproval"
    WHERE "id" = ${decision.approvalId} FOR UPDATE
  `;
  if (locked.length !== 1) {
    throw new FrontierCatalogWriteError("catalog_revision_changed", 409, decision.approvalId);
  }
  const row = await tx.amuxIdeaFrontierModelApproval.findUnique({
    where: { id: decision.approvalId },
  });
  if (!row || row.status !== "approved" || row.version !== decision.expectedVersion ||
      row.provider !== identity.provider || row.modelId !== identity.modelId ||
      row.revokedAt !== null || row.revokedByUserId !== null ||
      row.revocationAuditLogId !== null) {
    throw new FrontierCatalogWriteError("catalog_revision_changed", 409, decision.approvalId);
  }
  // The DB trigger replaces revokedAt with the audit row's createdAt.
  const now = await databaseNow(tx);
  const auditId = await writeAdminAuditLog({
    session: input.session, request: input.request,
    action: "amux.idea.frontier_model.revoked",
    targetType: TARGET_TYPE, targetId: row.id,
    summary: "Owner revoked one exact AMUX v4 Frontier model approval.",
    metadata: frontierRevocationAuditMetadata(row),
    tx,
  });
  await tx.amuxIdeaFrontierModelApproval.update({
    where: { id: row.id },
    data: {
      status: "revoked", revokedAt: now,
      revokedByUserId: actorUserId, revocationAuditLogId: auditId,
      updatedAt: now,
    },
  });
  return { approvalId: row.id, version: row.version, status: "revoked", auditId };
}

/** Never blind-retry after an ambiguous COMMIT. Owner reads the exact row. */
export async function writeFrontierCatalogDecision(input: {
  session: Session; request: Request; decision: FrontierCatalogWriteRequest;
}): Promise<FrontierCatalogWriteResult> {
  requireOwner(input.session);
  await assertRecentAdminAuthentication(input.session);
  if (!frontierCatalogWritePermitted(process.env[AMUX_V4_FRONTIER_CATALOG_WRITE_ENV])) {
    throw new FrontierCatalogWriteError("write_disabled", 503, input.decision.approvalId);
  }
  // Unknown COMMIT outcomes need an independent exact-ID read-back. Never
  // enable a writer whose read-back gate remains closed.
  if (!frontierCatalogReadPermitted(process.env[AMUX_V4_FRONTIER_CATALOG_READ_ENV])) {
    throw new FrontierCatalogWriteError("write_disabled", 503, input.decision.approvalId);
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new FrontierCatalogWriteError("audit_unavailable", 503, input.decision.approvalId);
  }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const result = await commitFrontierCatalogDecision(tx, input);
      callbackReturned = true;
      return result;
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (error instanceof FrontierCatalogWriteError) throw error;
    if (callbackReturned) {
      throw new FrontierCatalogWriteError("outcome_unknown", 503,
        input.decision.approvalId);
    }
    if (error && typeof error === "object" && "code" in error &&
        (error as { code?: unknown }).code === "P2002") {
      const candidate = error as { meta?: { modelName?: unknown; target?: unknown } };
      const idCollision = candidate.meta?.modelName === "AmuxIdeaFrontierModelApproval" &&
        Array.isArray(candidate.meta.target) && candidate.meta.target.length === 1 &&
        candidate.meta.target[0] === "id";
      throw new FrontierCatalogWriteError(
        idCollision ? "request_already_seen" : "catalog_revision_changed", 409,
        input.decision.approvalId,
      );
    }
    throw new FrontierCatalogWriteError("catalog_unavailable", 503,
      input.decision.approvalId);
  }
}

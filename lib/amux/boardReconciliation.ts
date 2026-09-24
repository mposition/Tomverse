import "server-only";

import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import { Prisma } from "@prisma/client";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  BOARD_IMPORT_EXPIRY_MS,
  BOARD_IMPORT_STATEMENT_TIMEOUT,
  BoardImportError,
  boardImportFailureIsAmbiguous,
} from "@/lib/amux/boardImportCore";
import {
  AMUX_RECONCILIATION_APPLY_ENV,
  AMUX_RECONCILIATION_PRESERVED_CARD,
  AMUX_RECONCILIATION_SOURCE_SYSTEM,
  type AmuxReconciliationPlan,
  amuxReconciliationApplyPermitted,
} from "@/lib/amux/boardReconciliationCore";
import { prisma } from "@/lib/prisma";

/**
 * Append-only source reconciliation writer.
 *
 * docs/policy/development-agent-orchestration.md (policy version 4).
 *
 * applyAmuxReconciliation checks the shipped latch before it opens a
 * transaction. commitAmuxReconciliation is the transaction body. The admin
 * route does not call the commit function. Accept inserts a revision and
 * then moves only the card pointer. Reject inserts a revision and leaves the
 * pointer. Source columns and lifecycle fields are not updated.
 */

const TARGET_TYPE = "AmuxReconciliationRun";

type LockedCard = {
  id: string;
  sourceKey: string;
  status: string;
  kind: string;
  priority: string;
  owner: string | null;
  claimedAt: Date | null;
  acceptedSourceRevisionId: string | null;
  sourceDigest: string | null;
  sourceVersion: string | null;
};

type LockedRevision = {
  id: string;
  workItemId: string;
  state: string;
  detailDigest: string;
  sectionCode: string;
};

export type AmuxReconciliationCommitResult = {
  outcome: "consumed";
  runId: string;
  auditId: string;
  acceptCount: number;
  rejectCount: number;
  writes: number;
};

const actorId = (session: Session): string => {
  const id = session.user?.id;
  if (!id) throw new BoardImportError("forbidden", 403);
  return id;
};

const prismaCode = (error: unknown): string | null => {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
};

const disconnectMessage = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : "";
  return /timeout|ECONNRESET|ECONNREFUSED|Connection terminated|closed the connection|Server has closed/i.test(
    message,
  );
};

const databaseNow = async (tx: Prisma.TransactionClient): Promise<Date> => {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = rows[0]?.now;
  const parsed = now instanceof Date ? now : new Date(now ?? Number.NaN);
  if (Number.isNaN(parsed.getTime())) throw new BoardImportError("audit_unbound", 500);
  return parsed;
};

const lifecyclePreserved = (card: LockedCard): boolean =>
  card.status === AMUX_RECONCILIATION_PRESERVED_CARD.status &&
  card.kind === AMUX_RECONCILIATION_PRESERVED_CARD.kind &&
  card.priority === AMUX_RECONCILIATION_PRESERVED_CARD.priority &&
  card.owner === AMUX_RECONCILIATION_PRESERVED_CARD.owner &&
  card.claimedAt === AMUX_RECONCILIATION_PRESERVED_CARD.claimedAt;

export async function commitAmuxReconciliation(
  tx: Prisma.TransactionClient,
  input: {
    session: Session;
    request: Request;
    plan: AmuxReconciliationPlan;
    runId: string;
  },
): Promise<AmuxReconciliationCommitResult> {
  const actorUserId = actorId(input.session);
  const plan = input.plan;
  const revisions = [...plan.revisions].sort((left, right) =>
    left.sourceKey < right.sourceKey ? -1 : left.sourceKey > right.sourceKey ? 1 : 0,
  );
  const cards = new Map<string, LockedCard>();
  const parents = new Map<string, LockedRevision>();
  if (revisions.length > 0) {
    const keys = revisions.map((entry) => entry.sourceKey);
    const locked = await tx.$queryRaw<LockedCard[]>`
      SELECT "id", "sourceKey", "status", "kind", "priority", "owner", "claimedAt",
             "acceptedSourceRevisionId", "sourceDigest", "sourceVersion"
      FROM "AmuxWorkItem"
      WHERE "sourceSystem" = ${AMUX_RECONCILIATION_SOURCE_SYSTEM}
        AND "archivedAt" IS NULL
        AND "sourceKey" IN (${Prisma.join(keys)})
      ORDER BY "sourceKey"
      FOR UPDATE
    `;
    if (locked.length !== keys.length) throw new BoardImportError("conflict", 409);
    for (const card of locked) cards.set(card.sourceKey, card);
    const pointerIds = locked.map((card) => card.acceptedSourceRevisionId).filter((id): id is string => id !== null);
    if (pointerIds.length !== locked.length) throw new BoardImportError("r0_missing", 409);
    const parentRows = await tx.$queryRaw<LockedRevision[]>`
      SELECT "id", "workItemId", "state", "detailDigest", "sectionCode"
      FROM "AmuxWorkItemSourceRevision"
      WHERE "id" IN (${Prisma.join(pointerIds)})
      FOR UPDATE
    `;
    for (const parent of parentRows) parents.set(parent.id, parent);
  }

  for (const revision of revisions) {
    const card = cards.get(revision.sourceKey);
    if (!card) throw new BoardImportError("conflict", 409);
    if (!lifecyclePreserved(card)) throw new BoardImportError("active_execution", 409);
    const parentId = card.acceptedSourceRevisionId;
    const parent = parentId ? parents.get(parentId) : undefined;
    if (!parent || parent.workItemId !== card.id || parent.state !== "accepted") {
      throw new BoardImportError("r0_missing", 409);
    }
    if (
      parent.detailDigest !== revision.storedDetailDigest ||
      parent.sectionCode !== revision.storedSectionCode ||
      card.sourceVersion !== revision.storedSourceVersion
    ) {
      throw new BoardImportError("conflict", 409);
    }
    if (
      parent.detailDigest === revision.observedDetailDigest &&
      parent.sectionCode === revision.observedSectionCode
    ) {
      throw new BoardImportError("not_drift", 409);
    }
  }

  const now = await databaseNow(tx);
  const expiresAt = new Date(now.getTime() + BOARD_IMPORT_EXPIRY_MS);
  await tx.$executeRaw`
    INSERT INTO "AmuxReconciliationRun" (
      "id", "status", "sourceCommit", "boardDigest", "manifestDigest",
      "canonicalizationVersion", "plannerVersion", "validatorVersion", "scannerVersion",
      "scannerRulesetDigest", "activeItemCount", "sectionCount", "itemDriftCount",
      "missingCount", "extraCount", "globalSnapshotDrift", "actorUserId",
      "preparedAt", "approvedAt", "applyingAt", "consumedAt", "expiresAt", "updatedAt"
    ) VALUES (
      ${input.runId}, ${"consumed"}, ${plan.sourceCommit}, ${plan.boardDigest}, ${plan.manifestDigest},
      ${plan.canonicalizationVersion}, ${plan.plannerVersion}, ${plan.validatorVersion}, ${plan.scannerVersion},
      ${plan.scannerRulesetDigest}, ${plan.activeItemCount}, ${plan.sectionCount}, ${plan.itemDriftCount},
      ${plan.missingCount}, ${plan.extraCount}, ${plan.globalSnapshotDrift}, ${actorUserId},
      ${now}, ${now}, ${now}, ${now}, ${expiresAt}, ${now}
    )
  `;
  const auditId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: "amux.reconciliation.consumed",
    targetType: TARGET_TYPE,
    targetId: input.runId,
    summary: "Consumed an AMUX source reconciliation.",
    metadata: plan.audit,
    tx,
  });
  const bound = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "AmuxReconciliationRun"
    SET "approvalAuditLogId" = ${auditId}, "updatedAt" = ${now}
    WHERE "id" = ${input.runId}
      AND "approvalAuditLogId" IS NULL
      AND "status" = ${"consumed"}
    RETURNING "id"
  `;
  if (bound.length !== 1) throw new BoardImportError("audit_unbound", 500);

  for (const revision of revisions) {
    const card = cards.get(revision.sourceKey);
    if (!card?.acceptedSourceRevisionId) throw new BoardImportError("conflict", 409);
    const revisionId = randomUUID();
    await tx.$executeRaw`
      INSERT INTO "AmuxWorkItemSourceRevision" (
        "id", "workItemId", "parentRevisionId", "sourceVersion", "detailDigest",
        "sectionCode", "reconciliationRunId", "state", "observedAt", "decidedAt",
        "decisionAuditLogId"
      ) VALUES (
        ${revisionId}, ${card.id}, ${card.acceptedSourceRevisionId}, ${revision.observedSourceVersion},
        ${revision.observedDetailDigest}, ${revision.observedSectionCode}, ${input.runId},
        ${revision.decision === "accept_new_source_revision" ? "accepted" : "rejected"},
        ${now}, ${now}, ${auditId}
      )
    `;
    if (revision.decision !== "accept_new_source_revision") continue;
    const moved = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "AmuxWorkItem"
      SET "acceptedSourceRevisionId" = ${revisionId}, "updatedAt" = ${now}
      WHERE "id" = ${card.id}
        AND "acceptedSourceRevisionId" = ${card.acceptedSourceRevisionId}
        AND "sourceDigest" IS NOT DISTINCT FROM ${card.sourceDigest}
        AND "sourceVersion" IS NOT DISTINCT FROM ${card.sourceVersion}
        AND "status" = ${AMUX_RECONCILIATION_PRESERVED_CARD.status}
        AND "kind" = ${AMUX_RECONCILIATION_PRESERVED_CARD.kind}
        AND "priority" = ${AMUX_RECONCILIATION_PRESERVED_CARD.priority}
        AND "owner" IS NULL
        AND "claimedAt" IS NULL
      RETURNING "id"
    `;
    if (moved.length !== 1) throw new BoardImportError("conflict", 409);
  }

  return {
    outcome: "consumed",
    runId: input.runId,
    auditId,
    acceptCount: plan.audit.acceptCount,
    rejectCount: plan.audit.rejectCount,
    writes: revisions.length + 1,
  };
}

export async function applyAmuxReconciliation(input: {
  session: Session;
  request: Request;
  plan: AmuxReconciliationPlan;
}): Promise<AmuxReconciliationCommitResult> {
  if (!amuxReconciliationApplyPermitted(process.env[AMUX_RECONCILIATION_APPLY_ENV])) {
    throw new BoardImportError("apply_disabled", 409);
  }
  const runId = randomUUID();
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${BOARD_IMPORT_STATEMENT_TIMEOUT}, true)`;
        return commitAmuxReconciliation(tx, { ...input, runId });
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
  } catch (error) {
    if (error instanceof BoardImportError) throw error;
    const code = prismaCode(error);
    if (code === "P2002") throw new BoardImportError("conflict", 409, runId);
    if (boardImportFailureIsAmbiguous(code) || disconnectMessage(error)) {
      throw new BoardImportError("outcome_unknown", 409, runId);
    }
    throw error;
  }
}

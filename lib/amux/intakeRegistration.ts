import "server-only";

import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  BOARD_IMPORT_STATEMENT_TIMEOUT,
  BoardImportError,
  boardImportFailureIsAmbiguous,
} from "@/lib/amux/boardImportCore";
import { AMUX_INTAKE_POLICY_VERSION } from "@/lib/amux/intakeCore";
import type { AmuxIntakeRegistrationPlan } from "@/lib/amux/intakeRegistrationCore";
import { AMUX_INTAKE_APPLY_ENV, amuxIntakeApplyPermitted } from "@/lib/amux/intakeCore";
import { prisma } from "@/lib/prisma";

/**
 * Intake registration writer.
 *
 * docs/policy/amux-intake.md (policy version 1).
 *
 * applyAmuxIntakeRegistration checks the shipped latch before it opens a
 * transaction. commitAmuxIntakeRegistration is the transaction body. The
 * admin route does not call the commit function.
 */

const TARGET_TYPE = "AmuxIntakeApproval";

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

const actorId = (session: Session): string => {
  const id = session.user?.id;
  if (!id) throw new BoardImportError("forbidden", 403);
  return id;
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

export type AmuxIntakeCommitResult = {
  created: boolean;
  cardId: string;
  approvalId: string | null;
  auditId: string | null;
};

export async function commitAmuxIntakeRegistration(
  tx: Prisma.TransactionClient,
  input: {
    session: Session;
    request: Request;
    plan: AmuxIntakeRegistrationPlan;
    approvalId: string;
  },
): Promise<AmuxIntakeCommitResult> {
  const actorUserId = actorId(input.session);
  const card = input.plan.card;
  const existing = await tx.amuxWorkItem.findUnique({
    where: {
      sourceSystem_sourceKey: { sourceSystem: card.sourceSystem, sourceKey: card.sourceKey },
    },
    select: { id: true, sourceDigest: true },
  });
  if (existing) {
    if (existing.sourceDigest === card.sourceDigest) {
      return { created: false, cardId: existing.id, approvalId: null, auditId: null };
    }
    throw new BoardImportError("conflict", 409, input.approvalId);
  }
  const now = await databaseNow(tx);
  const created = await tx.amuxWorkItem.create({
    data: {
      title: card.title,
      description: card.description,
      status: card.status,
      kind: card.kind,
      priority: card.priority,
      owner: card.owner,
      claimedAt: card.claimedAt,
      pinned: card.pinned,
      drag: card.drag,
      revision: card.revision,
      sourceSystem: card.sourceSystem,
      sourceKey: card.sourceKey,
      sourceVersion: card.sourceVersion,
      sourceDigest: card.sourceDigest,
      sourceSnapshot: card.sourceSnapshot,
      executionBrief: card.executionBrief,
      executionBriefDigest: card.executionBriefDigest,
    },
    select: { id: true },
  });
  const draftId = randomUUID();
  await tx.$executeRaw`
    INSERT INTO "AmuxIntakeDraft" (
      "id", "sourceSystem", "sourceKey", "sourceVersion", "draftDigest",
      "policyVersion", "status", "actorUserId", "title", "scope", "completion",
      "workItemId", "consumedAt", "expiresAt"
    ) VALUES (
      ${draftId}, ${card.sourceSystem}, ${card.sourceKey}, ${card.sourceVersion}, ${card.sourceDigest},
      ${AMUX_INTAKE_POLICY_VERSION}, ${input.plan.draftStatus}, ${actorUserId}, ${null}, ${null}, ${null},
      ${created.id}, ${now}, ${now}
    )
  `;
  const auditId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: input.plan.auditAction,
    targetType: TARGET_TYPE,
    targetId: input.approvalId,
    summary: "Consumed an explicit AMUX intake.",
    metadata: input.plan.audit,
    tx,
  });
  await tx.$executeRaw`
    INSERT INTO "AmuxIntakeApproval" (
      "id", "status", "actorUserId", "authorizationAuditLogId", "draftDigest",
      "sourceDigest", "policyVersion", "scannerVersion", "cardCount", "workItemId",
      "consumedAt", "updatedAt"
    ) VALUES (
      ${input.approvalId}, ${input.plan.approvalStatus}, ${actorUserId}, ${auditId}, ${card.sourceDigest},
      ${card.sourceDigest}, ${AMUX_INTAKE_POLICY_VERSION}, ${input.plan.audit.scannerVersion}, ${input.plan.audit.cardCount},
      ${created.id}, ${now}, ${now}
    )
  `;
  return { created: true, cardId: created.id, approvalId: input.approvalId, auditId };
}

export async function applyAmuxIntakeRegistration(input: {
  session: Session;
  request: Request;
  plan: AmuxIntakeRegistrationPlan;
}): Promise<AmuxIntakeCommitResult> {
  if (!amuxIntakeApplyPermitted(process.env[AMUX_INTAKE_APPLY_ENV])) {
    throw new BoardImportError("apply_disabled", 409);
  }
  const approvalId = randomUUID();
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${BOARD_IMPORT_STATEMENT_TIMEOUT}, true)`;
        return commitAmuxIntakeRegistration(tx, { ...input, approvalId });
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
  } catch (error) {
    if (error instanceof BoardImportError) throw error;
    const code = prismaCode(error);
    if (code === "P2002") throw new BoardImportError("conflict", 409, approvalId);
    if (boardImportFailureIsAmbiguous(code) || disconnectMessage(error)) {
      throw new BoardImportError("outcome_unknown", 409, approvalId);
    }
    throw error;
  }
}

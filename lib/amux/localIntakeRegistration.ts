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
import {
  LOCAL_INTAKE_APPLY_ENV,
  buildLocalIntakeSnapshot,
  localIntakeApplyPermitted,
} from "@/lib/amux/localIntakeCore";
import {
  classifyLocalIntakeReadBack,
  type LocalIntakeRegistrationPlan,
} from "@/lib/amux/localIntakeRegistrationCore";
import { prisma } from "@/lib/prisma";

/**
 * Local intake registration writer.
 *
 * docs/policy/amux-intake.md (policy version 3).
 *
 * applyLocalIntakeRegistration checks the shipped latch before it opens a
 * transaction. The latch ships false. commitLocalIntakeRegistration is the
 * transaction body and writes one backlog card, one normalized row, one
 * consumed approval and one human audit. It does not write a dependency, a
 * draft body, an execution brief, or any execution or credit row.
 */

const TARGET_TYPE = "AmuxLocalIntakeApproval";

export class LocalIntakeOutcomeUnknownError extends BoardImportError {
  readonly readBack: "absent" | "partial";
  readonly retry = false as const;

  constructor(approvalId: string, readBack: "absent" | "partial") {
    super("outcome_unknown", 409, approvalId);
    this.name = "LocalIntakeOutcomeUnknownError";
    this.readBack = readBack;
  }
}

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

export type LocalIntakeCommitResult = {
  created: boolean;
  cardId: string;
  approvalId: string | null;
  auditId: string | null;
};

export async function commitLocalIntakeRegistration(
  tx: Prisma.TransactionClient,
  input: {
    session: Session;
    request: Request;
    plan: LocalIntakeRegistrationPlan;
    approvalId: string;
  },
): Promise<LocalIntakeCommitResult> {
  if (input.plan.card.createsDependencyRows) throw new BoardImportError("schema_rejected", 400);
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
  const normalizedId = randomUUID();
  await tx.$executeRaw`
    INSERT INTO "AmuxLocalIntakeNormalized" (
      "id", "workItemId", "sourceSystem", "sourceKey", "normalizedDigest",
      "packageDigest", "snapshotDigest", "policyVersion", "schemaVersion",
      "scannerVersion", "priority", "normalized", "actorUserId", "createdAt"
    ) VALUES (
      ${normalizedId}, ${created.id}, ${card.sourceSystem}, ${card.sourceKey}, ${card.sourceDigest},
      ${card.sourceSnapshot.packageDigest}, ${card.sourceSnapshot.snapshotDigest},
      ${input.plan.audit.policyVersion}, ${input.plan.audit.schemaVersion},
      ${input.plan.audit.scannerVersion}, ${card.priority},
      ${JSON.stringify(card.normalized)}::jsonb, ${actorUserId}, ${now}
    )
  `;
  const auditId = await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: input.plan.auditAction,
    targetType: TARGET_TYPE,
    targetId: input.approvalId,
    summary: "Consumed one local AMUX intake card.",
    metadata: { ...input.plan.audit, approvalId: input.approvalId },
    tx,
  });
  await tx.$executeRaw`
    INSERT INTO "AmuxLocalIntakeApproval" (
      "id", "status", "actorUserId", "authorizationAuditLogId", "draftDigest",
      "sourceDigest", "policyVersion", "scannerVersion", "cardCount", "workItemId",
      "consumedAt", "updatedAt"
    ) VALUES (
      ${input.approvalId}, ${input.plan.approvalStatus}, ${actorUserId}, ${auditId}, ${card.sourceDigest},
      ${card.sourceDigest}, ${input.plan.audit.policyVersion}, ${input.plan.audit.scannerVersion},
      ${input.plan.audit.cardCount}, ${created.id}, ${now}, ${now}
    )
  `;
  return { created: true, cardId: created.id, approvalId: input.approvalId, auditId };
}

type IntakeReadDb = Pick<Prisma.TransactionClient, "$queryRaw" | "amuxWorkItem">;

export async function readLocalIntakeRegistration(
  plan: LocalIntakeRegistrationPlan,
  db: IntakeReadDb = prisma,
): Promise<
  | { kind: "committed"; cardId: string; approvalId: string; auditId: string }
  | { kind: "absent" }
  | { kind: "partial" }
> {
  const card = plan.card;
  const stored = await db.amuxWorkItem.findUnique({
    where: {
      sourceSystem_sourceKey: { sourceSystem: card.sourceSystem, sourceKey: card.sourceKey },
    },
    select: { id: true, sourceDigest: true },
  });
  const normalized = await db.$queryRaw<Array<{ normalizedDigest: string }>>`
    SELECT "normalizedDigest" FROM "AmuxLocalIntakeNormalized"
    WHERE "sourceSystem" = ${card.sourceSystem} AND "sourceKey" = ${card.sourceKey}
  `;
  const approvals = stored
    ? await db.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "AmuxLocalIntakeApproval"
        WHERE "workItemId" = ${stored.id}
          AND "draftDigest" = ${card.sourceDigest}
          AND "status" = 'consumed'
      `
    : [];
  const audits = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AdminAuditLog"
    WHERE "action" = ${plan.auditAction} AND "metadata"->>'draftDigest' = ${card.sourceDigest}
  `;
  const matchingNormalized = normalized.filter((row) => row.normalizedDigest === card.sourceDigest);
  const classified = classifyLocalIntakeReadBack(
    {
      cardDigest: stored?.sourceDigest ?? null,
      matchingNormalized: matchingNormalized.length,
      matchingApprovals: approvals.length,
      matchingAudits: audits.length,
      otherRows: normalized.length - matchingNormalized.length,
    },
    card.sourceDigest,
  );
  const approval = approvals[0];
  const audit = audits[0];
  if (classified === "committed" && stored && approval && audit) {
    return { kind: "committed", cardId: stored.id, approvalId: approval.id, auditId: audit.id };
  }
  return { kind: classified === "committed" ? "partial" : classified };
}

export async function applyLocalIntakeRegistration(input: {
  session: Session;
  request: Request;
  plan: LocalIntakeRegistrationPlan;
}): Promise<LocalIntakeCommitResult> {
  if (!localIntakeApplyPermitted(process.env[LOCAL_INTAKE_APPLY_ENV])) {
    throw new BoardImportError("apply_disabled", 409);
  }
  const approvalId = randomUUID();
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${BOARD_IMPORT_STATEMENT_TIMEOUT}, true)`;
        return commitLocalIntakeRegistration(tx, { ...input, approvalId });
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
  } catch (error) {
    if (error instanceof BoardImportError) throw error;
    const code = prismaCode(error);
    if (code === "P2002") throw new BoardImportError("conflict", 409, approvalId);
    if (boardImportFailureIsAmbiguous(code) || disconnectMessage(error)) {
      let readBack: "absent" | "partial" = "partial";
      try {
        const seen = await readLocalIntakeRegistration(input.plan);
        if (seen.kind === "committed") {
          return { created: false, cardId: seen.cardId, approvalId: seen.approvalId, auditId: seen.auditId };
        }
        readBack = seen.kind;
      } catch {
        readBack = "partial";
      }
      throw new LocalIntakeOutcomeUnknownError(approvalId, readBack);
    }
    throw error;
  }
}

/** Read-only board snapshot. Description, briefs, audits and credentials stay out. */
export async function readLocalIntakeBoardSnapshot(generatedAt: string) {
  const rows = await prisma.amuxWorkItem.findMany({
    where: { archivedAt: null },
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      kind: true,
      sourceDigest: true,
    },
    orderBy: { id: "asc" },
    take: 257,
  });
  if (rows.length > 256) return { ok: false as const, code: "snapshot_too_large" };
  const dependencies =
    rows.length === 0
      ? []
      : await prisma.amuxWorkDependency.findMany({
          where: { taskId: { in: rows.map((row) => row.id) } },
          select: { taskId: true, dependencyId: true },
        });
  const byTask = new Map<string, string[]>();
  for (const edge of dependencies) {
    const list = byTask.get(edge.taskId) ?? [];
    list.push(edge.dependencyId);
    byTask.set(edge.taskId, list);
  }
  return buildLocalIntakeSnapshot(
    rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      priority: row.priority,
      kind: row.kind,
      summary: row.title,
      dependencyIds: byTask.get(row.id) ?? [],
      sourceDigest: row.sourceDigest,
    })),
    generatedAt,
  );
}

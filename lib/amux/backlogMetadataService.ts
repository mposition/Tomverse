import "server-only";

import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { SYSTEM_AUDIT_ACTOR_METADATA_KEY } from "@/lib/adminAuditSystemActors";
import {
  BOARD_IMPORT_STATEMENT_TIMEOUT,
  BoardImportError,
  boardImportAuditEntryHashMatches,
  boardImportAuditKeysPresent,
  boardImportFailureIsAmbiguous,
} from "@/lib/amux/boardImportCore";
import {
  BACKLOG_METADATA_APPLY_ENV,
  BACKLOG_METADATA_AUDIT_ACTION,
  BACKLOG_METADATA_AUDIT_KEYS,
  BACKLOG_METADATA_CODE_LATCH,
  BACKLOG_METADATA_POLICY_VERSION,
  type BacklogMetadataAuditMetadata,
  type BacklogMetadataCardFact,
  type BacklogMetadataRequest,
  BacklogMetadataConflict,
  backlogMetadataApplyPermitted,
  backlogMetadataAuditMetadata,
  backlogMetadataCardWrite,
  backlogMetadataRefusal,
  parseBacklogMetadataRequest,
} from "@/lib/amux/backlogMetadataCore";
import { prisma } from "@/lib/prisma";

/**
 * Backlog card metadata writer.
 *
 * docs/policy/development-agent-orchestration.md (orchestration policy
 * version 15, "backlog 카드 메타데이터 writer").
 *
 * Preview writes nothing. Apply throws before a transaction unless the
 * environment value is exactly `enabled` and the code latch is true. One
 * transaction writes the card's kind, priority, cost estimate and revision + 1
 * together with one human audit row. It never writes status, owner, brief,
 * attempts, deliveries or route decisions.
 */

const TARGET_TYPE = "AmuxWorkItem";
const SHA256 = /^[a-f0-9]{64}$/;

const summaries: Record<string, string> = {
  [BACKLOG_METADATA_AUDIT_ACTION]: "Updated AMUX backlog card metadata.",
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

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * True only when the environment value is exactly `enabled` and the shipped
 * code latch is true. Takes no argument, so no caller can supply the latch.
 */
export const backlogMetadataApplyOpen = (): boolean =>
  backlogMetadataApplyPermitted({
    envValue: process.env[BACKLOG_METADATA_APPLY_ENV],
    codeLatch: BACKLOG_METADATA_CODE_LATCH,
  });

const withBacklogMetadataTransaction = async <T>(
  cardId: string,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  if (!boardImportAuditKeysPresent(adminAuditIntegrityKeys(process.env).length)) {
    throw new BoardImportError("audit_key_missing", 503, cardId);
  }
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${BOARD_IMPORT_STATEMENT_TIMEOUT}, true)`;
        return run(tx);
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
  } catch (error) {
    if (error instanceof BoardImportError) throw error;
    const code = prismaCode(error);
    if (code === "P2002") throw new BoardImportError("conflict", 409, cardId);
    if (boardImportFailureIsAmbiguous(code) || disconnectMessage(error)) {
      // The conditional write is bound to the expected revision, so a second
      // apply after a committed first one is refused as revision_mismatch.
      // The operator reads the card back; nothing here retries.
      throw new BoardImportError("outcome_unknown", 409, cardId);
    }
    throw error;
  }
};

const requireBoundAudit = async (
  tx: Prisma.TransactionClient,
  auditId: string,
  expected: { actorUserId: string; targetId: string },
) => {
  const row = await tx.adminAuditLog.findUnique({
    where: { id: auditId },
    select: {
      actorUserId: true,
      actorEmail: true,
      action: true,
      targetType: true,
      targetId: true,
      summary: true,
      metadata: true,
      ipAddress: true,
      userAgent: true,
      entryHash: true,
      previousHash: true,
      createdAt: true,
    },
  });
  if (
    !row ||
    row.action !== BACKLOG_METADATA_AUDIT_ACTION ||
    row.targetType !== TARGET_TYPE ||
    row.targetId !== expected.targetId ||
    typeof row.entryHash !== "string" ||
    !SHA256.test(row.entryHash) ||
    !(row.createdAt instanceof Date) ||
    row.actorUserId !== expected.actorUserId
  ) {
    throw new BoardImportError("audit_unbound", 500, expected.targetId);
  }
  const metadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : null;
  if (!metadata || typeof metadata[SYSTEM_AUDIT_ACTOR_METADATA_KEY] === "string") {
    throw new BoardImportError("audit_unbound", 500, expected.targetId);
  }
  for (const key of Object.keys(metadata)) {
    if (!(BACKLOG_METADATA_AUDIT_KEYS as readonly string[]).includes(key)) {
      throw new BoardImportError("audit_unbound", 500, expected.targetId);
    }
  }
  const hashMatches = boardImportAuditEntryHashMatches(
    {
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
      createdAt: row.createdAt.toISOString(),
    },
    row.entryHash,
    adminAuditIntegrityKeys(process.env),
  );
  if (!hashMatches) throw new BoardImportError("audit_unbound", 500, expected.targetId);
  if (row.previousHash !== null) {
    if (typeof row.previousHash !== "string" || !SHA256.test(row.previousHash)) {
      throw new BoardImportError("audit_unbound", 500, expected.targetId);
    }
    const previous = await tx.adminAuditLog.findFirst({
      where: { entryHash: row.previousHash },
      select: { id: true },
    });
    if (!previous) throw new BoardImportError("audit_unbound", 500, expected.targetId);
  }
};

const writeHumanAudit = async (
  tx: Prisma.TransactionClient,
  session: Session,
  request: Request,
  metadata: BacklogMetadataAuditMetadata,
) => {
  const auditId = await writeAdminAuditLog({
    session,
    request,
    action: BACKLOG_METADATA_AUDIT_ACTION,
    targetType: TARGET_TYPE,
    targetId: metadata.cardId,
    summary: summaries[BACKLOG_METADATA_AUDIT_ACTION],
    metadata,
    tx,
  });
  await requireBoundAudit(tx, auditId, { actorUserId: actorId(session), targetId: metadata.cardId });
  return auditId;
};

const loadFact = async (db: Db, cardId: string): Promise<BacklogMetadataCardFact | null> =>
  db.amuxWorkItem.findUnique({
    where: { id: cardId },
    select: {
      id: true,
      revision: true,
      status: true,
      owner: true,
      claimedAt: true,
      archivedAt: true,
      executionBriefDigest: true,
      kind: true,
      priority: true,
      estimatedCostMicrousd: true,
    },
  });

export async function previewBacklogMetadata(raw: string) {
  const applyPermitted = backlogMetadataApplyOpen();
  const parsed = parseBacklogMetadataRequest(raw);
  if (!parsed.ok) {
    return {
      policyVersion: BACKLOG_METADATA_POLICY_VERSION,
      valid: false,
      code: parsed.code,
      refusal: null,
      applyPermitted,
    };
  }
  const refusal = backlogMetadataRefusal(parsed.request, await loadFact(prisma, parsed.request.cardId));
  return {
    policyVersion: BACKLOG_METADATA_POLICY_VERSION,
    valid: refusal === null,
    code: null,
    refusal,
    cardId: parsed.request.cardId,
    applyPermitted,
  };
}

/**
 * The transaction body. Exported for the database test, which calls it inside
 * its own transaction the way the recommendation pool test does. The public
 * entry point is `applyBacklogMetadata`, which refuses before a transaction
 * opens unless apply is permitted.
 */
export async function commitBacklogMetadata(
  tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; update: BacklogMetadataRequest },
) {
  const { update } = input;
  // Lock the row first so the previous values the audit records are the ones
  // this conditional write replaces.
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxWorkItem" WHERE "id" = ${update.cardId} FOR UPDATE
  `;
  const before = await loadFact(tx, update.cardId);
  const write = backlogMetadataCardWrite(update);
  const updated = await tx.amuxWorkItem.updateMany({ where: write.where, data: write.data });
  const refusal = backlogMetadataRefusal(update, before);
  if (updated.count !== 1 || refusal !== null || !before) {
    // Throwing rolls the transaction back, including a write the pure
    // classifier disagrees with.
    throw new BacklogMetadataConflict(refusal ?? "revision_mismatch");
  }
  const metadata = backlogMetadataAuditMetadata(before, update);
  await writeHumanAudit(tx, input.session, input.request, metadata);
  const written = await tx.amuxWorkItem.findUnique({
    where: { id: update.cardId },
    select: { status: true, kind: true, priority: true, estimatedCostMicrousd: true, revision: true },
  });
  const expectedCost = update.estimatedCostMicrousd === null ? null : BigInt(update.estimatedCostMicrousd);
  if (
    !written ||
    written.status !== "backlog" ||
    written.kind !== update.kind ||
    written.priority !== update.priority ||
    written.estimatedCostMicrousd !== expectedCost ||
    written.revision !== metadata.revision
  ) {
    throw new BoardImportError("write_unverified", 500, update.cardId);
  }
  return {
    status: "updated" as const,
    cardId: update.cardId,
    kind: update.kind,
    priority: update.priority,
    costPresent: metadata.estimatedCostMicrousd !== null,
    revision: metadata.revision,
  };
}

export async function applyBacklogMetadata(input: { session: Session; request: Request; raw: string }) {
  if (!backlogMetadataApplyOpen()) {
    throw new BoardImportError("apply_disabled", 409);
  }
  const parsed = parseBacklogMetadataRequest(input.raw);
  if (!parsed.ok) throw new BoardImportError(parsed.code, 400);
  const update = parsed.request;
  return withBacklogMetadataTransaction(update.cardId, (tx) =>
    commitBacklogMetadata(tx, { session: input.session, request: input.request, update }),
  );
}

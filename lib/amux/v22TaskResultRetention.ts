import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { AmuxContentRetirementError, recordAmuxContentBodyPurge,
  retireVerifiedAmuxContentKey, type AmuxRetirableContent } from
  "./ideaContentKeyRetirementService.ts";
import { amuxContentUnitKeyId } from "./ideaKeyStore.ts";
import { amuxIdeaHasActiveRetentionHold } from "./ideaRetentionHoldRead.ts";

const BATCH_SIZE = 8;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function v22TaskResultDueAt(input: { createdAt: Date;
  status: string; terminalAt: Date | null; archivedAt: Date | null;
  updatedAt: Date }): Date | null {
  const terminal = input.archivedAt ??
    (["done", "cancelled"].includes(input.status) ?
      input.terminalAt ?? input.updatedAt : null);
  return terminal ? new Date(Math.max(terminal.getTime(),
    input.createdAt.getTime()) + RETENTION_MS) : null;
}

async function purgeOne(tx: Prisma.TransactionClient, attemptId: string) {
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const found = await tx.amuxV22TaskResult.findUnique({
    where: { attemptId }, select: { ideaId: true, taskId: true },
  });
  if (!found) return false;
  await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${found.ideaId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "AmuxWorkItem"
    WHERE "id" = ${found.taskId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "attemptId" FROM "AmuxV22TaskResult"
    WHERE "attemptId" = ${attemptId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "attemptId" FROM "AmuxV22TaskPatch"
    WHERE "attemptId" = ${attemptId} FOR UPDATE`;
  const [row, patch, task, nowRows] = await Promise.all([
    tx.amuxV22TaskResult.findUnique({ where: { attemptId } }),
    tx.amuxV22TaskPatch.findUnique({ where: { attemptId } }),
    tx.amuxWorkItem.findUnique({ where: { id: found.taskId },
      select: { status: true, v4TerminalAt: true, archivedAt: true,
        updatedAt: true } }),
    tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"`,
  ]);
  const now = nowRows[0]?.now;
  if (!row || !task || !now || row.bodyPurgedAt || !row.ciphertext)
    return false;
  const due = v22TaskResultDueAt({ createdAt: row.createdAt,
    status: task.status, terminalAt: task.v4TerminalAt,
    archivedAt: task.archivedAt, updatedAt: task.updatedAt });
  if (!due || due > now ||
      await amuxIdeaHasActiveRetentionHold(tx, row.ideaId, now)) return false;
  const target: AmuxRetirableContent = { ideaId: row.ideaId,
    purpose: "task_result", subjectId: attemptId };
  const patchTarget: AmuxRetirableContent | null = patch ?
    { ideaId: row.ideaId, purpose: "task_patch", subjectId: attemptId } :
    null;
  if (row.keyId !== amuxContentUnitKeyId(target) || row.keyVersion !== 1)
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  if (patch && patchTarget && (patch.ideaId !== row.ideaId ||
      patch.taskId !== row.taskId || patch.bodyPurgedAt ||
      !patch.ciphertext || patch.keyId !== amuxContentUnitKeyId(patchTarget) ||
      patch.keyVersion !== 1))
    throw new AmuxContentRetirementError("integrity_unavailable", patchTarget);
  if (patch && patchTarget) {
    const patched = await tx.amuxV22TaskPatch.updateMany({
      where: { attemptId, ideaId: row.ideaId, bodyPurgedAt: null,
        ciphertext: { not: null } },
      data: { ciphertext: null, keyId: null, keyVersion: null,
        bodyPurgedAt: now },
    });
    if (patched.count !== 1)
      throw new AmuxContentRetirementError("integrity_unavailable",
        patchTarget);
  }
  const changed = await tx.amuxV22TaskResult.updateMany({
    where: { attemptId, ideaId: row.ideaId, bodyPurgedAt: null,
      ciphertext: { not: null } },
    data: { ciphertext: null, keyId: null, keyVersion: null,
      bodyPurgedAt: now },
  });
  if (changed.count !== 1)
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  await recordAmuxContentBodyPurge(tx, target, now,
    row.digest, row.digestKeyId);
  if (patch && patchTarget)
    await recordAmuxContentBodyPurge(tx, patchTarget, now,
      patch.digest, patch.digestKeyId);
  return true;
}

/** Bounded retention tick; an uncertain database or key deletion stops work. */
export async function purgeDueAmuxV22TaskResults() {
  const pending = await prisma.amuxIdeaContentKeyRetirement.findMany({
    where: { purpose: { in: ["task_result", "task_patch"] },
      keyDeletedAt: null },
    orderBy: [{ bodyPurgedAt: "asc" }], take: BATCH_SIZE,
    select: { ideaId: true, purpose: true, subjectId: true },
  });
  let keysDeleted = 0;
  for (const row of pending) {
    await retireVerifiedAmuxContentKey(row as AmuxRetirableContent);
    keysDeleted += 1;
  }
  if (pending.length === BATCH_SIZE)
    return { bodiesPurged: 0, keysDeleted, scanned: pending.length };
  const now = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"`;
  if (!(now[0]?.now instanceof Date))
    throw new AmuxContentRetirementError("integrity_unavailable");
  const cutoff = new Date(now[0].now.getTime() - RETENTION_MS);
  const candidates = await prisma.amuxV22TaskResult.findMany({
    where: { ciphertext: { not: null }, bodyPurgedAt: null,
      task: { OR: [
        { archivedAt: { lte: cutoff } },
        { status: { in: ["done", "cancelled"] },
          v4TerminalAt: { lte: cutoff } },
        { status: { in: ["done", "cancelled"] },
          v4TerminalAt: null, updatedAt: { lte: cutoff } },
      ] } },
    orderBy: [{ createdAt: "asc" }], take: BATCH_SIZE,
    select: { attemptId: true },
  });
  let bodiesPurged = 0;
  for (const row of candidates) {
    if (await prisma.$transaction((tx) => purgeOne(tx, row.attemptId),
      { maxWait: 3_000, timeout: 12_000 })) bodiesPurged += 1;
  }
  return { bodiesPurged, keysDeleted, scanned: candidates.length };
}

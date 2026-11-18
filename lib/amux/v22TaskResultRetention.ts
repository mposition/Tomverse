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

/** A sealed row without its body: a large result cannot be read whole
 * (lib/amux/sealedByteaRead.ts), and the body CHECK ties a present body to a
 * set key and a null bodyPurgedAt, so these columns say whether it is there. */
const SEALED_META = { ideaId: true, taskId: true, keyId: true, keyVersion: true,
  digest: true, digestKeyId: true, createdAt: true, bodyPurgedAt: true } as const;

export function v22TaskResultDueAt(input: { createdAt: Date;
  status: string; terminalAt: Date | null; archivedAt: Date | null;
  updatedAt: Date }): Date | null {
  const terminal = input.archivedAt ??
    (["done", "cancelled"].includes(input.status) ?
      input.terminalAt ?? input.updatedAt : null);
  return terminal ? new Date(Math.max(terminal.getTime(),
    input.createdAt.getTime()) + RETENTION_MS) : null;
}

const hasBody = (row: { bodyPurgedAt: Date | null; keyId: string | null }) =>
  row.bodyPurgedAt === null && row.keyId !== null;

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
  await tx.$queryRaw`SELECT "attemptId" FROM "AmuxV52ReviewFindings"
    WHERE "attemptId" = ${attemptId} FOR UPDATE`;
  const [row, patch, findings, task, nowRows] = await Promise.all([
    tx.amuxV22TaskResult.findUnique({ where: { attemptId }, select: SEALED_META }),
    tx.amuxV22TaskPatch.findUnique({ where: { attemptId }, select: SEALED_META }),
    tx.amuxV52ReviewFindings.findUnique({ where: { attemptId }, select: SEALED_META }),
    tx.amuxWorkItem.findUnique({ where: { id: found.taskId },
      select: { status: true, v4TerminalAt: true, archivedAt: true,
        updatedAt: true } }),
    tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"`,
  ]);
  const now = nowRows[0]?.now;
  if (!row || !task || !now || !hasBody(row))
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
  // A rejected review's findings are kept as long as the attempt's result
  // (owner decision 2026-11-15) and go with it, key deletion queued the same way.
  const findingsTarget: AmuxRetirableContent | null = findings ?
    { ideaId: row.ideaId, purpose: "review_findings", subjectId: attemptId } : null;
  if (row.keyId !== amuxContentUnitKeyId(target) || row.keyVersion !== 1)
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  if (findings && findingsTarget && (findings.ideaId !== row.ideaId ||
      findings.taskId !== row.taskId || !hasBody(findings) ||
      findings.keyId !== amuxContentUnitKeyId(findingsTarget) ||
      findings.keyVersion !== 1))
    throw new AmuxContentRetirementError("integrity_unavailable", findingsTarget);
  if (patch && patchTarget && (patch.ideaId !== row.ideaId ||
      patch.taskId !== row.taskId || !hasBody(patch) ||
      patch.keyId !== amuxContentUnitKeyId(patchTarget) ||
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
  if (findings && findingsTarget) {
    const cleared = await tx.amuxV52ReviewFindings.updateMany({
      where: { attemptId, ideaId: row.ideaId, bodyPurgedAt: null,
        ciphertext: { not: null } },
      data: { ciphertext: null, keyId: null, keyVersion: null,
        bodyPurgedAt: now },
    });
    if (cleared.count !== 1)
      throw new AmuxContentRetirementError("integrity_unavailable",
        findingsTarget);
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
  if (findings && findingsTarget)
    await recordAmuxContentBodyPurge(tx, findingsTarget, now,
      findings.digest, findings.digestKeyId);
  return true;
}

/**
 * One attempt's changed-path list (lib/amux/v22ChangedPathsStore.ts), on the
 * result's 90-day rule but on its own: a run that left no result still has
 * its paths. The same lock order as the result's purge.
 */
async function purgeChangedPathsOne(tx: Prisma.TransactionClient, attemptId: string) {
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const found = await tx.amuxV22TaskChangedPaths.findUnique({
    where: { attemptId }, select: { ideaId: true, taskId: true } });
  if (!found) return false;
  await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${found.ideaId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "AmuxWorkItem"
    WHERE "id" = ${found.taskId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "attemptId" FROM "AmuxV22TaskChangedPaths"
    WHERE "attemptId" = ${attemptId} FOR UPDATE`;
  const [row, task, nowRows] = await Promise.all([
    tx.amuxV22TaskChangedPaths.findUnique({ where: { attemptId }, select: SEALED_META }),
    tx.amuxWorkItem.findUnique({ where: { id: found.taskId },
      select: { status: true, v4TerminalAt: true, archivedAt: true,
        updatedAt: true } }),
    tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"`,
  ]);
  const now = nowRows[0]?.now;
  if (!row || !task || !now || !hasBody(row)) return false;
  const due = v22TaskResultDueAt({ createdAt: row.createdAt,
    status: task.status, terminalAt: task.v4TerminalAt,
    archivedAt: task.archivedAt, updatedAt: task.updatedAt });
  if (!due || due > now ||
      await amuxIdeaHasActiveRetentionHold(tx, row.ideaId, now)) return false;
  const target: AmuxRetirableContent = { ideaId: row.ideaId,
    purpose: "task_changed_paths", subjectId: attemptId };
  if (row.keyId !== amuxContentUnitKeyId(target) || row.keyVersion !== 1)
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  const cleared = await tx.amuxV22TaskChangedPaths.updateMany({
    where: { attemptId, ideaId: row.ideaId, bodyPurgedAt: null,
      ciphertext: { not: null } },
    data: { ciphertext: null, keyId: null, keyVersion: null, bodyPurgedAt: now },
  });
  if (cleared.count !== 1)
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  await recordAmuxContentBodyPurge(tx, target, now, row.digest, row.digestKeyId);
  return true;
}

const dueTask = (cutoff: Date) => ({ OR: [
  { archivedAt: { lte: cutoff } },
  { status: { in: ["done", "cancelled"] }, v4TerminalAt: { lte: cutoff } },
  { status: { in: ["done", "cancelled"] }, v4TerminalAt: null,
    updatedAt: { lte: cutoff } },
] });

/** Bounded retention tick; an uncertain database or key deletion stops work. */
export async function purgeDueAmuxV22TaskResults() {
  const pending = await prisma.amuxIdeaContentKeyRetirement.findMany({
    where: { purpose: { in: ["task_result", "task_patch", "task_changed_paths",
      "review_findings"] }, keyDeletedAt: null },
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
    where: { ciphertext: { not: null }, bodyPurgedAt: null, task: dueTask(cutoff) },
    orderBy: [{ createdAt: "asc" }], take: BATCH_SIZE,
    select: { attemptId: true },
  });
  let bodiesPurged = 0;
  for (const row of candidates) {
    if (await prisma.$transaction((tx) => purgeOne(tx, row.attemptId),
      { maxWait: 3_000, timeout: 12_000 })) bodiesPurged += 1;
  }
  const pathCandidates = await prisma.amuxV22TaskChangedPaths.findMany({
    where: { ciphertext: { not: null }, bodyPurgedAt: null, task: dueTask(cutoff) },
    orderBy: [{ createdAt: "asc" }], take: BATCH_SIZE,
    select: { attemptId: true },
  });
  let pathListsPurged = 0;
  for (const row of pathCandidates) {
    if (await prisma.$transaction((tx) => purgeChangedPathsOne(tx, row.attemptId),
      { maxWait: 3_000, timeout: 12_000 })) pathListsPurged += 1;
  }
  return { bodiesPurged, pathListsPurged, keysDeleted,
    scanned: candidates.length + pathCandidates.length };
}

import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "../adminAudit.ts";
import { openAmuxContent, sealAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import { amuxContentUnitKeyId, createAmuxContentUnitKeys,
  deleteAmuxContentUnitKey, loadAmuxContentUnitKeys } from "./ideaKeyStore.ts";
import { AmuxContentRetirementError, recordAmuxContentBodyPurge } from
  "./ideaContentKeyRetirementService.ts";
import { amuxIdeaHasActiveRetentionHold } from "./ideaRetentionHoldRead.ts";
import { prisma } from "../prisma.ts";
import {
  AMUX_V19_READ_MANIFEST_AUDIT_ACTOR,
  AMUX_V19_READ_MANIFEST_AUDIT_SUMMARY,
  AMUX_V19_READ_MANIFEST_RECORDED_ACTION,
  AMUX_V19_READ_MANIFEST_RECORDED_TARGET,
  amuxTrackedCheckoutReadManifestAuditMetadata,
  inspectAmuxTrackedCheckoutReadManifest,
  parseAmuxTrackedCheckoutReadManifest,
  type AmuxTrackedCheckoutVerifiedReadInput,
} from "./ideaTrackedCheckoutReadManifestCore.ts";

export class AmuxTrackedCheckoutReadManifestError extends Error {
  constructor(readonly code: "invalid_manifest" | "idea_unavailable" |
    "evidence_unavailable" | "already_recorded") {
    super(code);
    this.name = "AmuxTrackedCheckoutReadManifestError";
  }
}

function referenceAlreadyRecorded(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { modelName?: unknown;
    target?: unknown } };
  return candidate.code === "P2002" &&
    candidate.meta?.modelName === "AmuxIdeaTrackedCheckoutReadManifest" &&
    Array.isArray(candidate.meta.target) &&
    candidate.meta.target.length === 2 &&
    candidate.meta.target[0] === "ideaId" &&
    candidate.meta.target[1] === "referenceOrdinal";
}

export function amuxTrackedCheckoutReadManifestKeyIdentity(
  ideaId: string, manifestId: string,
) {
  return { ideaId, purpose: "repository_read_manifest" as const,
    subjectId: manifestId };
}

export const AMUX_READ_MANIFEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function amuxReadManifestDueAt(submittedAt: Date): Date {
  return new Date(submittedAt.getTime() + AMUX_READ_MANIFEST_RETENTION_MS);
}

/** The only DB writer of the read-manifest table. Its guarded purge keeps
 * the count, keyed digest, and immutable original audit. */
export async function commitAmuxDueReadManifestPurge(tx: Prisma.TransactionClient,
  manifestId: string): Promise<"purged" | "skipped"> {
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const found = await tx.amuxIdeaTrackedCheckoutReadManifest.findUnique({
    where: { id: manifestId }, select: { ideaId: true },
  });
  if (!found) return "skipped";
  await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${found.ideaId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "AmuxIdeaTrackedCheckoutReadManifest"
    WHERE "id" = ${manifestId} FOR UPDATE`;
  const row = await tx.amuxIdeaTrackedCheckoutReadManifest.findUnique({
    where: { id: manifestId },
  });
  const idea = await tx.amuxIdeaSubmission.findUnique({
    where: { id: found.ideaId }, select: { submittedAt: true },
  });
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"`;
  const now = nowRows[0]?.now;
  if (!row || !idea || !now || row.bodyPurgedAt || !row.ciphertext) return "skipped";
  if (amuxReadManifestDueAt(idea.submittedAt) > now ||
      await amuxIdeaHasActiveRetentionHold(tx, row.ideaId, now)) return "skipped";
  const target = amuxTrackedCheckoutReadManifestKeyIdentity(row.ideaId, row.id);
  if (row.keyId !== amuxContentUnitKeyId(target) || row.keyVersion !== 1) {
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  }
  await recordAmuxContentBodyPurge(tx, target, now, row.digest, row.digestKeyId);
  const changed = await tx.amuxIdeaTrackedCheckoutReadManifest.updateMany({
    where: { id: row.id, ciphertext: { not: null }, bodyPurgedAt: null },
    data: { ciphertext: null, keyId: null, keyVersion: null, bodyPurgedAt: now },
  });
  if (changed.count !== 1) {
    throw new AmuxContentRetirementError("integrity_unavailable", target);
  }
  return "purged";
}

/** Prepare an independently deletable content key outside the DB transaction.
 * An uncertain key-store write or COMMIT is never retried blindly. */
export async function prepareAmuxTrackedCheckoutReadManifest(
  input: Omit<AmuxTrackedCheckoutVerifiedReadInput, "manifestId">,
) {
  const manifestId = randomUUID();
  const prepared = { ...input, manifestId };
  const inspected = inspectAmuxTrackedCheckoutReadManifest(prepared);
  if (!inspected) throw new AmuxTrackedCheckoutReadManifestError("invalid_manifest");
  inspected.plaintext.fill(0);
  const keys = await createAmuxContentUnitKeys(
    amuxTrackedCheckoutReadManifestKeyIdentity(input.ideaId, manifestId));
  return { input: prepared, keys };
}

/** Only a definitively rolled-back write may discard its fresh key. An
 * uncertain COMMIT must be read back and must never use this path. */
export async function discardUncommittedAmuxReadManifestKey(
  ideaId: string, manifestId: string,
): Promise<void> {
  await deleteAmuxContentUnitKey(
    amuxTrackedCheckoutReadManifestKeyIdentity(ideaId, manifestId));
}

/** Persist one verified read observation with its canonical audit. No path or
 * model text is placed in the audit or a plaintext DB column. */
export async function recordAmuxTrackedCheckoutReadManifest(
  tx: Prisma.TransactionClient,
  input: AmuxTrackedCheckoutVerifiedReadInput,
  keys: AmuxContentKeys,
) {
  const inspected = inspectAmuxTrackedCheckoutReadManifest(input);
  if (!inspected || keys.masterKeyId !== amuxContentUnitKeyId(
    amuxTrackedCheckoutReadManifestKeyIdentity(input.ideaId, input.manifestId))) {
    throw new AmuxTrackedCheckoutReadManifestError("invalid_manifest");
  }
  try {
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ pinnedCommitSha: string }>>`
    SELECT e."pinnedCommitSha" FROM "AmuxIdeaTrackedCheckoutEvidence" e
    JOIN "AmuxIdeaSubmission" i ON i."id" = e."ideaId"
    WHERE e."ideaId" = ${inspected.ideaId}
      AND e."referenceOrdinal" = ${inspected.referenceOrdinal}
      AND i."submissionOrigin" = 'session'
      AND i."cancelledAt" IS NULL AND i."analysisCompletedAt" IS NULL
      AND i."analysisDeadlineAt" > (clock_timestamp() AT TIME ZONE 'UTC')
    FOR KEY SHARE OF i
  `;
  if (locked.length !== 1) {
    throw new AmuxTrackedCheckoutReadManifestError("idea_unavailable");
  }
  if (locked[0].pinnedCommitSha !== inspected.pinnedCommitSha) {
    throw new AmuxTrackedCheckoutReadManifestError("evidence_unavailable");
  }
  if (await tx.amuxIdeaTrackedCheckoutReadManifest.findUnique({
    where: { ideaId_referenceOrdinal: { ideaId: inspected.ideaId,
      referenceOrdinal: inspected.referenceOrdinal } }, select: { id: true },
  })) throw new AmuxTrackedCheckoutReadManifestError("already_recorded");
  const sealed = sealAmuxContent(inspected.plaintext,
    "repository_read_manifest", inspected.manifestId, keys);
  if (sealed.keyId !== keys.masterKeyId ||
      sealed.keyVersion !== keys.masterKeyVersion) {
    throw new AmuxTrackedCheckoutReadManifestError("invalid_manifest");
  }
  const auditLogId = await writeSystemAuditLog({ tx,
    systemActor: AMUX_V19_READ_MANIFEST_AUDIT_ACTOR,
    action: AMUX_V19_READ_MANIFEST_RECORDED_ACTION,
    targetType: AMUX_V19_READ_MANIFEST_RECORDED_TARGET,
    targetId: inspected.manifestId,
    summary: AMUX_V19_READ_MANIFEST_AUDIT_SUMMARY,
    metadata: amuxTrackedCheckoutReadManifestAuditMetadata(inspected,
      sealed.digest, sealed.digestKeyId),
  });
  try {
    await tx.amuxIdeaTrackedCheckoutReadManifest.create({ data: {
      id: inspected.manifestId, ideaId: inspected.ideaId,
      referenceOrdinal: inspected.referenceOrdinal,
      pinnedCommitSha: inspected.pinnedCommitSha,
      fileCount: inspected.files.length,
      ciphertext: Uint8Array.from(sealed.ciphertext), keyId: sealed.keyId,
      keyVersion: sealed.keyVersion, digest: sealed.digest,
      digestKeyId: sealed.digestKeyId, auditLogId,
    } });
  } catch (error) {
    if (referenceAlreadyRecorded(error)) {
      throw new AmuxTrackedCheckoutReadManifestError("already_recorded");
    }
    throw error;
  }
  return { manifestId: inspected.manifestId, auditLogId,
    fileCount: inspected.files.length };
  } finally { inspected.plaintext.fill(0); }
}

/** Content-free exact-reference readback for a worker whose POST outcome is
 * unknown. Never select ciphertext or the external content key here. */
export async function readAmuxTrackedCheckoutReadManifestReceipt(
  tx: Prisma.TransactionClient, ideaId: string, referenceOrdinal: number,
) {
  return tx.amuxIdeaTrackedCheckoutReadManifest.findUnique({
    where: { ideaId_referenceOrdinal: { ideaId, referenceOrdinal } },
    select: { id: true, ideaId: true, referenceOrdinal: true,
      pinnedCommitSha: true, fileCount: true, digest: true,
      digestKeyId: true, bodyPurgedAt: true },
  });
}

/** Owner-scoped Admin read. Key retrieval happens after the read transaction,
 * since the external key store must not occupy a DB transaction. */
export async function readAmuxTrackedCheckoutReadManifestForOwner(
  actorUserId: string, ideaId: string, referenceOrdinal: number,
): Promise<{ pinnedCommitSha: string; files: string[] } | null> {
  const row = await prisma.amuxIdeaTrackedCheckoutReadManifest.findFirst({
    where: { ideaId, referenceOrdinal, idea: { actorUserId } },
  });
  if (!row) return null;
  if (row.bodyPurgedAt) return null;
  if (!row.ciphertext || !row.keyId || !row.keyVersion) {
    throw new Error("read_manifest_integrity_unavailable");
  }
  const keys = await loadAmuxContentUnitKeys(
    amuxTrackedCheckoutReadManifestKeyIdentity(row.ideaId, row.id));
  const plain = openAmuxContent({ ciphertext: Buffer.from(row.ciphertext),
    keyId: row.keyId, keyVersion: row.keyVersion },
  "repository_read_manifest", row.id, keys);
  try {
    if (!verifyAmuxContentDigest(plain, "repository_read_manifest", row.id,
      row.digest, row.digestKeyId, keys)) throw new Error("invalid_read_manifest");
    return { pinnedCommitSha: row.pinnedCommitSha,
      files: parseAmuxTrackedCheckoutReadManifest(plain, row.fileCount) };
  } finally { plain.fill(0); }
}

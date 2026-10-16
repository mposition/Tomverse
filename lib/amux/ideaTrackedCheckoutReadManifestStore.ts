import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "../adminAudit.ts";
import { openAmuxContent, sealAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import { amuxContentUnitKeyId, createAmuxContentUnitKeys,
  loadAmuxContentUnitKeys } from "./ideaKeyStore.ts";
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

export function amuxTrackedCheckoutReadManifestKeyIdentity(
  ideaId: string, manifestId: string,
) {
  return { ideaId, purpose: "repository_read_manifest" as const,
    subjectId: manifestId };
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
  if (sealed.keyId !== keys.masterKeyId || sealed.keyVersion !== 1) {
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
  await tx.amuxIdeaTrackedCheckoutReadManifest.create({ data: {
    id: inspected.manifestId, ideaId: inspected.ideaId,
    referenceOrdinal: inspected.referenceOrdinal,
    pinnedCommitSha: inspected.pinnedCommitSha,
    fileCount: inspected.files.length,
    ciphertext: Uint8Array.from(sealed.ciphertext), keyId: sealed.keyId,
    keyVersion: sealed.keyVersion, digest: sealed.digest,
    digestKeyId: sealed.digestKeyId, auditLogId,
  } });
  return { manifestId: inspected.manifestId, auditLogId,
    fileCount: inspected.files.length };
  } finally { inspected.plaintext.fill(0); }
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

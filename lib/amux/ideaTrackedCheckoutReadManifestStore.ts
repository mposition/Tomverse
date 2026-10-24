import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "../adminAudit.ts";
import { openAmuxContent, sealAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import { amuxContentUnitKeyId, createAmuxContentUnitKeys,
  loadAmuxContentUnitKeys } from "./ideaKeyStore.ts";
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
import { AMUX_V19_READ_MANIFEST_KEY_INTENT_ACTION,
  AMUX_V19_READ_MANIFEST_KEY_INTENT_TARGET,
  AMUX_V19_MAX_READ_MANIFEST_CLAIM_BOUND_ACTION,
  auditRowActorKind } from
  "../adminAuditSystemActors.ts";
import { readAmuxSessionBudgetClaimReceipt } from
  "./ideaSessionAnalysisBudgetClaimService.ts";
import { AmuxTrackedCheckoutEvidenceError,
  readAmuxMaxTrackedCheckoutEvidence,
  requireActiveMaxCheckoutClaim,
  type AmuxMaxCheckoutClaim } from
  "./ideaTrackedCheckoutEvidenceStore.ts";

export class AmuxTrackedCheckoutReadManifestError extends Error {
  constructor(readonly code: "invalid_manifest" | "idea_unavailable" |
    "evidence_unavailable" | "already_recorded" | "claim_unavailable") {
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
    candidate.meta.target.length === 1 &&
    candidate.meta.target[0] === "id";
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
  // Truncate, never round: bodyPurgedAt is refused by the guard when it is
  // ahead of the unrounded clock, and ::TIMESTAMP(3) rounds up half the time.
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "now"`;
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
  input: AmuxTrackedCheckoutVerifiedReadInput,
  maxClaim?: AmuxMaxCheckoutClaim,
) {
  const prepared = input;
  const inspected = inspectAmuxTrackedCheckoutReadManifest(prepared);
  if (!inspected) throw new AmuxTrackedCheckoutReadManifestError("invalid_manifest");
  inspected.plaintext.fill(0);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
             set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
    `;
    await recordAmuxTrackedCheckoutReadManifestKeyIntent(tx, prepared,
      maxClaim);
  }, { maxWait: 3_000, timeout: 12_000 });
  const keys = await createAmuxContentUnitKeys(
    amuxTrackedCheckoutReadManifestKeyIdentity(input.ideaId, input.manifestId));
  return { input: prepared, keys };
}

/** Commit the key's non-content identity before the external key is written.
 * This row remains discoverable even if PutObject or the manifest COMMIT is
 * uncertain; the seven-day sweeper can then address the exact key. */
export async function recordAmuxTrackedCheckoutReadManifestKeyIntent(
  tx: Prisma.TransactionClient, input: AmuxTrackedCheckoutVerifiedReadInput,
  maxClaim?: AmuxMaxCheckoutClaim,
): Promise<void> {
  const inspected = inspectAmuxTrackedCheckoutReadManifest(input);
  if (!inspected) throw new AmuxTrackedCheckoutReadManifestError("invalid_manifest");
  try {
    await takeAuditChainLock(tx);
    if (maxClaim) await requireMaxManifestClaim(tx, inspected.ideaId,
      inspected.referenceOrdinal, inspected.pinnedCommitSha, maxClaim);
    const locked = await tx.$queryRaw<Array<{ pinnedCommitSha: string }>>`
      SELECT e."pinnedCommitSha" FROM "AmuxIdeaTrackedCheckoutEvidence" e
      JOIN "AmuxIdeaSubmission" i ON i."id" = e."ideaId"
      WHERE e."ideaId" = ${inspected.ideaId}
        AND e."referenceOrdinal" = ${inspected.referenceOrdinal}
        AND i."submissionOrigin" = 'session'
        AND i."cancelledAt" IS NULL AND i."analysisCompletedAt" IS NULL
        AND i."analysisDeadlineAt" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND i."submittedAt" + INTERVAL '7 days' > clock_timestamp()
      FOR KEY SHARE OF i
    `;
    if (locked.length !== 1) {
      throw new AmuxTrackedCheckoutReadManifestError("idea_unavailable");
    }
    if (locked[0].pinnedCommitSha !== inspected.pinnedCommitSha) {
      throw new AmuxTrackedCheckoutReadManifestError("evidence_unavailable");
    }
    // A Max claim is one analysis page and reserves one key per reference;
    // the claimless writer keeps one per reference.
    if (maxClaim
      ? (await readMaxManifestIntentBindings(tx, inspected.ideaId,
        inspected.referenceOrdinal, maxClaim.claimId)).length > 0
      : await tx.amuxIdeaReadManifestKeyIntent.findFirst({
        where: { ideaId: inspected.ideaId,
          referenceOrdinal: inspected.referenceOrdinal }, select: { id: true },
      })) throw new AmuxTrackedCheckoutReadManifestError("already_recorded");
    if (await tx.amuxIdeaReadManifestKeyIntent.findUnique({
      where: { id: inspected.manifestId }, select: { id: true },
    })) throw new AmuxTrackedCheckoutReadManifestError("already_recorded");
    const auditLogId = await writeSystemAuditLog({ tx,
      systemActor: AMUX_V19_READ_MANIFEST_AUDIT_ACTOR,
      action: AMUX_V19_READ_MANIFEST_KEY_INTENT_ACTION,
      targetType: AMUX_V19_READ_MANIFEST_KEY_INTENT_TARGET,
      targetId: inspected.manifestId,
      summary: "Reserved an AMUX v19 read-manifest content key identity.",
      metadata: { policyVersion: 19, manifestId: inspected.manifestId,
        ideaId: inspected.ideaId, referenceOrdinal: inspected.referenceOrdinal,
        pinnedCommitSha: inspected.pinnedCommitSha },
    });
    await tx.amuxIdeaReadManifestKeyIntent.create({ data: {
      id: inspected.manifestId, ideaId: inspected.ideaId,
      referenceOrdinal: inspected.referenceOrdinal,
      pinnedCommitSha: inspected.pinnedCommitSha, auditLogId,
    } });
    if (maxClaim) await writeSystemAuditLog({ tx,
      systemActor: AMUX_V19_READ_MANIFEST_AUDIT_ACTOR,
      action: AMUX_V19_MAX_READ_MANIFEST_CLAIM_BOUND_ACTION,
      targetType: AMUX_V19_READ_MANIFEST_KEY_INTENT_TARGET,
      targetId: inspected.manifestId,
      summary: "Bound one AMUX v19 read-manifest key intent to a Max claim.",
      metadata: { claimId: maxClaim.claimId,
        requestId: maxClaim.requestId,
        reservationId: maxClaim.reservationId,
        invocationOrdinal: maxClaim.invocationOrdinal,
        ideaId: inspected.ideaId,
        referenceOrdinal: inspected.referenceOrdinal,
        keyIntentAuditLogId: auditLogId },
    });
  } finally { inspected.plaintext.fill(0); }
}

/** Persist one verified read observation with its canonical audit. No path or
 * model text is placed in the audit or a plaintext DB column. */
export async function recordAmuxTrackedCheckoutReadManifest(
  tx: Prisma.TransactionClient,
  input: AmuxTrackedCheckoutVerifiedReadInput,
  keys: AmuxContentKeys,
  maxClaim?: AmuxMaxCheckoutClaim,
) {
  const inspected = inspectAmuxTrackedCheckoutReadManifest(input);
  if (!inspected || keys.masterKeyId !== amuxContentUnitKeyId(
    amuxTrackedCheckoutReadManifestKeyIdentity(input.ideaId, input.manifestId))) {
    throw new AmuxTrackedCheckoutReadManifestError("invalid_manifest");
  }
  try {
  await takeAuditChainLock(tx);
  if (maxClaim) await requireMaxManifestClaim(tx, inspected.ideaId,
    inspected.referenceOrdinal, inspected.pinnedCommitSha, maxClaim);
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
  const intent = await tx.amuxIdeaReadManifestKeyIntent.findUnique({
    where: { id: inspected.manifestId }, select: { ideaId: true,
      referenceOrdinal: true, pinnedCommitSha: true,
      keyRetirementClaimedAt: true, keyDeletedAt: true,
      auditLogId: true },
  });
  if (!intent || intent.ideaId !== inspected.ideaId ||
      intent.referenceOrdinal !== inspected.referenceOrdinal ||
      intent.pinnedCommitSha !== inspected.pinnedCommitSha ||
      intent.keyRetirementClaimedAt || intent.keyDeletedAt) {
    throw new AmuxTrackedCheckoutReadManifestError("evidence_unavailable");
  }
  if (maxClaim && !await readAmuxMaxManifestIntentBinding(tx,
    inspected.ideaId, inspected.referenceOrdinal, inspected.manifestId,
    intent.auditLogId, maxClaim)) {
    throw new AmuxTrackedCheckoutReadManifestError("claim_unavailable");
  }
  // The intent is this page's own (checked above for a Max claim), so its
  // manifest is recorded once; the claimless writer keeps one per reference.
  if (await tx.amuxIdeaTrackedCheckoutReadManifest.findFirst({
    where: maxClaim ? { id: inspected.manifestId }
      : { ideaId: inspected.ideaId, referenceOrdinal: inspected.referenceOrdinal },
    select: { id: true },
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

async function requireMaxManifestClaim(tx: Prisma.TransactionClient,
  ideaId: string, referenceOrdinal: number, pinnedCommitSha: string,
  claim: AmuxMaxCheckoutClaim): Promise<void> {
  try {
    await requireActiveMaxCheckoutClaim(tx, ideaId, claim);
    const evidence = await readAmuxMaxTrackedCheckoutEvidence(tx, ideaId,
      referenceOrdinal, claim);
    if (!evidence || evidence.pinnedCommitSha !== pinnedCommitSha) {
      throw new AmuxTrackedCheckoutEvidenceError("claim_unavailable");
    }
  } catch {
    throw new AmuxTrackedCheckoutReadManifestError("claim_unavailable");
  }
}

/** The claim link was committed with the key intent before key creation.
 * It remains readable after settlement or seven-day ciphertext retirement. */
export async function readAmuxMaxManifestIntentBinding(
  tx: Prisma.TransactionClient, ideaId: string, referenceOrdinal: number,
  manifestId: string, keyIntentAuditLogId: string,
  claim: AmuxMaxCheckoutClaim,
): Promise<boolean> {
  const receipt = await readAmuxSessionBudgetClaimReceipt(tx, claim);
  if (receipt.status !== "committed" || receipt.claimId !== claim.claimId) {
    return false;
  }
  const bindings = await tx.adminAuditLog.findMany({ where: {
    action: AMUX_V19_MAX_READ_MANIFEST_CLAIM_BOUND_ACTION,
    targetType: AMUX_V19_READ_MANIFEST_KEY_INTENT_TARGET,
    targetId: manifestId,
  }, take: 2 });
  const audit = bindings[0];
  const metadata = audit?.metadata;
  const bound = metadata && typeof metadata === "object" &&
    !Array.isArray(metadata) ? metadata as Record<string, unknown> : null;
  return bindings.length === 1 && !!audit?.entryHash &&
    auditRowActorKind(audit) === "system" && !!bound &&
    bound.claimId === claim.claimId &&
    bound.requestId === claim.requestId &&
    bound.reservationId === claim.reservationId &&
    bound.invocationOrdinal === claim.invocationOrdinal &&
    bound.ideaId === ideaId &&
    bound.referenceOrdinal === referenceOrdinal &&
    bound.keyIntentAuditLogId === keyIntentAuditLogId;
}

function readMaxManifestIntentBindings(tx: Prisma.TransactionClient,
  ideaId: string, referenceOrdinal: number, claimId: string) {
  return tx.adminAuditLog.findMany({ where: {
    action: AMUX_V19_MAX_READ_MANIFEST_CLAIM_BOUND_ACTION,
    targetType: AMUX_V19_READ_MANIFEST_KEY_INTENT_TARGET,
    AND: [{ metadata: { path: ["claimId"], equals: claimId } },
      { metadata: { path: ["ideaId"], equals: ideaId } },
      { metadata: { path: ["referenceOrdinal"], equals: referenceOrdinal } }],
  }, select: { targetId: true }, take: 2 });
}

const MANIFEST_RECEIPT = { id: true, ideaId: true, referenceOrdinal: true,
  pinnedCommitSha: true, fileCount: true, digest: true,
  digestKeyId: true, bodyPurgedAt: true } as const;
const KEY_INTENT_RECEIPT = { id: true, ideaId: true, referenceOrdinal: true,
  pinnedCommitSha: true, keyRetirementClaimedAt: true,
  keyDeletedAt: true, auditLogId: true } as const;

/** The one page a Max claim recorded for a reference: its key intent, proven
 * by the intent's claim binding, and that intent's manifest once recorded.
 * Null when the claim bound none; a second binding is an integrity failure. */
export async function readAmuxMaxManifestForClaim(
  tx: Prisma.TransactionClient, ideaId: string, referenceOrdinal: number,
  claim: AmuxMaxCheckoutClaim,
) {
  const bindings = await readMaxManifestIntentBindings(tx, ideaId,
    referenceOrdinal, claim.claimId);
  if (bindings.length === 0) return null;
  const intentId = bindings[0]?.targetId;
  if (bindings.length !== 1 || !intentId) {
    throw new Error("read_manifest_claim_ambiguous");
  }
  const intent = await tx.amuxIdeaReadManifestKeyIntent.findUnique({
    where: { id: intentId }, select: KEY_INTENT_RECEIPT });
  if (!intent || intent.ideaId !== ideaId ||
      intent.referenceOrdinal !== referenceOrdinal ||
      !await readAmuxMaxManifestIntentBinding(tx, ideaId, referenceOrdinal,
        intent.id, intent.auditLogId, claim)) return null;
  const manifest = await tx.amuxIdeaTrackedCheckoutReadManifest.findUnique({
    where: { id: intent.id }, select: MANIFEST_RECEIPT });
  return { intent, manifest };
}

/** Content-free exact-reference readback for a claimless worker whose POST
 * outcome is unknown. Never select ciphertext or the external content key
 * here. Max pages read by claim instead (readAmuxMaxManifestForClaim). */
export async function readAmuxTrackedCheckoutReadManifestReceipt(
  tx: Prisma.TransactionClient, ideaId: string, referenceOrdinal: number,
) {
  return onlyRow(await tx.amuxIdeaTrackedCheckoutReadManifest.findMany({
    where: { ideaId, referenceOrdinal }, select: MANIFEST_RECEIPT, take: 2 }));
}

/** A content-free pending-key receipt when the manifest write never reached
 * its audit transaction. Its existence forbids blind key creation retries. */
export async function readAmuxTrackedCheckoutReadManifestKeyIntentReceipt(
  tx: Prisma.TransactionClient, ideaId: string, referenceOrdinal: number,
) {
  return onlyRow(await tx.amuxIdeaReadManifestKeyIntent.findMany({
    where: { ideaId, referenceOrdinal }, select: KEY_INTENT_RECEIPT, take: 2 }));
}

/** A reference with several pages has no single claimless receipt. */
function onlyRow<T>(rows: T[]): T | null {
  if (rows.length > 1) throw new Error("read_manifest_reference_ambiguous");
  return rows[0] ?? null;
}

/** Database-clock access fence, shared by the Admin reader and DB test. */
export async function ownerMayReadManifest(
  actorUserId: string, ideaId: string, manifestId: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ allowed: boolean }>>`
    WITH clock AS (SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS "now")
    SELECT (m."bodyPurgedAt" IS NULL AND
      (i."submittedAt" + INTERVAL '7 days' > clock."now" OR
        EXISTS (SELECT 1 FROM "AmuxIdeaRetentionHold" h
          WHERE h."ideaId" = i."id" AND h."releasedAt" IS NULL
            AND h."expiresAt" > clock."now"))) AS "allowed"
    FROM "AmuxIdeaTrackedCheckoutReadManifest" m
    JOIN "AmuxIdeaSubmission" i ON i."id" = m."ideaId"
    CROSS JOIN clock
    WHERE m."id" = ${manifestId} AND m."ideaId" = ${ideaId}
      AND i."actorUserId" = ${actorUserId}
  `;
  return rows.length === 1 && rows[0].allowed === true;
}

/** Owner-scoped Admin read of one page's manifest. Key retrieval happens after
 * the read query, since the external key store must not occupy a DB
 * transaction. */
export async function readAmuxTrackedCheckoutReadManifestForOwner(
  actorUserId: string, ideaId: string, manifestId: string,
): Promise<{ pinnedCommitSha: string; files: string[] } | null> {
  const row = await prisma.amuxIdeaTrackedCheckoutReadManifest.findFirst({
    where: { id: manifestId, ideaId, idea: { actorUserId } },
  });
  if (!row) return null;
  // The retention worker may be delayed. Its lag never extends Admin access
  // beyond the absolute seven-day deadline unless a valid hold is active.
  if (!await ownerMayReadManifest(actorUserId, ideaId, row.id)) return null;
  if (!row.ciphertext || !row.keyId || !row.keyVersion) {
    throw new Error("read_manifest_integrity_unavailable");
  }
  let keys: AmuxContentKeys;
  try {
    keys = await loadAmuxContentUnitKeys(
      amuxTrackedCheckoutReadManifestKeyIdentity(row.ideaId, row.id));
  } catch (error) {
    if (!await ownerMayReadManifest(actorUserId, ideaId, row.id)) return null;
    throw error;
  }
  const plain = openAmuxContent({ ciphertext: Buffer.from(row.ciphertext),
    keyId: row.keyId, keyVersion: row.keyVersion },
  "repository_read_manifest", row.id, keys);
  try {
    if (!verifyAmuxContentDigest(plain, "repository_read_manifest", row.id,
      row.digest, row.digestKeyId, keys)) throw new Error("invalid_read_manifest");
    // Key retrieval and decryption can cross the deadline or a hold release.
    // Recheck before materializing path strings for the response.
    if (!await ownerMayReadManifest(actorUserId, ideaId, row.id)) return null;
    return { pinnedCommitSha: row.pinnedCommitSha,
      files: parseAmuxTrackedCheckoutReadManifest(plain, row.fileCount) };
  } finally { plain.fill(0); }
}

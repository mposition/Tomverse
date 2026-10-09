import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { sealAmuxContent, type AmuxContentKeys } from
  "@/lib/amux/ideaCrypto";
import { amuxContentDigest, openAmuxContent, verifyAmuxContentDigest } from
  "@/lib/amux/ideaCrypto";
import { decodeV22PatchEvidence, encodeV22PatchEvidence,
  type V22PublishFile } from "@/lib/amux/v22PatchEvidence";
import { loadAmuxContentUnitKeys } from "@/lib/amux/ideaKeyStore";
import { prisma } from "@/lib/prisma";

export const AMUX_V22_RESULT_MAX_BYTES = 65_536;
const IDEA_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/;

export class AmuxV22TaskResultError extends Error {
  constructor(readonly code: "binding_mismatch" | "result_conflict" |
    "result_invalid") { super(code); }
}

export function v22TaskResultIdeaId(sourceSnapshot: unknown): string | null {
  if (!sourceSnapshot || typeof sourceSnapshot !== "object" ||
      Array.isArray(sourceSnapshot)) return null;
  const record = sourceSnapshot as Record<string, unknown>;
  return record.schemaVersion === "amux-v4" &&
    typeof record.ideaId === "string" && IDEA_ID.test(record.ideaId)
    ? record.ideaId : null;
}

export function v22TaskResultSha256(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length < 1 || bytes.length > AMUX_V22_RESULT_MAX_BYTES ||
      text.includes("\0")) throw new AmuxV22TaskResultError("result_invalid");
  return createHash("sha256").update(bytes).digest("hex");
}

/** Called with a new per-attempt key created outside the DB transaction. */
export async function recordAmuxV22TaskResult(tx: Prisma.TransactionClient,
  input: { attemptId: string; worker: string; ideaId: string;
    text: string; sourceSha256: string; keys: AmuxContentKeys;
    patch?: { text: string; sha256: string; baseSha: string;
      files?: V22PublishFile[]; keys: AmuxContentKeys } }) {
  if (v22TaskResultSha256(input.text) !== input.sourceSha256 ||
      !IDEA_ID.test(input.ideaId))
    throw new AmuxV22TaskResultError("result_invalid");
  if (input.patch && (v22TaskResultSha256(input.patch.text) !==
      input.patch.sha256 || !/^[0-9a-f]{40}$/.test(input.patch.baseSha) ||
      !input.patch.text.startsWith("diff --git ")))
    throw new AmuxV22TaskResultError("result_invalid");
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  const locked = await tx.$queryRaw<Array<{ taskId: string; worker: string;
    endedAt: Date | null; v22AssignmentId: string | null }>>`
    SELECT "taskId", "worker", "endedAt", "v22AssignmentId"
    FROM "AmuxExecutionAttempt" WHERE "id" = ${input.attemptId} FOR UPDATE
  `;
  const attempt = locked[0];
  if (!attempt || attempt.worker !== input.worker || attempt.endedAt ||
      !attempt.v22AssignmentId) throw new AmuxV22TaskResultError("binding_mismatch");
  const taskRows = await tx.$queryRaw<Array<{ id: string; sourceSystem: string | null;
    sourceSnapshot: Prisma.JsonValue | null; status: string; owner: string | null;
    v22AssignmentId: string | null }>>`
    SELECT "id", "sourceSystem", "sourceSnapshot", "status", "owner",
      "v22AssignmentId" FROM "AmuxWorkItem" WHERE "id" = ${attempt.taskId}
      FOR UPDATE
  `;
  const task = taskRows[0];
  if (!task || task.sourceSystem !== "admin-idea-v4" ||
      task.status !== "doing" || task.owner !== input.worker ||
      task.v22AssignmentId !== attempt.v22AssignmentId ||
      v22TaskResultIdeaId(task.sourceSnapshot) !== input.ideaId)
    throw new AmuxV22TaskResultError("binding_mismatch");
  const prior = await tx.amuxV22TaskResult.findUnique({
    where: { attemptId: input.attemptId },
    select: { sourceSha256: true, taskId: true, ideaId: true },
  });
  if (prior) {
    const priorPatch = await tx.amuxV22TaskPatch.findUnique({
      where: { attemptId: input.attemptId },
      select: { patchSha256: true, baseSha: true, digest: true,
        digestKeyId: true, byteLength: true },
    });
    // A duplicate compares the original submitted evidence. Run eligibility
    // can change after the first commit; it must not rewrite that history.
    let sameEvidence = input.patch ? false : priorPatch === null;
    if (input.patch && priorPatch) {
      const evidence = encodeV22PatchEvidence(input.patch.text,
        input.patch.files);
      try {
        const digest = amuxContentDigest(evidence, "task_patch",
          input.attemptId, input.patch.keys);
        sameEvidence = priorPatch.patchSha256 === input.patch.sha256 &&
          priorPatch.baseSha === input.patch.baseSha &&
          priorPatch.digest === digest.digest &&
          priorPatch.digestKeyId === digest.digestKeyId &&
          priorPatch.byteLength === evidence.length;
      } finally { evidence.fill(0); }
    }
    if (prior.sourceSha256 !== input.sourceSha256 ||
        prior.taskId !== task.id || prior.ideaId !== input.ideaId ||
        !sameEvidence)
      throw new AmuxV22TaskResultError("result_conflict");
    return { attemptId: input.attemptId, sourceSha256: input.sourceSha256,
      patchSha256: priorPatch?.patchSha256 ?? null, duplicate: true };
  }
  let patch = input.patch;
  if (patch) {
    const assignment = await tx.amuxV22WorkerAssignment.findUnique({
      where: { id: attempt.v22AssignmentId },
      select: { role: true, workItemId: true },
    });
    if (assignment?.role !== "implement" || assignment.workItemId !== task.id)
      patch = undefined;
    // A patch is a private Task result first. A missing, finished or
    // base-mismatched Engineering run must not erase it; the Publisher
    // verifies the current run and base separately before exposing bytes.
  }
  const bytes = Buffer.from(input.text, "utf8");
  const sealed = sealAmuxContent(bytes, "task_result", input.attemptId,
    input.keys);
  const patchBytes = patch ? encodeV22PatchEvidence(patch.text,
    patch.files) : null;
  let sealedPatch: ReturnType<typeof sealAmuxContent> | null = null;
  try {
    if (patch && patchBytes) sealedPatch =
      sealAmuxContent(patchBytes, "task_patch", input.attemptId,
        patch.keys);
    await tx.amuxV22TaskResult.create({ data: {
      attemptId: input.attemptId, taskId: task.id, ideaId: input.ideaId,
      ciphertext: new Uint8Array(sealed.ciphertext), keyId: sealed.keyId,
      keyVersion: sealed.keyVersion, digest: sealed.digest,
      digestKeyId: sealed.digestKeyId,
      sourceSha256: input.sourceSha256, byteLength: bytes.length,
    } });
    if (patch && patchBytes && sealedPatch) {
      await tx.amuxV22TaskPatch.create({ data: {
        attemptId: input.attemptId, taskId: task.id, ideaId: input.ideaId,
        ciphertext: new Uint8Array(sealedPatch.ciphertext),
        keyId: sealedPatch.keyId, keyVersion: sealedPatch.keyVersion,
        digest: sealedPatch.digest, digestKeyId: sealedPatch.digestKeyId,
        patchSha256: patch.sha256, baseSha: patch.baseSha,
        byteLength: patchBytes.length,
      } });
    }
    await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
      action: "amux.v22.task_result.recorded",
      targetType: "AmuxV22TaskResult", targetId: input.attemptId,
      summary: "Recorded one encrypted v22 Task result.",
      metadata: { taskId: task.id, sourceSha256: input.sourceSha256,
        byteLength: bytes.length,
        patchSha256: patch?.sha256 ?? null },
    });
    return { attemptId: input.attemptId, sourceSha256: input.sourceSha256,
      patchSha256: patch?.sha256 ?? null, duplicate: false };
  } finally { bytes.fill(0); sealed.ciphertext.fill(0);
    patchBytes?.fill(0); sealedPatch?.ciphertext.fill(0); }
}

/** Owner-only callers may read one retained result; no plaintext is logged. */
export async function readAmuxV22TaskResultForOwner(taskId: string) {
  const row = await prisma.amuxV22TaskResult.findFirst({
    where: { taskId }, orderBy: [{ createdAt: "desc" }, { attemptId: "desc" }],
    select: { attemptId: true, ideaId: true, ciphertext: true,
      keyId: true, keyVersion: true, digest: true, digestKeyId: true,
      sourceSha256: true, bodyPurgedAt: true, createdAt: true },
  });
  if (!row) return null;
  const patch = await prisma.amuxV22TaskPatch.findUnique({
    where: { attemptId: row.attemptId },
    select: { ideaId: true, ciphertext: true, keyId: true,
      keyVersion: true, digest: true, digestKeyId: true,
      patchSha256: true, baseSha: true, bodyPurgedAt: true },
  });
  if (patch && Boolean(row.bodyPurgedAt) !== Boolean(patch.bodyPurgedAt))
    throw new AmuxV22TaskResultError("result_invalid");
  let readablePatch: { state: "available"; baseSha: string;
    sha256: string; text: string } | { state: "purged" } | null = null;
  if (patch) {
    if (patch.ideaId !== row.ideaId)
      throw new AmuxV22TaskResultError("binding_mismatch");
    if (patch.bodyPurgedAt || !patch.ciphertext || !patch.keyId ||
        !patch.keyVersion) {
      readablePatch = { state: "purged" };
    } else {
      const patchKeys = await loadAmuxContentUnitKeys({ ideaId: patch.ideaId,
        purpose: "task_patch", subjectId: row.attemptId });
      let plainPatch: Buffer | null = null;
      try {
        plainPatch = openAmuxContent({
          ciphertext: Buffer.from(patch.ciphertext), keyId: patch.keyId,
          keyVersion: patch.keyVersion,
        }, "task_patch", row.attemptId, patchKeys);
        if (!verifyAmuxContentDigest(plainPatch, "task_patch",
          row.attemptId, patch.digest, patch.digestKeyId, patchKeys))
          throw new AmuxV22TaskResultError("result_invalid");
        const evidence = decodeV22PatchEvidence(plainPatch);
        if (createHash("sha256").update(evidence.text).digest("hex") !==
            patch.patchSha256)
          throw new AmuxV22TaskResultError("result_invalid");
        readablePatch = { state: "available", baseSha: patch.baseSha,
          sha256: patch.patchSha256, text: evidence.text };
      } finally { plainPatch?.fill(0); patchKeys.masterKey.fill(0); }
    }
  }
  if (row.bodyPurgedAt || !row.ciphertext || !row.keyId || !row.keyVersion)
    return { attemptId: row.attemptId, state: "purged" as const,
      createdAt: row.createdAt.toISOString(), patch: readablePatch };
  const keys = await loadAmuxContentUnitKeys({ ideaId: row.ideaId,
    purpose: "task_result", subjectId: row.attemptId });
  let plain: Buffer | null = null;
  try {
    plain = openAmuxContent({ ciphertext: Buffer.from(row.ciphertext),
      keyId: row.keyId, keyVersion: row.keyVersion },
      "task_result", row.attemptId, keys);
    if (!verifyAmuxContentDigest(plain, "task_result", row.attemptId,
      row.digest, row.digestKeyId, keys) ||
      createHash("sha256").update(plain).digest("hex") !== row.sourceSha256)
      throw new AmuxV22TaskResultError("result_invalid");
    return { attemptId: row.attemptId, state: "available" as const,
      createdAt: row.createdAt.toISOString(), text: plain.toString("utf8"),
      patch: readablePatch };
  } finally { plain?.fill(0); keys.masterKey.fill(0); }
}

/** Internal verification only. Never return this object to the publisher or
 * a client; publication gets the patch only through its scoped capability. */
export async function readAmuxV22TaskPatchEvidence(attemptId: string,
  taskId: string): Promise<{ text: string; files: V22PublishFile[] | null;
  sha256: string; baseSha: string } | null> {
  const patch = await prisma.amuxV22TaskPatch.findUnique({
    where: { attemptId },
    select: { taskId: true, ideaId: true, ciphertext: true,
      keyId: true, keyVersion: true, digest: true, digestKeyId: true,
      patchSha256: true, baseSha: true, bodyPurgedAt: true },
  });
  if (!patch || patch.bodyPurgedAt || patch.taskId !== taskId ||
      !patch.ciphertext || !patch.keyId || !patch.keyVersion) return null;
  const keys = await loadAmuxContentUnitKeys({ ideaId: patch.ideaId,
    purpose: "task_patch", subjectId: attemptId });
  let plain: Buffer | null = null;
  try {
    plain = openAmuxContent({ ciphertext: Buffer.from(patch.ciphertext),
      keyId: patch.keyId, keyVersion: patch.keyVersion },
      "task_patch", attemptId, keys);
    if (!verifyAmuxContentDigest(plain, "task_patch", attemptId,
      patch.digest, patch.digestKeyId, keys))
      throw new AmuxV22TaskResultError("result_invalid");
    const evidence = decodeV22PatchEvidence(plain);
    if (v22TaskResultSha256(evidence.text) !== patch.patchSha256)
      throw new AmuxV22TaskResultError("result_invalid");
    return { ...evidence, sha256: patch.patchSha256,
      baseSha: patch.baseSha };
  } finally { plain?.fill(0); keys.masterKey.fill(0); }
}

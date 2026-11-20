import { amuxV22TaskWritesPatch } from "@/lib/amux/v22WorkerClaimCore";
import "server-only";

import { constants as bufferConstants } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { sealAmuxContent, type AmuxContentKeys, type SealedAmuxContent } from
  "@/lib/amux/ideaCrypto";
import { openAmuxContent, verifyAmuxContentDigest } from
  "@/lib/amux/ideaCrypto";
import { decodeV22PatchEvidence, encodeV22PatchEvidence,
  type V22PublishFile } from "@/lib/amux/v22PatchEvidence";
import { loadAmuxContentUnitKeys } from "@/lib/amux/ideaKeyStore";
import { readAmuxSealedBytea } from "@/lib/amux/sealedByteaRead";
import { amuxV22ConclusionSha256, parseAmuxV22Conclusion } from
  "@/lib/amux/v22ConclusionCore";
import { amuxV22OwnerQuestionSettlement, amuxV22OwnerQuestionSha256,
  parseAmuxV22OwnerQuestion } from "@/lib/amux/v22OwnerQuestionCore";
import { amuxV22SizeAllowanceMs, type AmuxV22TransferPart } from
  "@/lib/amux/v22TransferCore";
import { prisma } from "@/lib/prisma";

const IDEA_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/;

/**
 * The most one sealed value Prisma can write (an external bound, not ours):
 * Prisma 7 hands a Bytes value to its driver adapter as one base64 string, so
 * the value is bounded by V8's string length (measured 2026-11-18: 300 MiB
 * written, 420 MiB refused with ERR_STRING_TOO_LONG before anything reached
 * the database; lib/amux/sealedByteaRead.ts has the read side). A commit is
 * checked against it before its transaction, so a value that cannot be
 * written gets one deterministic answer instead of an unknown outcome.
 */
export const AMUX_V22_PRISMA_BYTES_WRITE_MAX_BYTES =
  Math.floor(bufferConstants.MAX_STRING_LENGTH / 4) * 3;

export class AmuxV22TaskResultError extends Error {
  constructor(readonly code: "binding_mismatch" | "result_conflict" |
    "result_invalid" | "exceeds_processing") { super(code); }
}

export function v22TaskResultIdeaId(sourceSnapshot: unknown): string | null {
  if (!sourceSnapshot || typeof sourceSnapshot !== "object" ||
      Array.isArray(sourceSnapshot)) return null;
  const record = sourceSnapshot as Record<string, unknown>;
  return record.schemaVersion === "amux-v4" &&
    typeof record.ideaId === "string" && IDEA_ID.test(record.ideaId)
    ? record.ideaId : null;
}

/** A result or patch text's digest. No size bound of ours (owner decision
 * 2026-11-18, docs/policy/amux-v22-result-transfer.md): it is non-empty and
 * holds no NUL. */
export function v22TaskResultSha256(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  try {
    if (bytes.length < 1 || text.includes("\0"))
      throw new AmuxV22TaskResultError("result_invalid");
    return createHash("sha256").update(bytes).digest("hex");
  } finally { bytes.fill(0); }
}

/** A patch text's digest, the same way. */
export const v22TaskPatchSha256 = (text: string) => v22TaskResultSha256(text);

type SealedPatch = { sha256: string; baseSha: string; byteLength: number;
  sealed: SealedAmuxContent };

/** A result sealed and checked outside the DB transaction: what
 * `recordAmuxV22TaskResult` writes, with nothing left to compute. */
export type PreparedAmuxV22TaskResult = {
  attemptId: string; worker: string; ideaId: string; sourceSha256: string;
  byteLength: number; sealed: SealedAmuxContent;
  conclusion: { verdict: string; sha256: string } | null;
  questionSha256: string | null;
  patch: SealedPatch | null;
  /** Staging parts (chunked transfer) the commit consumes once it records them. */
  staging: readonly AmuxV22TransferPart[];
  /** Zeroes the sealed buffers; call when the record is done. */
  dispose(): void;
};

/**
 * The pure half of recording a result: checks the text and the optional
 * patch, parses the investigate conclusion and owner question, and seals both
 * bodies under the keys made before it. Heavy work for a large result, so it
 * runs before the transaction, never inside the audit chain lock.
 */
export function prepareAmuxV22TaskResultRecord(input: { attemptId: string;
  worker: string; ideaId: string; text: string; sourceSha256: string;
  /** The text's UTF-8 bytes when the caller already holds them (an assembled
   * transfer), so a large result is not encoded again. Not zeroed here. */
  bytes?: Buffer;
  keys: AmuxContentKeys; patch?: { text: string; sha256: string;
    baseSha: string; files?: V22PublishFile[]; keys: AmuxContentKeys };
  staging?: readonly AmuxV22TransferPart[] }): PreparedAmuxV22TaskResult {
  const resultSha256 = input.bytes ? (input.bytes.length < 1 || input.bytes.includes(0) ?
    null : createHash("sha256").update(input.bytes).digest("hex")) :
    v22TaskResultSha256(input.text);
  if (resultSha256 !== input.sourceSha256 || !IDEA_ID.test(input.ideaId))
    throw new AmuxV22TaskResultError("result_invalid");
  if (input.patch && (v22TaskPatchSha256(input.patch.text) !==
      input.patch.sha256 || !/^[0-9a-f]{40}$/.test(input.patch.baseSha) ||
      !input.patch.text.startsWith("diff --git ")))
    throw new AmuxV22TaskResultError("result_invalid");
  // An investigate conclusion is checked here, where the text is plain; the
  // row keeps its verdict and digest, and settlement reads only those.
  const conclusion = parseAmuxV22Conclusion(input.text);
  const question = parseAmuxV22OwnerQuestion(input.text);
  const bytes = input.bytes ?? Buffer.from(input.text, "utf8");
  const byteLength = bytes.length;
  let sealed: SealedAmuxContent | null = null;
  let patch: SealedPatch | null = null;
  try {
    sealed = sealAmuxContent(bytes, "task_result", input.attemptId, input.keys);
    if (sealed.ciphertext.length > AMUX_V22_PRISMA_BYTES_WRITE_MAX_BYTES)
      throw new AmuxV22TaskResultError("exceeds_processing");
    if (input.patch) {
      let evidence: Buffer;
      try { evidence = encodeV22PatchEvidence(input.patch.text, input.patch.files); }
      catch { throw new AmuxV22TaskResultError("result_invalid"); }
      try {
        const sealedEvidence = sealAmuxContent(evidence, "task_patch",
          input.attemptId, input.patch.keys);
        // A patch that cannot be written leaves the result recorded and the
        // patch rejected, as any patch the record does not keep.
        if (sealedEvidence.ciphertext.length > AMUX_V22_PRISMA_BYTES_WRITE_MAX_BYTES)
          sealedEvidence.ciphertext.fill(0);
        else patch = { sha256: input.patch.sha256, baseSha: input.patch.baseSha,
          byteLength: evidence.length, sealed: sealedEvidence };
      } finally { evidence.fill(0); }
    }
  } catch (error) {
    sealed?.ciphertext.fill(0);
    throw error;
  } finally { if (!input.bytes) bytes.fill(0); }
  const sealedResult = sealed;
  const sealedPatch = patch as SealedPatch | null;
  return { attemptId: input.attemptId, worker: input.worker,
    ideaId: input.ideaId, sourceSha256: input.sourceSha256,
    byteLength, sealed: sealedResult,
    conclusion: conclusion ? { verdict: conclusion.verdict,
      sha256: amuxV22ConclusionSha256(conclusion) } : null,
    questionSha256: question ? amuxV22OwnerQuestionSha256(question) : null,
    patch: sealedPatch, staging: [...(input.staging ?? [])],
    dispose() {
      sealedResult.ciphertext.fill(0);
      sealedPatch?.sealed.ciphertext.fill(0);
    } };
}

/** The bytes the record writes, which its time grows with (v22TransferCore.ts). */
export const amuxV22TaskResultAllowanceMs = (prepared: PreparedAmuxV22TaskResult) =>
  amuxV22SizeAllowanceMs(prepared.sealed.ciphertext.length +
    (prepared.patch?.sealed.ciphertext.length ?? 0));

/** The record's Prisma transaction limits: the old fixed 10 s, plus time in
 * proportion to what it writes. */
export const amuxV22TaskResultTransactionOptions = (
  prepared: PreparedAmuxV22TaskResult) => ({ maxWait: 5_000,
  timeout: 10_000 + amuxV22TaskResultAllowanceMs(prepared) });

const bytea = (buffer: Buffer) => buffer as unknown as Uint8Array<ArrayBuffer>;

/** A create returns the row it wrote, and a bytea of more than 256 MiB read
 * back that way ends the process (lib/amux/sealedByteaRead.ts): it returns the
 * key alone. */
const CREATED = { attemptId: true } as const;

/**
 * The transactional half: locks the attempt, the audit chain and the Task,
 * checks the binding and a prior record, writes the rows and the audit entry,
 * and deletes the staging the commit consumed. Nothing in it grows with the
 * result but the INSERT, whose statement time grows with it.
 */
export async function recordAmuxV22TaskResult(tx: Prisma.TransactionClient,
  prepared: PreparedAmuxV22TaskResult) {
  const allowance = amuxV22TaskResultAllowanceMs(prepared);
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', ${String(5_000 + allowance)}, true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', ${String(10_000 + allowance)}, true) AS idle_limit
  `;
  const locked = await tx.$queryRaw<Array<{ taskId: string; worker: string;
    endedAt: Date | null; v22AssignmentId: string | null }>>`
    SELECT "taskId", "worker", "endedAt", "v22AssignmentId"
    FROM "AmuxExecutionAttempt" WHERE "id" = ${prepared.attemptId} FOR UPDATE
  `;
  const attempt = locked[0];
  if (!attempt || attempt.worker !== prepared.worker || attempt.endedAt ||
      !attempt.v22AssignmentId) throw new AmuxV22TaskResultError("binding_mismatch");
  // The attempt row, then the audit chain, then the Task (lib/adminAudit.ts).
  await takeAuditChainLock(tx);
  const taskRows = await tx.$queryRaw<Array<{ id: string; sourceSystem: string | null;
    sourceSnapshot: Prisma.JsonValue | null; status: string; owner: string | null;
    v22AssignmentId: string | null }>>`
    SELECT "id", "sourceSystem", "sourceSnapshot", "status", "owner",
      "v22AssignmentId" FROM "AmuxWorkItem" WHERE "id" = ${attempt.taskId}
      FOR UPDATE
  `;
  const task = taskRows[0];
  if (!task || task.sourceSystem !== "admin-idea-v4" ||
      task.status !== "doing" || task.owner !== prepared.worker ||
      task.v22AssignmentId !== attempt.v22AssignmentId ||
      v22TaskResultIdeaId(task.sourceSnapshot) !== prepared.ideaId)
    throw new AmuxV22TaskResultError("binding_mismatch");
  const prior = await tx.amuxV22TaskResult.findUnique({
    where: { attemptId: prepared.attemptId },
    select: { sourceSha256: true, taskId: true, ideaId: true },
  });
  if (prior) {
    const priorPatch = await tx.amuxV22TaskPatch.findUnique({
      where: { attemptId: prepared.attemptId },
      select: { patchSha256: true, baseSha: true, digest: true,
        digestKeyId: true, byteLength: true },
    });
    // A duplicate compares the original submitted evidence. Run eligibility
    // can change after the first commit; it must not rewrite that history.
    const sameEvidence = prepared.patch ? priorPatch !== null &&
      priorPatch.patchSha256 === prepared.patch.sha256 &&
      priorPatch.baseSha === prepared.patch.baseSha &&
      priorPatch.digest === prepared.patch.sealed.digest &&
      priorPatch.digestKeyId === prepared.patch.sealed.digestKeyId &&
      priorPatch.byteLength === prepared.patch.byteLength : priorPatch === null;
    if (prior.sourceSha256 !== prepared.sourceSha256 ||
        prior.taskId !== task.id || prior.ideaId !== prepared.ideaId ||
        !sameEvidence)
      throw new AmuxV22TaskResultError("result_conflict");
    return { attemptId: prepared.attemptId, sourceSha256: prepared.sourceSha256,
      patchSha256: priorPatch?.patchSha256 ?? null, duplicate: true };
  }
  // A key the retention queued for deletion never seals a new body: its
  // ledger row is unique, so that body could never be retired.
  const retired = await tx.amuxIdeaContentKeyRetirement.findMany({
    where: { ideaId: prepared.ideaId, subjectId: prepared.attemptId,
      purpose: { in: ["task_result", "task_patch"] } },
    select: { purpose: true } });
  if (retired.some((row) => row.purpose === "task_result"))
    throw new AmuxV22TaskResultError("binding_mismatch");
  let patch = retired.some((row) => row.purpose === "task_patch") ?
    null : prepared.patch;
  if (patch) {
    const assignment = await tx.amuxV22WorkerAssignment.findUnique({
      where: { id: attempt.v22AssignmentId },
      select: { role: true, workItemId: true },
    });
    if (!amuxV22TaskWritesPatch(assignment?.role) || assignment!.workItemId !== task.id)
      patch = null;
    // A patch is a private Task result first. A missing, finished or
    // base-mismatched Engineering run must not erase it; the Publisher
    // verifies the current run and base separately before exposing bytes.
  }
  await tx.amuxV22TaskResult.create({ data: {
    attemptId: prepared.attemptId, taskId: task.id, ideaId: prepared.ideaId,
    ciphertext: bytea(prepared.sealed.ciphertext), keyId: prepared.sealed.keyId,
    keyVersion: prepared.sealed.keyVersion, digest: prepared.sealed.digest,
    digestKeyId: prepared.sealed.digestKeyId,
    sourceSha256: prepared.sourceSha256, byteLength: prepared.byteLength,
    conclusionVerdict: prepared.conclusion?.verdict ?? null,
    conclusionSha256: prepared.conclusion?.sha256 ?? null,
  }, select: CREATED });
  if (patch) {
    await tx.amuxV22TaskPatch.create({ data: {
      attemptId: prepared.attemptId, taskId: task.id, ideaId: prepared.ideaId,
      ciphertext: bytea(patch.sealed.ciphertext),
      keyId: patch.sealed.keyId, keyVersion: patch.sealed.keyVersion,
      digest: patch.sealed.digest, digestKeyId: patch.sealed.digestKeyId,
      patchSha256: patch.sha256, baseSha: patch.baseSha,
      byteLength: patch.byteLength,
    }, select: CREATED });
  }
  // The staging this commit recorded goes with it. A patch it did not keep
  // stays for the retention sweep, which queues that unit key's deletion.
  const consumed = prepared.staging.filter((part) =>
    part === "result" || (part === "patch" && patch !== null));
  if (consumed.length)
    await tx.amuxV22TransferPart.deleteMany({ where: {
      attemptId: prepared.attemptId, part: { in: consumed } } });
  // A result whose last line is an owner question parks the Task at
  // settlement instead of sending it to review (v22OwnerQuestionCore.ts).
  // While an earlier question still waits, a new one is not recorded.
  let questionSequence: number | null = null;
  if (prepared.questionSha256) {
    // A question still open from an earlier attempt was never parked (that
    // run was lost); it is closed rather than let it hide this one.
    await tx.amuxV22TaskQuestion.updateMany({ where: { taskId: task.id,
      state: "open", attemptId: { not: prepared.attemptId } },
      data: { state: "cancelled" } });
    const asked = await tx.amuxV22TaskQuestion.findMany({
      where: { taskId: task.id }, select: { sequence: true, state: true },
    });
    if (!asked.some((row) => row.state === "open" || row.state === "answered")) {
      questionSequence = asked.reduce((max, row) =>
        Math.max(max, row.sequence), 0) + 1;
      await tx.amuxV22TaskQuestion.create({ data: {
        id: randomUUID(), taskId: task.id, attemptId: prepared.attemptId,
        worker: prepared.worker, sequence: questionSequence,
        questionSha256: prepared.questionSha256,
        state: amuxV22OwnerQuestionSettlement().questionState,
      } });
    }
  }
  await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: "amux.v22.task_result.recorded",
    targetType: "AmuxV22TaskResult", targetId: prepared.attemptId,
    summary: "Recorded one encrypted v22 Task result.",
    metadata: { taskId: task.id, sourceSha256: prepared.sourceSha256,
      byteLength: prepared.byteLength,
      patchSha256: patch?.sha256 ?? null, ownerQuestionSequence: questionSequence,
      conclusionVerdict: prepared.conclusion?.verdict ?? null },
  });
  return { attemptId: prepared.attemptId, sourceSha256: prepared.sourceSha256,
    patchSha256: patch?.sha256 ?? null, duplicate: false };
}

/** Owner-only callers may read one retained result; no plaintext is logged. */
export async function readAmuxV22TaskResultForOwner(taskId: string) {
  const row = await prisma.amuxV22TaskResult.findFirst({
    where: { taskId }, orderBy: [{ createdAt: "desc" }, { attemptId: "desc" }],
    select: { attemptId: true, ideaId: true,
      keyId: true, keyVersion: true, digest: true, digestKeyId: true,
      sourceSha256: true, bodyPurgedAt: true, createdAt: true },
  });
  if (!row) return null;
  const patch = await prisma.amuxV22TaskPatch.findUnique({
    where: { attemptId: row.attemptId },
    select: { ideaId: true, keyId: true,
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
    const text = await openAmuxV22TaskPatchRow(row.attemptId, patch);
    readablePatch = text === null ? { state: "purged" } :
      { state: "available", baseSha: patch.baseSha, sha256: patch.patchSha256, text };
  }
  const text = await openAmuxV22TaskResultRow(row.attemptId, row);
  if (text === null)
    return { attemptId: row.attemptId, state: "purged" as const,
      createdAt: row.createdAt.toISOString(), patch: readablePatch };
  return { attemptId: row.attemptId, state: "available" as const,
    createdAt: row.createdAt.toISOString(), text, patch: readablePatch };
}

/** Internal verification only. Never return this object to the publisher or
 * a client; publication gets the patch only through its scoped capability. */
export async function readAmuxV22TaskPatchEvidence(attemptId: string,
  taskId: string): Promise<{ text: string; files: V22PublishFile[] | null;
  sha256: string; baseSha: string } | null> {
  const patch = await prisma.amuxV22TaskPatch.findUnique({
    where: { attemptId },
    select: { taskId: true, ideaId: true,
      keyId: true, keyVersion: true, digest: true, digestKeyId: true,
      patchSha256: true, baseSha: true, bodyPurgedAt: true },
  });
  if (!patch || patch.bodyPurgedAt || patch.taskId !== taskId ||
      !patch.keyId || !patch.keyVersion) return null;
  const plain = await openSealedRow(attemptId, "task_patch", patch);
  if (!plain) return null;
  try {
    const evidence = decodeV22PatchEvidence(plain);
    if (v22TaskPatchSha256(evidence.text) !== patch.patchSha256)
      throw new AmuxV22TaskResultError("result_invalid");
    return { ...evidence, sha256: patch.patchSha256,
      baseSha: patch.baseSha };
  } finally { plain.fill(0); }
}

/** A sealed v22 row without its body: the body is read in slices, outside
 * the caller's transaction (lib/amux/sealedByteaRead.ts). */
export type AmuxV22SealedRow = { ideaId: string;
  keyId: string | null; keyVersion: number | null; digest: string;
  digestKeyId: string; bodyPurgedAt: Date | null };

/** Opens one sealed v22 row's body and checks its HMAC. Null when the body is
 * purged, before the read or while it ran (the rows are immutable but for
 * that). The caller zeroes the bytes. */
async function openSealedRow(attemptId: string,
  purpose: "task_result" | "task_patch", row: AmuxV22SealedRow): Promise<Buffer | null> {
  if (row.bodyPurgedAt || !row.keyId || !row.keyVersion) return null;
  const keys = await loadAmuxContentUnitKeys({ ideaId: row.ideaId,
    purpose, subjectId: attemptId });
  let ciphertext: Buffer | null = null;
  try {
    ciphertext = await readAmuxSealedBytea(purpose, attemptId);
    if (!ciphertext) return null;
    const plain = openAmuxContent({ ciphertext, keyId: row.keyId,
      keyVersion: row.keyVersion }, purpose, attemptId, keys);
    if (!verifyAmuxContentDigest(plain, purpose, attemptId,
      row.digest, row.digestKeyId, keys)) {
      plain.fill(0);
      throw new AmuxV22TaskResultError("result_invalid");
    }
    return plain;
  } finally { ciphertext?.fill(0); keys.masterKey.fill(0); }
}

/** Internal only: opens one attempt's retained result row read elsewhere (the
 * resumed delivery reads its rows inside its DB boundary; the body and the
 * keys are read outside it). Null when the body is purged. */
export async function openAmuxV22TaskResultRow(attemptId: string,
  row: AmuxV22SealedRow & { sourceSha256: string }): Promise<string | null> {
  const plain = await openSealedRow(attemptId, "task_result", row);
  if (!plain) return null;
  try {
    if (createHash("sha256").update(plain).digest("hex") !== row.sourceSha256)
      throw new AmuxV22TaskResultError("result_invalid");
    return plain.toString("utf8");
  } finally { plain.fill(0); }
}

/** Internal only: the same for one attempt's patch row. */
export async function openAmuxV22TaskPatchRow(attemptId: string,
  row: AmuxV22SealedRow & { patchSha256: string }): Promise<string | null> {
  const plain = await openSealedRow(attemptId, "task_patch", row);
  if (!plain) return null;
  try {
    const evidence = decodeV22PatchEvidence(plain);
    if (v22TaskPatchSha256(evidence.text) !== row.patchSha256)
      throw new AmuxV22TaskResultError("result_invalid");
    return evidence.text;
  } finally { plain.fill(0); }
}

import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

import { recordAmuxContentBodyPurge, type AmuxRetirableContent } from
  "@/lib/amux/ideaContentKeyRetirementService";
import { amuxContentDigest, openAmuxContent, sealAmuxContent,
  verifyAmuxContentDigest, type AmuxContentKeys } from "@/lib/amux/ideaCrypto";
import { AmuxIdeaKeyStoreError, createAmuxContentUnitKeys,
  loadAmuxContentUnitKeys, type AmuxContentKeyIdentity } from "@/lib/amux/ideaKeyStore";
import { AMUX_V22_STORAGE_MAX_BYTES, amuxV22SizeAllowanceMs,
  amuxV22TransferChunkCount, amuxV22TransferChunkRange,
  type AmuxV22TransferPart } from "@/lib/amux/v22TransferCore";
import { v22TaskResultIdeaId } from "@/lib/amux/v22TaskResultStore";
import { prisma } from "@/lib/prisma";

/**
 * Staging for a v22 run's result, patch and changed-path list while they
 * arrive from the box in chunks (docs/policy/amux-v22-result-transfer.md 2.1,
 * owner decision 2026-11-18). A chunk is sealed under the key its part's
 * final row uses, so nothing of a result is ever held in the clear; a commit
 * (v22TaskResultStore.ts, v22ChangedPathsStore.ts) assembles the chunks
 * outside its transaction and deletes the staging it recorded.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** The content purpose (and unit key) each part is sealed under. */
export const AMUX_V22_TRANSFER_PURPOSE = {
  result: "task_result",
  patch: "task_patch",
  changed_paths: "task_changed_paths",
} as const satisfies Record<AmuxV22TransferPart,
  AmuxRetirableContent["purpose"]>;

export type AmuxV22TransferRefusal = "binding_mismatch" | "upload_conflict" |
  "chunk_conflict" | "already_recorded" | "exceeds_storage";

/** What one part says it is: every chunk is checked against it. */
export type AmuxV22TransferHeader = {
  part: AmuxV22TransferPart;
  totalBytes: number;
  sha256: string;
  baseSha: string | null;
  count: number | null;
};

/** The attempt a transfer belongs to, as the result route has always bound it. */
export type AmuxV22TransferBinding = {
  attemptId: string;
  worker: string;
  taskId: string;
  ideaId: string;
};

const STAGING_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ENDED_AGE_MS = 60 * 60 * 1000;
const SWEEP_BATCH = 16;

/**
 * Create the unit key, or load it when an earlier call made it (a lost
 * answer, a failed transaction, the first chunk of a part). Used for every
 * v22 result commit, chunked or inline.
 */
export async function createOrLoadAmuxContentUnitKeys(
  identity: AmuxContentKeyIdentity,
): Promise<AmuxContentKeys> {
  try {
    return await createAmuxContentUnitKeys(identity);
  } catch (error) {
    if (error instanceof AmuxIdeaKeyStoreError && error.code === "conflict")
      return loadAmuxContentUnitKeys(identity);
    throw error;
  }
}

/** The binding the result route checks: a live v22 attempt of this worker on
 * its doing admin-idea-v4 Task. Null when any of it does not hold. */
export async function readAmuxV22TransferBinding(db: Db, attemptId: string,
  worker: string): Promise<AmuxV22TransferBinding | null> {
  const attempt = await db.amuxExecutionAttempt.findUnique({
    where: { id: attemptId }, select: { worker: true, endedAt: true,
      taskId: true, v22AssignmentId: true, task: { select: {
        sourceSystem: true, sourceSnapshot: true, status: true, owner: true,
        v22AssignmentId: true } } },
  });
  const ideaId = v22TaskResultIdeaId(attempt?.task.sourceSnapshot);
  if (!attempt || attempt.worker !== worker || attempt.endedAt ||
      !attempt.v22AssignmentId || !ideaId ||
      attempt.task.sourceSystem !== "admin-idea-v4" ||
      attempt.task.status !== "doing" || attempt.task.owner !== worker ||
      attempt.task.v22AssignmentId !== attempt.v22AssignmentId) return null;
  return { attemptId, worker, taskId: attempt.taskId, ideaId };
}

/** Whether the part's commit already happened: the result row closes the
 * result and the patch (a patch the commit did not keep is not taken later),
 * the changed-path row closes the list. */
export async function amuxV22TransferPartCommitted(db: Db, attemptId: string,
  part: AmuxV22TransferPart): Promise<boolean> {
  if (part === "changed_paths")
    return (await db.amuxV22TaskChangedPaths.findUnique({
      where: { attemptId }, select: { attemptId: true } })) !== null;
  return (await db.amuxV22TaskResult.findUnique({
    where: { attemptId }, select: { attemptId: true } })) !== null;
}

/** A unit key the retention queued for deletion is never written under
 * again: its ledger row is unique, so a second body could never be retired. */
export async function amuxV22TransferKeyRetired(db: Db, ideaId: string,
  part: AmuxV22TransferPart, attemptId: string): Promise<boolean> {
  return (await db.amuxIdeaContentKeyRetirement.findUnique({
    where: { ideaId_purpose_subjectId: { ideaId,
      purpose: AMUX_V22_TRANSFER_PURPOSE[part], subjectId: attemptId } },
    select: { ideaId: true },
  })) !== null;
}

const sameHeader = (row: { totalBytes: number; sha256: string;
  baseSha: string | null; pathCount: number | null }, header: AmuxV22TransferHeader) =>
  row.totalBytes === header.totalBytes && row.sha256 === header.sha256 &&
  row.baseSha === header.baseSha && row.pathCount === header.count;

const identityOf = (binding: AmuxV22TransferBinding,
  part: AmuxV22TransferPart): AmuxContentKeyIdentity => ({ ideaId: binding.ideaId,
  purpose: AMUX_V22_TRANSFER_PURPOSE[part], subjectId: binding.attemptId });

const sameBytes = (left: Buffer, right: Buffer) =>
  left.length === right.length && timingSafeEqual(left, right);

/** Whether a stored chunk holds these bytes: by its HMAC, or, when the digest
 * key has changed since it was stored, by opening it. */
function storedChunkHolds(row: { byteLength: number; ciphertext: Uint8Array;
  keyId: string; keyVersion: number; digest: string; digestKeyId: string },
  bytes: Buffer, purpose: AmuxRetirableContent["purpose"], attemptId: string,
  keys: AmuxContentKeys): boolean {
  if (row.byteLength !== bytes.length) return false;
  if (row.digestKeyId === keys.digestKeyId)
    return amuxContentDigest(bytes, purpose, attemptId, keys).digest === row.digest;
  let plain: Buffer | null = null;
  try {
    plain = openAmuxContent({ ciphertext: Buffer.from(row.ciphertext),
      keyId: row.keyId, keyVersion: row.keyVersion }, purpose, attemptId, keys);
    return sameBytes(plain, bytes);
  } catch { return false; }
  finally { plain?.fill(0); }
}

export type AmuxV22PutChunkResult =
  | { kind: "stored"; duplicate: boolean; received: number; chunkCount: number }
  | { kind: "refused"; code: AmuxV22TransferRefusal };

/**
 * Stores one chunk, idempotently: the same index with the same bytes is a
 * duplicate, other bytes are a chunk conflict, and another description of
 * the part is an upload conflict. The caller has checked the chunk's own
 * digest, its index and its length against the part's range.
 */
export async function putAmuxV22TransferChunk(input: AmuxV22TransferHeader & {
  attemptId: string; worker: string; index: number; bytes: Buffer;
}, db: PrismaClient = prisma): Promise<AmuxV22PutChunkResult> {
  const refused = (code: AmuxV22TransferRefusal) => ({ kind: "refused" as const, code });
  if (input.totalBytes > AMUX_V22_STORAGE_MAX_BYTES) return refused("exceeds_storage");
  const chunkCount = amuxV22TransferChunkCount(input.totalBytes);
  const range = amuxV22TransferChunkRange(input.totalBytes, input.index);
  if (input.bytes.length !== range.end - range.start)
    throw new RangeError("chunk length does not match its range");
  const binding = await readAmuxV22TransferBinding(db, input.attemptId, input.worker);
  if (!binding) return refused("binding_mismatch");
  if (await amuxV22TransferPartCommitted(db, input.attemptId, input.part))
    return refused("already_recorded");
  if (await amuxV22TransferKeyRetired(db, binding.ideaId, input.part, input.attemptId))
    return refused("binding_mismatch");
  const where = { attemptId_part: { attemptId: input.attemptId, part: input.part } };
  const prior = await db.amuxV22TransferPart.findUnique({ where,
    select: { totalBytes: true, sha256: true, baseSha: true, pathCount: true,
      taskId: true, ideaId: true, worker: true } });
  if (prior && (!sameHeader(prior, input) || prior.taskId !== binding.taskId ||
      prior.ideaId !== binding.ideaId || prior.worker !== binding.worker))
    return refused("upload_conflict");
  const purpose = AMUX_V22_TRANSFER_PURPOSE[input.part];
  const chunkWhere = { attemptId_part_index: { attemptId: input.attemptId,
    part: input.part, index: input.index } };
  const keys = await createOrLoadAmuxContentUnitKeys(identityOf(binding, input.part));
  let sealed: ReturnType<typeof sealAmuxContent> | null = null;
  try {
    const existing = await db.amuxV22TransferChunk.findUnique({ where: chunkWhere,
      select: { byteLength: true, ciphertext: true, keyId: true,
        keyVersion: true, digest: true, digestKeyId: true } });
    if (existing) {
      if (!storedChunkHolds(existing, input.bytes, purpose, input.attemptId, keys))
        return refused("chunk_conflict");
      const received = await db.amuxV22TransferChunk.count({
        where: { attemptId: input.attemptId, part: input.part } });
      return { kind: "stored", duplicate: true, received, chunkCount };
    }
    sealed = sealAmuxContent(input.bytes, purpose, input.attemptId, keys);
    const ciphertext = sealed.ciphertext;
    const allowance = amuxV22SizeAllowanceMs(ciphertext.length);
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', ${String(5_000 + allowance)}, true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', ${String(10_000 + allowance)}, true) AS idle_limit
      `;
      // KEY SHARE: a heartbeat still updates the attempt, a commit (FOR
      // UPDATE) waits for this chunk or sees it.
      const live = await tx.$queryRaw<Array<{ worker: string; endedAt: Date | null }>>`
        SELECT "worker", "endedAt" FROM "AmuxExecutionAttempt"
        WHERE "id" = ${input.attemptId} FOR KEY SHARE`;
      if (live[0]?.worker !== input.worker || live[0].endedAt)
        return refused("binding_mismatch");
      if (await amuxV22TransferPartCommitted(tx, input.attemptId, input.part))
        return refused("already_recorded");
      await tx.amuxV22TransferPart.createMany({ skipDuplicates: true, data: [{
        attemptId: input.attemptId, part: input.part, taskId: binding.taskId,
        ideaId: binding.ideaId, worker: binding.worker,
        totalBytes: input.totalBytes, sha256: input.sha256,
        baseSha: input.baseSha, pathCount: input.count }] });
      const header = await tx.amuxV22TransferPart.findUnique({ where,
        select: { totalBytes: true, sha256: true, baseSha: true, pathCount: true,
          taskId: true, ideaId: true } });
      if (!header || !sameHeader(header, input) || header.taskId !== binding.taskId ||
          header.ideaId !== binding.ideaId) return refused("upload_conflict");
      const inserted = await tx.amuxV22TransferChunk.createMany({ skipDuplicates: true,
        data: [{ attemptId: input.attemptId, part: input.part, index: input.index,
          byteLength: input.bytes.length,
          ciphertext: ciphertext as Uint8Array<ArrayBuffer>,
          keyId: sealed!.keyId, keyVersion: sealed!.keyVersion,
          digest: sealed!.digest, digestKeyId: sealed!.digestKeyId }] });
      let duplicate = false;
      if (inserted.count === 0) {
        // Another request stored this index first.
        const raced = await tx.amuxV22TransferChunk.findUnique({ where: chunkWhere,
          select: { byteLength: true, ciphertext: true, keyId: true,
            keyVersion: true, digest: true, digestKeyId: true } });
        if (!raced || !storedChunkHolds(raced, input.bytes, purpose,
          input.attemptId, keys)) return refused("chunk_conflict");
        duplicate = true;
      }
      const received = await tx.amuxV22TransferChunk.count({
        where: { attemptId: input.attemptId, part: input.part } });
      return { kind: "stored" as const, duplicate, received, chunkCount };
    }, { maxWait: 5_000, timeout: 10_000 + allowance });
  } finally {
    keys.masterKey.fill(0);
    sealed?.ciphertext.fill(0);
  }
}

export type AmuxV22TransferInspection =
  | { kind: "complete" }
  | { kind: "incomplete"; missing: number[] }
  | { kind: "header_mismatch" };

/** Which chunks of the part a commit still lacks, read without its bodies. */
export async function inspectAmuxV22TransferPart(db: Db, attemptId: string,
  header: AmuxV22TransferHeader): Promise<AmuxV22TransferInspection> {
  // A size past what one Postgres value stores is refused before its chunk
  // list is built: every caller bounds it first, and this holds the class.
  if (header.totalBytes > AMUX_V22_STORAGE_MAX_BYTES)
    throw new RangeError("transfer part exceeds storage");
  const count = amuxV22TransferChunkCount(header.totalBytes);
  const all = () => Array.from({ length: count }, (_, index) => index);
  const row = await db.amuxV22TransferPart.findUnique({
    where: { attemptId_part: { attemptId, part: header.part } },
    select: { totalBytes: true, sha256: true, baseSha: true, pathCount: true },
  });
  if (!row) return { kind: "incomplete", missing: all() };
  if (!sameHeader(row, header)) return { kind: "header_mismatch" };
  const chunks = await db.amuxV22TransferChunk.findMany({
    where: { attemptId, part: header.part }, select: { index: true } });
  const present = new Set(chunks.map((chunk) => chunk.index));
  const missing = all().filter((index) => !present.has(index));
  return missing.length ? { kind: "incomplete", missing } : { kind: "complete" };
}

export type AmuxV22AssembledPart =
  | { kind: "assembled"; bytes: Buffer }
  | { kind: "incomplete"; missing: number[] }
  | { kind: "digest_mismatch" };

/**
 * Opens every chunk of a complete part, one at a time, into one buffer, and
 * checks each chunk's HMAC and the whole part's sha256: a reordered or
 * substituted chunk fails here. Outside any transaction. The caller zeroes
 * the bytes it receives.
 */
export async function assembleAmuxV22TransferPart(attemptId: string,
  header: AmuxV22TransferHeader, keys: AmuxContentKeys,
  db: Db = prisma): Promise<AmuxV22AssembledPart> {
  const inspection = await inspectAmuxV22TransferPart(db, attemptId, header);
  if (inspection.kind === "header_mismatch") return { kind: "digest_mismatch" };
  if (inspection.kind === "incomplete") return inspection;
  const purpose = AMUX_V22_TRANSFER_PURPOSE[header.part];
  const count = amuxV22TransferChunkCount(header.totalBytes);
  const bytes = Buffer.allocUnsafe(header.totalBytes);
  let complete = false;
  try {
    for (let index = 0; index < count; index += 1) {
      const range = amuxV22TransferChunkRange(header.totalBytes, index);
      const row = await db.amuxV22TransferChunk.findUnique({
        where: { attemptId_part_index: { attemptId, part: header.part, index } },
        select: { byteLength: true, ciphertext: true, keyId: true,
          keyVersion: true, digest: true, digestKeyId: true } });
      if (!row) return { kind: "incomplete", missing: [index] };
      if (row.byteLength !== range.end - range.start)
        return { kind: "digest_mismatch" };
      let plain: Buffer | null = null;
      try {
        plain = openAmuxContent({ ciphertext: Buffer.from(row.ciphertext),
          keyId: row.keyId, keyVersion: row.keyVersion }, purpose, attemptId, keys);
        if (plain.length !== row.byteLength || !verifyAmuxContentDigest(plain,
          purpose, attemptId, row.digest, row.digestKeyId, keys))
          return { kind: "digest_mismatch" };
        plain.copy(bytes, range.start);
      } catch { return { kind: "digest_mismatch" }; }
      finally { plain?.fill(0); }
    }
    if (createHash("sha256").update(bytes).digest("hex") !== header.sha256)
      return { kind: "digest_mismatch" };
    complete = true;
    return { kind: "assembled", bytes };
  } finally { if (!complete) bytes.fill(0); }
}

/** Deletes the parts' staging rows (the chunks go with them). */
export async function deleteAmuxV22TransferParts(db: Db, attemptId: string,
  parts: readonly AmuxV22TransferPart[]): Promise<number> {
  if (parts.length === 0) return 0;
  const deleted = await db.amuxV22TransferPart.deleteMany({
    where: { attemptId, part: { in: [...parts] } } });
  return deleted.count;
}

type SweepCandidate = { attemptId: string; part: AmuxV22TransferPart;
  ideaId: string; taskId: string };

async function sweepOne(tx: Prisma.TransactionClient,
  candidate: SweepCandidate): Promise<{ swept: boolean; keyQueued: boolean }> {
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  // The attempt first, as a commit locks it, so the two never cross.
  await tx.$queryRaw`SELECT "id" FROM "AmuxExecutionAttempt"
    WHERE "id" = ${candidate.attemptId} FOR UPDATE`;
  const due = await tx.$queryRaw<Array<{ ideaId: string; due: boolean }>>`
    SELECT p."ideaId", (
      p."createdAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${STAGING_AGE_MS / 1000}) OR
      (a."endedAt" IS NOT NULL AND
        a."endedAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${ENDED_AGE_MS / 1000})) OR
      (p."part" IN ('result', 'patch') AND EXISTS (SELECT 1 FROM "AmuxV22TaskResult" r
        WHERE r."attemptId" = p."attemptId")) OR
      (p."part" = 'changed_paths' AND EXISTS (SELECT 1 FROM "AmuxV22TaskChangedPaths" c
        WHERE c."attemptId" = p."attemptId"))) AS "due"
    FROM "AmuxV22TransferPart" p
    JOIN "AmuxExecutionAttempt" a ON a."id" = p."attemptId"
    WHERE p."attemptId" = ${candidate.attemptId} AND p."part" = ${candidate.part}`;
  if (!due[0]?.due) return { swept: false, keyQueued: false };
  await deleteAmuxV22TransferParts(tx, candidate.attemptId, [candidate.part]);
  // The chunks were sealed under the key of the part's final row. With no
  // final row that key holds nothing any more, so its deletion is queued.
  const finalRow = candidate.part === "result" ?
    await tx.amuxV22TaskResult.findUnique({ where: { attemptId: candidate.attemptId },
      select: { attemptId: true } }) :
    candidate.part === "patch" ?
      await tx.amuxV22TaskPatch.findUnique({ where: { attemptId: candidate.attemptId },
        select: { attemptId: true } }) :
      await tx.amuxV22TaskChangedPaths.findUnique({
        where: { attemptId: candidate.attemptId }, select: { attemptId: true } });
  if (finalRow || await amuxV22TransferKeyRetired(tx, due[0].ideaId,
    candidate.part, candidate.attemptId)) return { swept: true, keyQueued: false };
  const now = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"`;
  await recordAmuxContentBodyPurge(tx, { ideaId: due[0].ideaId,
    purpose: AMUX_V22_TRANSFER_PURPOSE[candidate.part],
    subjectId: candidate.attemptId }, now[0]!.now);
  return { swept: true, keyQueued: true };
}

/**
 * Removes staging no commit will take (docs/policy/amux-v22-result-transfer.md
 * 2.6): its part was committed, its attempt ended more than an hour ago, or
 * it is more than seven days old. A swept part whose purpose has no final row
 * leaves its unit key to the retention's key deletion.
 */
export async function sweepAmuxV22TransferStaging(db: PrismaClient = prisma) {
  const candidates = await db.$queryRaw<SweepCandidate[]>`
    SELECT p."attemptId", p."part", p."ideaId", p."taskId"
    FROM "AmuxV22TransferPart" p
    JOIN "AmuxExecutionAttempt" a ON a."id" = p."attemptId"
    WHERE p."createdAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${STAGING_AGE_MS / 1000})
      OR (a."endedAt" IS NOT NULL AND
        a."endedAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${ENDED_AGE_MS / 1000}))
      OR (p."part" IN ('result', 'patch') AND EXISTS (SELECT 1 FROM "AmuxV22TaskResult" r
        WHERE r."attemptId" = p."attemptId"))
      OR (p."part" = 'changed_paths' AND EXISTS (SELECT 1 FROM "AmuxV22TaskChangedPaths" c
        WHERE c."attemptId" = p."attemptId"))
    ORDER BY p."createdAt", p."attemptId", p."part"
    LIMIT ${SWEEP_BATCH}`;
  let partsSwept = 0;
  let keysQueued = 0;
  for (const candidate of candidates) {
    const outcome = await db.$transaction((tx) => sweepOne(tx, candidate),
      { maxWait: 3_000, timeout: 12_000 });
    if (outcome.swept) partsSwept += 1;
    if (outcome.keyQueued) keysQueued += 1;
  }
  return { partsSwept, keysQueued, scanned: candidates.length };
}

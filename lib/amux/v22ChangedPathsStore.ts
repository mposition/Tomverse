import "server-only";

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import { openAmuxContent, sealAmuxContent, verifyAmuxContentDigest,
  type SealedAmuxContent } from "@/lib/amux/ideaCrypto";
import { loadAmuxContentUnitKeys } from "@/lib/amux/ideaKeyStore";
import { readAmuxSealedBytea } from "@/lib/amux/sealedByteaRead";
import { AMUX_V22_PRISMA_BYTES_WRITE_MAX_BYTES } from "@/lib/amux/v22TaskResultStore";
import { AMUX_V22_EMPTY_SHA256, amuxV22SizeAllowanceMs,
  decodeAmuxV22ChangedPaths } from "@/lib/amux/v22TransferCore";
import { amuxV22TransferKeyRetired, assembleAmuxV22TransferPart,
  createOrLoadAmuxContentUnitKeys, deleteAmuxV22TransferParts,
  inspectAmuxV22TransferPart, readAmuxV22TransferBinding,
  type AmuxV22TransferHeader } from "@/lib/amux/v22TransferStore";
import { prisma } from "@/lib/prisma";
import { classifyAmuxV22NamedChangedPaths, type AmuxV22NamedChangedPathsBody } from
  "@/lib/amux/v22ChangedPathsCore";

/**
 * A v22 run's changed-path list, recorded as its own sealed body
 * (docs/policy/amux-v22-result-transfer.md 2.3, owner decision 2026-11-18).
 * It travels in chunks like the result, but commits on its own, because a run
 * that left no result still settles with its paths. Settlement and the v52
 * review record then name it by digest and count, and their routes open it
 * outside the DB boundary.
 */

export type AmuxV22ChangedPathsCommitResult =
  | { kind: "recorded"; sha256: string; count: number; duplicate: boolean }
  | { kind: "refused"; code: "binding_mismatch" | "paths_conflict" | "paths_invalid" }
  | { kind: "incomplete"; missing: number[] }
  | { kind: "digest_mismatch" };

const header = (input: { sha256: string; count: number; bytes: number }):
  AmuxV22TransferHeader => ({ part: "changed_paths", totalBytes: input.bytes,
  sha256: input.sha256, baseSha: null, count: input.count });

/**
 * Records the list whose chunks the box uploaded. A second commit of the same
 * digest, count and size is a duplicate; any other is a conflict. Staging the
 * commit cannot use (another description, a chunk that fails its HMAC, a
 * list that does not decode) is deleted so the box uploads it again.
 */
export async function commitAmuxV22ChangedPaths(input: { attemptId: string;
  worker: string; sha256: string; count: number; bytes: number },
  db: PrismaClient = prisma): Promise<AmuxV22ChangedPathsCommitResult> {
  const prior = await db.amuxV22TaskChangedPaths.findUnique({
    where: { attemptId: input.attemptId },
    select: { pathsSha256: true, pathCount: true, byteLength: true } });
  if (prior) return prior.pathsSha256 === input.sha256 &&
    prior.pathCount === input.count && prior.byteLength === input.bytes ?
    { kind: "recorded", sha256: input.sha256, count: input.count, duplicate: true } :
    { kind: "refused", code: "paths_conflict" };
  const binding = await readAmuxV22TransferBinding(db, input.attemptId, input.worker);
  if (!binding || await amuxV22TransferKeyRetired(db, binding.ideaId,
    "changed_paths", input.attemptId)) return { kind: "refused", code: "binding_mismatch" };
  const described = header(input);
  const inspection = await inspectAmuxV22TransferPart(db, input.attemptId, described);
  if (inspection.kind === "header_mismatch") {
    await deleteAmuxV22TransferParts(db, input.attemptId, ["changed_paths"]);
    return { kind: "digest_mismatch" };
  }
  if (inspection.kind === "incomplete") return inspection;
  const keys = await createOrLoadAmuxContentUnitKeys({ ideaId: binding.ideaId,
    purpose: "task_changed_paths", subjectId: input.attemptId });
  let sealed: SealedAmuxContent | null = null;
  try {
    const assembled = await assembleAmuxV22TransferPart(input.attemptId,
      described, keys, db);
    if (assembled.kind === "incomplete") return assembled;
    if (assembled.kind === "digest_mismatch") {
      await deleteAmuxV22TransferParts(db, input.attemptId, ["changed_paths"]);
      return assembled;
    }
    try {
      try { decodeAmuxV22ChangedPaths(assembled.bytes, input.count); }
      catch {
        await deleteAmuxV22TransferParts(db, input.attemptId, ["changed_paths"]);
        return { kind: "refused", code: "paths_invalid" };
      }
      sealed = sealAmuxContent(assembled.bytes, "task_changed_paths",
        input.attemptId, keys);
    } finally { assembled.bytes.fill(0); }
    // A list Prisma cannot write (one base64 string, v22TaskResultStore.ts)
    // gets one answer; the bridge settles without its paths.
    if (sealed.ciphertext.length > AMUX_V22_PRISMA_BYTES_WRITE_MAX_BYTES) {
      await deleteAmuxV22TransferParts(db, input.attemptId, ["changed_paths"]);
      return { kind: "refused", code: "paths_invalid" };
    }
    const seal = sealed;
    const allowance = amuxV22SizeAllowanceMs(seal.ciphertext.length);
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', ${String(5_000 + allowance)}, true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', ${String(10_000 + allowance)}, true) AS idle_limit
      `;
      const locked = await tx.$queryRaw<Array<{ taskId: string; worker: string;
        endedAt: Date | null }>>`
        SELECT "taskId", "worker", "endedAt" FROM "AmuxExecutionAttempt"
        WHERE "id" = ${input.attemptId} FOR UPDATE`;
      const attempt = locked[0];
      if (!attempt || attempt.worker !== input.worker || attempt.endedAt ||
          attempt.taskId !== binding.taskId)
        return { kind: "refused" as const, code: "binding_mismatch" as const };
      const raced = await tx.amuxV22TaskChangedPaths.findUnique({
        where: { attemptId: input.attemptId },
        select: { pathsSha256: true, pathCount: true, byteLength: true } });
      if (raced) return raced.pathsSha256 === input.sha256 &&
        raced.pathCount === input.count && raced.byteLength === input.bytes ?
        { kind: "recorded" as const, sha256: input.sha256, count: input.count,
          duplicate: true } :
        { kind: "refused" as const, code: "paths_conflict" as const };
      await tx.amuxV22TaskChangedPaths.create({ data: {
        attemptId: input.attemptId, taskId: binding.taskId, ideaId: binding.ideaId,
        ciphertext: seal.ciphertext as unknown as Uint8Array<ArrayBuffer>,
        keyId: seal.keyId, keyVersion: seal.keyVersion, digest: seal.digest,
        digestKeyId: seal.digestKeyId, pathsSha256: input.sha256,
        pathCount: input.count, byteLength: input.bytes },
        // A create returns the row it wrote; this one returns its key alone.
        select: { attemptId: true } });
      await deleteAmuxV22TransferParts(tx, input.attemptId, ["changed_paths"]);
      return { kind: "recorded" as const, sha256: input.sha256, count: input.count,
        duplicate: false };
    }, { maxWait: 5_000, timeout: 10_000 + allowance });
  } finally {
    keys.masterKey.fill(0);
    sealed?.ciphertext.fill(0);
  }
}

/** The readback the bridge resolves a lost commit with. */
export async function readAmuxV22ChangedPathsRecord(attemptId: string,
  db: PrismaClient = prisma) {
  const row = await db.amuxV22TaskChangedPaths.findUnique({ where: { attemptId },
    select: { pathsSha256: true, pathCount: true, byteLength: true,
      bodyPurgedAt: true } });
  return row ? { status: "recorded" as const, attemptId, sha256: row.pathsSha256,
    count: row.pathCount, bytes: row.byteLength,
    bodyAvailable: row.bodyPurgedAt === null } : { status: "absent" as const };
}

/**
 * What a settlement or review record body says about its changed paths
 * (lib/amux/v22ChangedPathsCore.ts), with a named list opened here: `paths`,
 * or `unrecorded` when the attempt holds no such list.
 */
export async function resolveAmuxV22NamedChangedPaths(attemptId: string,
  body: AmuxV22NamedChangedPathsBody,
  db: PrismaClient = prisma): Promise<AmuxV22ChangedPathsOpen | { kind: "absent" } |
  { kind: "invalid" }> {
  const named = classifyAmuxV22NamedChangedPaths(body);
  if (named.kind !== "named") return named;
  return openAmuxV22ChangedPaths(attemptId, named, db);
}

/** A settlement's or review record's time allowance: the patch it judges and
 * the list it opens, by their recorded sizes. */
export async function amuxV22SettlementAllowanceMs(attemptId: string,
  db: PrismaClient = prisma): Promise<number> {
  const [patch, paths] = await Promise.all([
    db.amuxV22TaskPatch.findUnique({ where: { attemptId }, select: { byteLength: true } }),
    db.amuxV22TaskChangedPaths.findUnique({ where: { attemptId },
      select: { byteLength: true } }),
  ]);
  return amuxV22SizeAllowanceMs((patch?.byteLength ?? 0) + (paths?.byteLength ?? 0));
}

export type AmuxV22ChangedPathsOpen =
  | { kind: "paths"; paths: string[] }
  | { kind: "unrecorded" };

/**
 * The list a settlement or review record names by digest and count. The
 * empty digest with no paths is the empty list, recorded nowhere. Anything
 * else must be the attempt's recorded list, its body still there, opening to
 * the same digest and count; otherwise it is unrecorded, and the bridge
 * commits the list again before it settles.
 */
export async function openAmuxV22ChangedPaths(attemptId: string,
  named: { sha256: string; count: number },
  db: PrismaClient = prisma): Promise<AmuxV22ChangedPathsOpen> {
  if (named.sha256 === AMUX_V22_EMPTY_SHA256 && named.count === 0)
    return { kind: "paths", paths: [] };
  const row = await db.amuxV22TaskChangedPaths.findUnique({ where: { attemptId },
    select: { ideaId: true, keyId: true, keyVersion: true, digest: true,
      digestKeyId: true, pathsSha256: true, pathCount: true, bodyPurgedAt: true } });
  if (!row || row.pathsSha256 !== named.sha256 || row.pathCount !== named.count ||
      row.bodyPurgedAt || !row.keyId || !row.keyVersion) return { kind: "unrecorded" };
  const keys = await loadAmuxContentUnitKeys({ ideaId: row.ideaId,
    purpose: "task_changed_paths", subjectId: attemptId });
  let ciphertext: Buffer | null = null;
  let plain: Buffer | null = null;
  try {
    ciphertext = await readAmuxSealedBytea("task_changed_paths", attemptId, db);
    if (!ciphertext) return { kind: "unrecorded" };
    plain = openAmuxContent({ ciphertext, keyId: row.keyId,
      keyVersion: row.keyVersion }, "task_changed_paths", attemptId, keys);
    if (!verifyAmuxContentDigest(plain, "task_changed_paths", attemptId,
        row.digest, row.digestKeyId, keys) ||
        createHash("sha256").update(plain).digest("hex") !== row.pathsSha256)
      return { kind: "unrecorded" };
    return { kind: "paths", paths: decodeAmuxV22ChangedPaths(plain, row.pathCount) };
  } finally { ciphertext?.fill(0); plain?.fill(0); keys.masterKey.fill(0); }
}

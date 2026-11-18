export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { amuxContentDigest, type AmuxContentKeys } from "@/lib/amux/ideaCrypto";
import { loadAmuxContentUnitKeys } from "@/lib/amux/ideaKeyStore";
import { normalizeV22OptionalPatch } from "@/lib/amux/v22OptionalPatch";
import { AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES } from "@/lib/amux/v22PatchLimit";
import { encodeV22PatchEvidence, v22PublishFilesSha256 } from
  "@/lib/amux/v22PatchEvidence";
import { AmuxV22TaskResultError, amuxV22TaskResultTransactionOptions,
  prepareAmuxV22TaskResultRecord, recordAmuxV22TaskResult,
  readAmuxV22TaskPatchEvidence, v22TaskResultSha256,
  type PreparedAmuxV22TaskResult } from "@/lib/amux/v22TaskResultStore";
import { AMUX_V22_PROXY_BODY_MAX_BYTES, AMUX_V22_STORAGE_MAX_BYTES,
  type AmuxV22TransferPart } from
  "@/lib/amux/v22TransferCore";
import { assembleAmuxV22TransferPart, createOrLoadAmuxContentUnitKeys,
  deleteAmuxV22TransferParts, inspectAmuxV22TransferPart,
  readAmuxV22TransferBinding, type AmuxV22TransferBinding,
  type AmuxV22TransferHeader } from "@/lib/amux/v22TransferStore";
import { prisma } from "@/lib/prisma";

/**
 * The v22 result commit (docs/policy/amux-v22-result-transfer.md 1.6 2 and 3).
 * A body with `transfer` commits a result whose chunks the box uploaded; a
 * body with `resultText` is the old inline result of a bridge from before the
 * chunked transfer, read up to the proxy buffer. The answer keys and status
 * codes are the Rust bridge's contract.
 */
const id = z.string().uuid();
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const worker = z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/);
const inlineSchema = z.object({
  attemptId: id, worker,
  resultText: z.string().min(1),
  sourceSha256: hex64,
  // Patch evidence is an optional private result. A malformed or unsafe patch
  // must not discard the already-paid Task response.
  patch: z.unknown().optional(),
}).strict();
const chunkedSchema = z.object({
  attemptId: id, worker,
  transfer: z.literal("chunked_v1"),
  sourceSha256: hex64,
  resultBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  patch: z.object({ sha256: hex64, baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
}).strict();
const bodySchema = z.union([chunkedSchema, inlineSchema]);

export async function GET(request: Request): Promise<Response> {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].length !== 1 || !query.has("attemptId"))
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  const attemptId = id.safeParse(query.get("attemptId"));
  if (!attemptId.success) return amuxJsonNoStore({ error: "Invalid request." }, 400);
  try {
    const result = await prisma.amuxV22TaskResult.findUnique({
      where: { attemptId: attemptId.data },
      select: { sourceSha256: true, bodyPurgedAt: true, byteLength: true },
    });
    const patch = result ? await prisma.amuxV22TaskPatch.findUnique({
      where: { attemptId: attemptId.data },
      select: { patchSha256: true, baseSha: true, byteLength: true,
        bodyPurgedAt: true, taskId: true },
    }) : null;
    // Only a row that may hold the old JSON (files) evidence is opened for its
    // files digest; a larger one is text evidence and is never opened here.
    const mayHoldFiles = patch !== null && patch.bodyPurgedAt === null &&
      patch.byteLength <= AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES;
    const evidence = mayHoldFiles ?
      await readAmuxV22TaskPatchEvidence(attemptId.data, patch.taskId) : null;
    if (mayHoldFiles && !evidence)
      return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
    return amuxJsonNoStore(result ? { status: "recorded",
      attemptId: attemptId.data, sourceSha256: result.sourceSha256,
      resultBytes: result.byteLength,
      bodyAvailable: result.bodyPurgedAt === null,
      patch: patch ? { sha256: patch.patchSha256, baseSha: patch.baseSha,
        bytes: patch.byteLength,
        bodyAvailable: patch.bodyPurgedAt === null,
        filesDigest: evidence?.files ?
          v22PublishFilesSha256(evidence.files) : null } : null } :
      { status: "absent" });
  } catch { return amuxJsonNoStore({ error: "outcome_unknown" }, 503); }
}

/** Records one prepared result in its own transaction. A refusal the store
 * raised before the callback returned is the store's answer; anything else
 * is unknown. */
async function commit(prepared: PreparedAmuxV22TaskResult) {
  let callbackReturned = false;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const value = await recordAmuxV22TaskResult(tx, prepared);
      callbackReturned = true;
      return value;
    }, amuxV22TaskResultTransactionOptions(prepared));
    return { ok: true as const, result };
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxV22TaskResultError)
      return { ok: false as const, response: amuxJsonNoStore({ error: error.code }, 409) };
    return { ok: false as const,
      response: amuxJsonNoStore({ error: "outcome_unknown" }, 503) };
  } finally { prepared.dispose(); }
}

export async function POST(request: Request): Promise<Response> {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json")
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  let body: z.infer<typeof bodySchema>;
  try {
    // An external bound on one request (Next.js proxy buffer), not ours.
    body = await readLimitedJson(request, AMUX_V22_PROXY_BODY_MAX_BYTES, bodySchema);
    if ("resultText" in body && v22TaskResultSha256(body.resultText) !== body.sourceSha256)
      return amuxJsonNoStore({ error: "Invalid request." }, 400);
  } catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  return "transfer" in body ? postChunked(body) : postInline(body);
}

async function postInline(body: z.infer<typeof inlineSchema>): Promise<Response> {
  let { patch, patchRejected } = normalizeV22OptionalPatch(body.patch);
  try {
    const prior = await prisma.amuxV22TaskResult.findUnique({
      where: { attemptId: body.attemptId },
      select: { sourceSha256: true, bodyPurgedAt: true },
    });
    if (prior?.bodyPurgedAt) return amuxJsonNoStore({ error: "result_expired" }, 409);
    const priorPatch = prior ? await prisma.amuxV22TaskPatch.findUnique({
      where: { attemptId: body.attemptId },
      select: { patchSha256: true, baseSha: true,
        bodyPurgedAt: true, digest: true, digestKeyId: true,
        byteLength: true, ideaId: true },
    }) : null;
    if (priorPatch?.bodyPurgedAt)
      return amuxJsonNoStore({ error: "result_expired" }, 409);
    let sameEvidence = patch ? false : priorPatch === null;
    if (patch && priorPatch && !priorPatch.bodyPurgedAt &&
        priorPatch.patchSha256 === patch.sha256 &&
        priorPatch.baseSha === patch.baseSha) {
      const keys = await loadAmuxContentUnitKeys({ ideaId: priorPatch.ideaId,
        purpose: "task_patch", subjectId: body.attemptId });
      const evidence = encodeV22PatchEvidence(patch.text,
        patch.files);
      try {
        const digest = amuxContentDigest(evidence, "task_patch",
          body.attemptId, keys);
        sameEvidence = digest.digest === priorPatch.digest &&
          digest.digestKeyId === priorPatch.digestKeyId &&
          evidence.length === priorPatch.byteLength;
      } finally { evidence.fill(0); keys.masterKey.fill(0); }
    }
    if (prior) return prior.sourceSha256 === body.sourceSha256 &&
      sameEvidence ?
      amuxJsonNoStore({ attemptId: body.attemptId,
        sourceSha256: body.sourceSha256,
        patchSha256: patch?.sha256 ?? null,
        filesDigest: patch?.filesDigest ?? null,
        patchRejected,
        duplicate: true }) :
      amuxJsonNoStore({ error: "result_conflict" }, 409);
    // Persist valid private patch evidence independently of the optional
    // Engineering run. Publication eligibility is checked when a candidate
    // is loaded; the publication switch may be off when this result arrives.
    const binding = await readAmuxV22TransferBinding(prisma, body.attemptId,
      body.worker);
    if (!binding) return amuxJsonNoStore({ error: "binding_mismatch" }, 409);
    const keys = await createOrLoadAmuxContentUnitKeys({ ideaId: binding.ideaId,
      purpose: "task_result", subjectId: body.attemptId });
    let patchKeys: AmuxContentKeys | null = null;
    try {
      if (patch) {
        try {
          patchKeys = await createOrLoadAmuxContentUnitKeys({ ideaId: binding.ideaId,
            purpose: "task_patch", subjectId: body.attemptId });
        } catch {
          patch = undefined;
          patchRejected = true;
        }
      }
      let prepared: PreparedAmuxV22TaskResult;
      try {
        prepared = prepareAmuxV22TaskResultRecord({ attemptId: body.attemptId,
          worker: body.worker, ideaId: binding.ideaId, text: body.resultText,
          sourceSha256: body.sourceSha256, keys,
          patch: patch && patchKeys ? { ...patch, keys: patchKeys } : undefined });
      } catch (error) {
        if (error instanceof AmuxV22TaskResultError)
          return amuxJsonNoStore({ error: error.code }, 409);
        throw error;
      }
      const recorded = await commit(prepared);
      if (!recorded.ok) return recorded.response;
      const patchStored = recorded.result.patchSha256 !== null;
      return amuxJsonNoStore({ ...recorded.result,
        filesDigest: patchStored ? patch?.filesDigest ?? null : null,
        patchRejected: patchRejected || (patch !== undefined && !patchStored) });
    } finally { keys.masterKey.fill(0); patchKeys?.masterKey.fill(0); }
  } catch { return amuxJsonNoStore({ error: "outcome_unknown" }, 503); }
}

// ignoreBOM keeps a leading U+FEFF, so the text is exactly the bytes.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The bytes as text, or null when they are not UTF-8 or no V8 string can
 * hold them (an external bound: about 512 MiB). */
function textOf(bytes: Buffer): { text: string } | { error: "invalid" | "too_long" } {
  try { return { text: utf8.decode(bytes) }; }
  catch (error) {
    return { error: error instanceof RangeError ||
      (error as { code?: string })?.code === "ERR_STRING_TOO_LONG" ?
      "too_long" : "invalid" };
  }
}

async function postChunked(body: z.infer<typeof chunkedSchema>): Promise<Response> {
  try {
    const prior = await prisma.amuxV22TaskResult.findUnique({
      where: { attemptId: body.attemptId },
      select: { sourceSha256: true, bodyPurgedAt: true },
    });
    if (prior) {
      if (prior.bodyPurgedAt) return amuxJsonNoStore({ error: "result_expired" }, 409);
      const priorPatch = await prisma.amuxV22TaskPatch.findUnique({
        where: { attemptId: body.attemptId },
        select: { patchSha256: true, baseSha: true, byteLength: true,
          bodyPurgedAt: true } });
      if (priorPatch?.bodyPurgedAt) return amuxJsonNoStore({ error: "result_expired" }, 409);
      if (prior.sourceSha256 !== body.sourceSha256)
        return amuxJsonNoStore({ error: "result_conflict" }, 409);
      // The same result commits again: the same patch is a duplicate, a patch
      // the first commit did not keep is reported rejected, any other differs.
      if (body.patch && priorPatch) return priorPatch.patchSha256 === body.patch.sha256 &&
        priorPatch.baseSha === body.patch.baseSha &&
        priorPatch.byteLength === body.patch.bytes ?
        amuxJsonNoStore({ attemptId: body.attemptId, sourceSha256: body.sourceSha256,
          patchSha256: priorPatch.patchSha256, filesDigest: null,
          patchRejected: false, duplicate: true }) :
        amuxJsonNoStore({ error: "result_conflict" }, 409);
      if (!body.patch && priorPatch) return amuxJsonNoStore({ error: "result_conflict" }, 409);
      return amuxJsonNoStore({ attemptId: body.attemptId, sourceSha256: body.sourceSha256,
        patchSha256: null, filesDigest: null, patchRejected: body.patch !== undefined,
        duplicate: true });
    }
    const binding = await readAmuxV22TransferBinding(prisma, body.attemptId, body.worker);
    if (!binding) return amuxJsonNoStore({ error: "binding_mismatch" }, 409);
    // The same external storage bound the upload holds a part to: a declared
    // size past it could never be stored, and is answered before its chunk
    // list is ever built.
    if (body.resultBytes > AMUX_V22_STORAGE_MAX_BYTES ||
        (body.patch && body.patch.bytes > AMUX_V22_STORAGE_MAX_BYTES))
      return amuxJsonNoStore({ error: "exceeds_processing" }, 409);
    const parts: AmuxV22TransferHeader[] = [{ part: "result",
      totalBytes: body.resultBytes, sha256: body.sourceSha256, baseSha: null,
      count: null }];
    if (body.patch) parts.push({ part: "patch", totalBytes: body.patch.bytes,
      sha256: body.patch.sha256, baseSha: body.patch.baseSha, count: null });
    // Every chunk first, read without bodies: what is missing is not a refusal.
    const missing: Partial<Record<AmuxV22TransferPart, number[]>> = {};
    for (const header of parts) {
      const inspection = await inspectAmuxV22TransferPart(prisma, body.attemptId, header);
      if (inspection.kind === "header_mismatch") return digestMismatch(body.attemptId, header.part);
      if (inspection.kind === "incomplete") missing[header.part] = inspection.missing;
    }
    if (Object.keys(missing).length)
      return amuxJsonNoStore({ error: "upload_incomplete", missing }, 409);
    return await assembleAndRecord(body, binding, parts);
  } catch { return amuxJsonNoStore({ error: "outcome_unknown" }, 503); }
}

/** The app deletes a part whose chunks do not make the part they describe;
 * the box uploads it once more. */
async function digestMismatch(attemptId: string, part: AmuxV22TransferPart) {
  await deleteAmuxV22TransferParts(prisma, attemptId, [part]);
  return amuxJsonNoStore({ error: "upload_digest_mismatch", part }, 409);
}

async function assembleAndRecord(body: z.infer<typeof chunkedSchema>,
  binding: AmuxV22TransferBinding, parts: AmuxV22TransferHeader[]): Promise<Response> {
  const keys = await createOrLoadAmuxContentUnitKeys({ ideaId: binding.ideaId,
    purpose: "task_result", subjectId: body.attemptId });
  let patchKeys: AmuxContentKeys | null = null;
  let resultBytes: Buffer | null = null;
  try {
    const assembled = await assembleAmuxV22TransferPart(body.attemptId, parts[0]!, keys);
    if (assembled.kind === "incomplete")
      return amuxJsonNoStore({ error: "upload_incomplete",
        missing: { result: assembled.missing } }, 409);
    if (assembled.kind === "digest_mismatch") return digestMismatch(body.attemptId, "result");
    resultBytes = assembled.bytes;
    const result = textOf(resultBytes);
    if ("error" in result) return result.error === "too_long" ?
      amuxJsonNoStore({ error: "exceeds_processing" }, 409) :
      amuxJsonNoStore({ error: "result_invalid" }, 409);
    // The patch is optional evidence: one that cannot be read, checked or
    // made a string leaves the result recorded and the patch rejected.
    let patch: { text: string; sha256: string; baseSha: string } | undefined;
    let patchRejected = false;
    if (body.patch && parts[1]) {
      try {
        patchKeys = await createOrLoadAmuxContentUnitKeys({ ideaId: binding.ideaId,
          purpose: "task_patch", subjectId: body.attemptId });
      } catch { patchRejected = true; }
      if (patchKeys) {
        const patchPart = await assembleAmuxV22TransferPart(body.attemptId, parts[1],
          patchKeys);
        if (patchPart.kind === "incomplete")
          return amuxJsonNoStore({ error: "upload_incomplete",
            missing: { patch: patchPart.missing } }, 409);
        if (patchPart.kind === "digest_mismatch")
          return digestMismatch(body.attemptId, "patch");
        try {
          const decoded = textOf(patchPart.bytes);
          const normalized = "text" in decoded ? normalizeV22OptionalPatch({
            text: decoded.text, sha256: body.patch.sha256,
            baseSha: body.patch.baseSha }) : { patch: undefined, patchRejected: true };
          patch = normalized.patch;
          patchRejected = normalized.patchRejected;
        } finally { patchPart.bytes.fill(0); }
      }
    }
    let prepared: PreparedAmuxV22TaskResult;
    try {
      prepared = prepareAmuxV22TaskResultRecord({ attemptId: body.attemptId,
        worker: body.worker, ideaId: binding.ideaId, text: result.text,
        bytes: resultBytes, sourceSha256: body.sourceSha256, keys,
        patch: patch && patchKeys ? { ...patch, keys: patchKeys } : undefined,
        staging: body.patch ? ["result", "patch"] : ["result"] });
    } catch (error) {
      if (error instanceof AmuxV22TaskResultError)
        return amuxJsonNoStore({ error: error.code }, 409);
      if (error instanceof RangeError) return amuxJsonNoStore({ error: "exceeds_processing" }, 409);
      throw error;
    }
    const recorded = await commit(prepared);
    if (!recorded.ok) return recorded.response;
    return amuxJsonNoStore({ ...recorded.result, filesDigest: null,
      patchRejected: patchRejected ||
        (body.patch !== undefined && recorded.result.patchSha256 === null) });
  } finally {
    resultBytes?.fill(0);
    keys.masterKey.fill(0);
    patchKeys?.masterKey.fill(0);
  }
}

export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { createAmuxContentUnitKeys } from "@/lib/amux/ideaKeyStore";
import { loadAmuxContentUnitKeys } from "@/lib/amux/ideaKeyStore";
import { amuxContentDigest } from "@/lib/amux/ideaCrypto";
import { normalizeV22OptionalPatch } from "@/lib/amux/v22OptionalPatch";
import { encodeV22PatchEvidence, v22PublishFilesSha256 } from
  "@/lib/amux/v22PatchEvidence";
import { AmuxV22TaskResultError, recordAmuxV22TaskResult,
  readAmuxV22TaskPatchEvidence, v22TaskResultIdeaId,
  v22TaskResultSha256 } from
  "@/lib/amux/v22TaskResultStore";
import { prisma } from "@/lib/prisma";

const WRITE_CODE_LATCH = true;
const WRITE_ENV = "TOMVERSE_AMUX_V22_TASK_RESULT_WRITE";
const id = z.string().uuid();
const bodySchema = z.object({
  attemptId: id, worker: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  resultText: z.string().min(1).max(65_536),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  // Patch evidence is an optional private result. A malformed or unsafe patch
  // must not discard the already-paid Task response.
  patch: z.unknown().optional(),
}).strict();

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
      select: { sourceSha256: true, bodyPurgedAt: true },
    });
    const patch = result ? await prisma.amuxV22TaskPatch.findUnique({
      where: { attemptId: attemptId.data },
      select: { patchSha256: true, baseSha: true,
        bodyPurgedAt: true, taskId: true },
    }) : null;
    const evidence = patch && patch.bodyPurgedAt === null ?
      await readAmuxV22TaskPatchEvidence(attemptId.data, patch.taskId) : null;
    if (patch && patch.bodyPurgedAt === null && !evidence)
      return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
    return amuxJsonNoStore(result ? { status: "recorded",
      attemptId: attemptId.data, sourceSha256: result.sourceSha256,
      bodyAvailable: result.bodyPurgedAt === null,
      patch: patch ? { sha256: patch.patchSha256, baseSha: patch.baseSha,
        bodyAvailable: patch.bodyPurgedAt === null,
        filesDigest: evidence?.files ?
          v22PublishFilesSha256(evidence.files) : null } : null } :
      { status: "absent" });
  } catch { return amuxJsonNoStore({ error: "outcome_unknown" }, 503); }
}

export async function POST(request: Request): Promise<Response> {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (!WRITE_CODE_LATCH || process.env[WRITE_ENV] !== "enabled")
    return amuxJsonNoStore({ available: false,
      reason: "task_result_write_disabled" }, 409);
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json")
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  let body: z.infer<typeof bodySchema>;
  try {
    body = await readLimitedJson(request, 327_680, bodySchema);
    if (v22TaskResultSha256(body.resultText) !== body.sourceSha256)
      return amuxJsonNoStore({ error: "Invalid request." }, 400);
  } catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
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
    const attempt = await prisma.amuxExecutionAttempt.findUnique({
      where: { id: body.attemptId }, select: { worker: true, endedAt: true,
        v22AssignmentId: true, task: { select: { sourceSystem: true,
          sourceSnapshot: true, status: true, owner: true,
          v22AssignmentId: true } } },
    });
    const ideaId = v22TaskResultIdeaId(attempt?.task.sourceSnapshot);
    if (!attempt || attempt.worker !== body.worker || attempt.endedAt ||
        !attempt.v22AssignmentId || !ideaId ||
        attempt.task.sourceSystem !== "admin-idea-v4" ||
        attempt.task.status !== "doing" || attempt.task.owner !== body.worker ||
        attempt.task.v22AssignmentId !== attempt.v22AssignmentId)
      return amuxJsonNoStore({ error: "binding_mismatch" }, 409);
    const keys = await createAmuxContentUnitKeys({ ideaId,
      purpose: "task_result", subjectId: body.attemptId });
    let patchKeys: Awaited<ReturnType<typeof createAmuxContentUnitKeys>> | null = null;
    if (patch) {
      try {
        patchKeys = await createAmuxContentUnitKeys({ ideaId,
          purpose: "task_patch", subjectId: body.attemptId });
      } catch {
        patch = undefined;
        patchRejected = true;
      }
    }
    let callbackReturned = false;
    try {
      const result = await prisma.$transaction(async (tx) => {
        const value = await recordAmuxV22TaskResult(tx, { ...body, ideaId, keys,
          text: body.resultText, patch: patch && patchKeys ? {
            ...patch, keys: patchKeys,
          } : undefined });
        callbackReturned = true;
        return value;
      }, { maxWait: 5_000, timeout: 10_000 });
      const patchStored = result.patchSha256 !== null;
      return amuxJsonNoStore({ ...result,
        filesDigest: patchStored ? patch?.filesDigest ?? null : null,
        patchRejected: patchRejected || (patch !== undefined && !patchStored) });
    } catch (error) {
      if (!callbackReturned && error instanceof AmuxV22TaskResultError)
        return amuxJsonNoStore({ error: error.code }, 409);
      return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
    } finally { keys.masterKey.fill(0); patchKeys?.masterKey.fill(0); }
  } catch { return amuxJsonNoStore({ error: "outcome_unknown" }, 503); }
}

export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_MAX_EXPECTED_REVISION, AMUX_PRISMA_INT_MAX,
  amuxMachineIdSchema } from "@/lib/amux/claimContract";
import { AMUX_V22_EXECUTION_ROUTE_BUDGET_MS,
  withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { recordAmuxV52Review } from "@/lib/amux/execution";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxInternalErrorResponse, amuxJsonNoStore,
  isAmuxInputError } from "@/lib/amux/internalRoute";
import { prisma } from "@/lib/prisma";

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const vendor = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const evidenceSchema = z.object({
  job_id: z.string().regex(/^r-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/).nullable(),
  base_sha: sha, commit_sha: sha,
  verdict: z.enum(["accept", "reject", "unknown"]),
  author_vendor: vendor, reviewer_vendors: z.array(vendor).max(4),
  touches_contract: z.boolean(),
}).strict();
const requestSchema = z.object({
  attempt_id: z.string().uuid(), worker: amuxMachineIdSchema,
  instance_id: z.string().uuid(),
  generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
  task_revision: z.number().int().min(0).max(AMUX_MAX_EXPECTED_REVISION),
  evidence: evidenceSchema,
}).strict();

export async function GET(request: Request) {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].length !== 1 || !query.has("attemptId"))
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  const attemptId = z.string().uuid().safeParse(query.get("attemptId"));
  if (!attemptId.success)
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  return withAmuxRouteBudget(async () => {
    try {
      const record = await prisma.amuxV52ReviewRecord.findUnique({
        where: { attemptId: attemptId.data },
        select: { jobId: true, baseSha: true, commitSha: true,
          verdict: true, authorVendor: true, reviewerVendors: true,
          touchesContract: true, requestDigest: true,
          auditLog: { select: { entryHash: true } } },
      });
      if (record && !record.auditLog.entryHash)
        return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
      return amuxJsonNoStore(record ? { status: "recorded",
        jobId: record.jobId, baseSha: record.baseSha,
        commitSha: record.commitSha, verdict: record.verdict,
        authorVendor: record.authorVendor,
        reviewerVendors: record.reviewerVendors,
        touchesContract: record.touchesContract,
        requestDigest: record.requestDigest } : { status: "absent" });
    } catch {
      return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
    }
  }, AMUX_V22_EXECUTION_ROUTE_BUDGET_MS);
}

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json")
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 8 * 1_024, requestSchema);
      const result = await recordAmuxV52Review({
        attemptId: body.attempt_id, worker: body.worker,
        instanceId: body.instance_id, generation: body.generation,
        taskRevision: body.task_revision,
        evidence: { jobId: body.evidence.job_id,
          baseSha: body.evidence.base_sha,
          commitSha: body.evidence.commit_sha,
          verdict: body.evidence.verdict,
          authorVendor: body.evidence.author_vendor,
          reviewerVendors: body.evidence.reviewer_vendors,
          touchesContract: body.evidence.touches_contract },
      });
      return amuxJsonNoStore(result, result.recorded ? 200 : 409);
    } catch (error) {
      if (isAmuxInputError(error))
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      return amuxInternalErrorResponse("v52_review_record", error);
    }
  }, AMUX_V22_EXECUTION_ROUTE_BUDGET_MS);
}

export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import {
  applyAutoFixResult,
  isAutoFixSyncAuthorized,
} from "@/lib/feedbackAutoFixSync";

const changedFileSchema = z
  .object({
    path: z.string().min(1).max(300),
    addedLines: z.number().int().min(0).max(100_000),
    removedLines: z.number().int().min(0).max(100_000),
    changeKind: z.enum(["modified", "added", "deleted"]),
  })
  .strict();

const proofSchema = z
  .object({
    testPath: z.string().min(1).max(300),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/i),
    headSha: z.string().regex(/^[0-9a-f]{40}$/i),
    red: z
      .object({
        exitCode: z.number().int(),
        assertionFailure: z.boolean(),
      })
      .strict(),
    green: z.object({ exitCode: z.number().int() }).strict(),
  })
  .strict();

const requestSchema = z
  .object({
    caseId: z.string().min(10).max(64),
    result: z.discriminatedUnion("outcome", [
      z
        .object({
          outcome: z.literal("red_green_proven"),
          changedFiles: z.array(changedFileSchema).min(1).max(20),
          proof: proofSchema,
        })
        .strict(),
      z
        .object({
          outcome: z.literal("pr_open"),
          prNumber: z.number().int().min(1),
          prUrl: z.string().url().max(300),
        })
        .strict(),
      z
        .object({
          outcome: z.literal("merged"),
          mergedAt: z.iso.datetime(),
          mergeSha: z.string().regex(/^[0-9a-f]{40}$/i),
        })
        .strict(),
      z
        .object({
          outcome: z.literal("staging_verified"),
          stagingSha: z.string().regex(/^[0-9a-f]{40}$/i),
        })
        .strict(),
      z
        .object({
          outcome: z.literal("fix_failed"),
          reason: z.string().min(1).max(300),
        })
        .strict(),
    ]),
  })
  .strict();

/**
 * POST: a workflow-reported outcome. The change manifest and Red→Green proof
 * are re-validated server-side (lib/feedbackAutoFixSync.ts) and every write
 * goes through the state graph, so a replayed or out-of-order callback
 * becomes {applied:false} instead of a state jump.
 */
export async function POST(request: Request) {
  if (!isAutoFixSyncAuthorized(request)) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  try {
    const body = await readLimitedJson(request, 64 * 1_024, requestSchema);
    const outcome = await applyAutoFixResult(body.caseId, body.result);
    console.info(
      JSON.stringify({
        event: "autofix_result_reported",
        caseId: body.caseId,
        outcome: body.result.outcome,
        applied: outcome.applied,
        reason: outcome.reason || null,
        at: new Date().toISOString(),
      })
    );
    return Response.json(outcome, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { error: "Invalid request." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}

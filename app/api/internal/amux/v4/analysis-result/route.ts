export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { AmuxIdeaAnalysisResultError,
  commitAmuxIdeaAnalysisResult,
  readAmuxIdeaAnalysisResultReceipt } from
  "@/lib/amux/ideaAnalysisResultService";
import { loadCurrentAmuxContentKeys } from "@/lib/amux/ideaKeyConfig";
import { amuxAnalysisFreeformSubjectId } from
  "@/lib/amux/ideaAnalysisDraftSealCore";
import { createAmuxContentKeyRing,
  type AmuxContentKeyIdentity } from "@/lib/amux/ideaKeyStore";
import { prisma } from "@/lib/prisma";

// The v15 code latch does not bypass the verified isolated runner, agent-wide
// failure latch, S0 evidence or the two independent environment switches.
const RESULT_CODE_LATCH = true;
const RESULT_WRITE_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_RESULT_WRITE";
// Read-back remains available under its own authenticated, default-off gate
// after result writes are killed. It returns only the content-free receipt.
const RESULT_RECEIPT_READ_CODE_LATCH = true;
const RESULT_RECEIPT_READ_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_RESULT_READ";
const id = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const bodySchema = z.object({ requestId: id, ideaId: id, previewId: id,
  holdId: id, leaseGeneration: z.literal(1),
  outcome: z.enum(["verified_success", "invocation_failed", "outcome_unknown"]),
  rawModelOutput: z.string().max(65_536).nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable() }).strict();

function authorized(request: Request): boolean {
  return isAmuxV4AnalysisAgentAuthorized(request,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (!RESULT_CODE_LATCH || process.env[RESULT_WRITE_ENV] !== "enabled" ||
      !RESULT_RECEIPT_READ_CODE_LATCH ||
      process.env[RESULT_RECEIPT_READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false, reason: "analysis_result_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let body: z.infer<typeof bodySchema>;
  try { body = await readLimitedJson(request, 70 * 1024, bodySchema); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  let keys = loadCurrentAmuxContentKeys(process.env);
  let unitIds: string[] | undefined;
  if (body.outcome === "verified_success") {
    if (body.rawModelOutput === null) {
      return amuxJsonNoStore({ error: "invalid_result" }, 400);
    }
    let preview;
    try {
      preview = await prisma.amuxIdeaTransferPreview.findUnique({
        where: { id: body.previewId }, select: { ideaId: true, chunkIndex: true },
      });
    } catch { return amuxJsonNoStore({ error: "key_preflight_unavailable" }, 503); }
    if (!preview || preview.ideaId !== body.ideaId) {
      return amuxJsonNoStore({ error: "not_ready" }, 409);
    }
    let preceding: { currentPreviewId: string | null } | null = null;
    let previousUnits: Array<{ id: string }> = [];
    try {
      if (preview.chunkIndex > 0) {
        preceding = await prisma.amuxIdeaAnalysisChunk.findUnique({ where: {
          ideaId_chunkIndex: { ideaId: body.ideaId,
            chunkIndex: preview.chunkIndex - 1 },
        }, select: { currentPreviewId: true } });
        previousUnits = await prisma.amuxIdeaDraftUnit.findMany({ where: {
          ideaId: body.ideaId, chunkIndex: preview.chunkIndex - 1,
          derivationGroupId: null,
        }, select: { id: true }, take: 41 });
      }
    } catch {
      return amuxJsonNoStore({ error: "key_preflight_unavailable" }, 503);
    }
    if (preview.chunkIndex > 0 && !preceding?.currentPreviewId) {
      return amuxJsonNoStore({ error: "not_ready" }, 409);
    }
    if (previousUnits.length > 40) {
      return amuxJsonNoStore({ error: "integrity_unavailable" }, 409);
    }
    let count = 0;
    try {
      const parsed: unknown = JSON.parse(body.rawModelOutput);
      const units = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).units : null;
      if (Array.isArray(units) && units.length <= 40) count = units.length;
    } catch { /* Invalid model output is settled as a failed invocation. */ }
    unitIds = Array.from({ length: count }, () => randomUUID());
    const existing: AmuxContentKeyIdentity[] = [{ ideaId: body.ideaId,
      purpose: "transfer_payload", subjectId: body.previewId },
    ...(preceding?.currentPreviewId ? [{ ideaId: body.ideaId,
      purpose: "analysis_freeform" as const,
      subjectId: amuxAnalysisFreeformSubjectId(body.ideaId,
        preceding.currentPreviewId) }] : []),
    ...(preceding?.currentPreviewId ? [{ ideaId: body.ideaId,
      purpose: "transfer_payload" as const,
      subjectId: preceding.currentPreviewId }] : []),
    ...previousUnits.map((unit) => ({ ideaId: body.ideaId,
      purpose: "analysis_draft" as const, subjectId: unit.id }))];
    const created: AmuxContentKeyIdentity[] = [{ ideaId: body.ideaId,
      purpose: "analysis_freeform",
      subjectId: amuxAnalysisFreeformSubjectId(body.ideaId, body.previewId) },
    ...unitIds.map((id) => ({ ideaId: body.ideaId,
      purpose: "analysis_draft" as const, subjectId: id }))];
    try { keys = await createAmuxContentKeyRing(existing, created); }
    catch { return amuxJsonNoStore({ error: "key_store_unavailable" }, 503); }
  }
  let callbackReturned = false;
  try {
    const receipt = await prisma.$transaction(async (tx) => {
      const saved = await commitAmuxIdeaAnalysisResult(tx, { ...body, keys,
        unitIds });
      callbackReturned = true;
      return saved;
    }, { maxWait: 5_000, timeout: 15_000 });
    return amuxJsonNoStore(receipt);
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxIdeaAnalysisResultError) {
      return amuxJsonNoStore({ error: error.code }, 409);
    }
    return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (!RESULT_RECEIPT_READ_CODE_LATCH ||
      process.env[RESULT_RECEIPT_READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false,
      reason: "analysis_result_read_disabled" }, 409);
  }
  const url = new URL(request.url);
  if (url.searchParams.getAll("requestId").length !== 1 ||
      url.searchParams.getAll("previewId").length !== 1 ||
      [...url.searchParams.keys()].length !== 2) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  const parsed = z.object({ requestId: id, previewId: id }).strict().safeParse({
    requestId: url.searchParams.get("requestId"),
    previewId: url.searchParams.get("previewId"),
  });
  if (!parsed.success) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  try {
    const result = await prisma.$transaction((tx) =>
      readAmuxIdeaAnalysisResultReceipt(tx, parsed.data),
    { maxWait: 5_000, timeout: 10_000 });
    return amuxJsonNoStore(result);
  } catch {
    return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
  }
}

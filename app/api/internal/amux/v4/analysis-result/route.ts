export const dynamic = "force-dynamic";

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
import { prisma } from "@/lib/prisma";

// Intentionally dark: a live result requires verified isolated runner, agent-
// wide failure latch and S0 gates. An environment variable alone cannot open it.
const RESULT_CODE_LATCH = false;
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
  let callbackReturned = false;
  try {
    const keys = loadCurrentAmuxContentKeys(process.env);
    const receipt = await prisma.$transaction(async (tx) => {
      const saved = await commitAmuxIdeaAnalysisResult(tx, { ...body, keys });
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

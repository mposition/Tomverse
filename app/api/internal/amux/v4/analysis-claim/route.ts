export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { commitAmuxIdeaOnlyAnalysisClaim,
  readAmuxIdeaAnalysisClaimReceipt,
  AmuxIdeaAnalysisClaimError } from "@/lib/amux/ideaAnalysisClaimService";
import { loadAmuxContentKeyRing } from "@/lib/amux/ideaKeyStore";
import { prisma } from "@/lib/prisma";

const CLAIM_CODE_LATCH = true;
const CLAIM_WRITE_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_WRITE";
// Read-back is independently gated so turning off writes cannot prevent an
// operator from reconciling a lost claim response. It never returns a prompt.
const CLAIM_RECEIPT_READ_CODE_LATCH = true;
const CLAIM_RECEIPT_READ_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_READ";
const id = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const bodySchema = z.object({ requestId: id, previewId: id }).strict();

/** The v15 code latch still requires verified local isolation, exact owner
 * transfer, live model eligibility, bounded costs, the failure latch, both
 * environment switches and outcome-unknown read-back before a model call. */
export async function POST(request: Request): Promise<Response> {
  if (!isAmuxV4AnalysisAgentAuthorized(request,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!CLAIM_CODE_LATCH || process.env[CLAIM_WRITE_ENV] !== "enabled" ||
      !CLAIM_RECEIPT_READ_CODE_LATCH ||
      process.env[CLAIM_RECEIPT_READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false, reason: "analysis_claim_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let choice: z.infer<typeof bodySchema>;
  try { choice = await readLimitedJson(request, 1_024, bodySchema); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  const preview = await prisma.amuxIdeaTransferPreview.findUnique({
    where: { id: choice.previewId }, select: { ideaId: true },
  });
  if (!preview) return amuxJsonNoStore({ error: "not_found" }, 404);
  let keys;
  try {
    keys = await loadAmuxContentKeyRing([{ ideaId: preview.ideaId,
      purpose: "transfer_payload", subjectId: choice.previewId }]);
  } catch { return amuxJsonNoStore({ error: "key_store_unavailable" }, 503); }
  let callbackReturned = false;
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
      `;
      const claimed = await commitAmuxIdeaOnlyAnalysisClaim(tx,
        { requestId: choice.requestId, previewId: choice.previewId, keys });
      callbackReturned = true;
      return claimed;
    }, { maxWait: 5_000, timeout: 15_000 });
    return amuxJsonNoStore(result);
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxIdeaAnalysisClaimError) {
      return amuxJsonNoStore({ error: error.code }, 409);
    }
    return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
  }
}

/** An absent receipt is not permission to re-POST: the original transaction
 * may still commit after this read. All outcomes stop the local supervisor. */
export async function GET(request: Request): Promise<Response> {
  if (!isAmuxV4AnalysisAgentAuthorized(request,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!CLAIM_RECEIPT_READ_CODE_LATCH ||
      process.env[CLAIM_RECEIPT_READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false,
      reason: "analysis_claim_read_disabled" }, 409);
  }
  const url = new URL(request.url);
  if (url.searchParams.getAll("requestId").length !== 1 ||
      url.searchParams.getAll("previewId").length !== 1 ||
      [...url.searchParams.keys()].length !== 2) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  const parsed = bodySchema.safeParse({
    requestId: url.searchParams.get("requestId"),
    previewId: url.searchParams.get("previewId"),
  });
  if (!parsed.success) return amuxJsonNoStore({ error: "Invalid request." }, 400);
  try {
    const receipt = await prisma.$transaction((tx) =>
      readAmuxIdeaAnalysisClaimReceipt(tx, parsed.data),
    { maxWait: 5_000, timeout: 10_000 });
    return amuxJsonNoStore(receipt);
  } catch {
    return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
  }
}

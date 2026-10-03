export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { commitAmuxIdeaOnlyAnalysisClaim,
  AmuxIdeaAnalysisClaimError } from "@/lib/amux/ideaAnalysisClaimService";
import { loadCurrentAmuxContentKeys } from "@/lib/amux/ideaKeyConfig";
import { prisma } from "@/lib/prisma";

const CLAIM_CODE_LATCH = false;
const CLAIM_WRITE_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_WRITE";
const bodySchema = z.object({ previewId: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/) }).strict();

/** Deliberately dark. A future activation needs verified local isolation,
 * exact owner transfer, live model eligibility, bounded costs, failure latch
 * and an outcome-unknown read-back before this may dispatch a model call. */
export async function POST(request: Request): Promise<Response> {
  if (!isAmuxV4AnalysisAgentAuthorized(request,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!CLAIM_CODE_LATCH || process.env[CLAIM_WRITE_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false, reason: "analysis_claim_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let choice: z.infer<typeof bodySchema>;
  try { choice = await readLimitedJson(request, 1_024, bodySchema); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  let callbackReturned = false;
  try {
    const keys = loadCurrentAmuxContentKeys(process.env);
    const result = await prisma.$transaction(async (tx) => {
      const claimed = await commitAmuxIdeaOnlyAnalysisClaim(tx,
        { previewId: choice.previewId, keys });
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

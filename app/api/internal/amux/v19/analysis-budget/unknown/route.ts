export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { AMUX_V19_MAX_LAUNCHER_SECRET_ENV,
  isAmuxV19MaxLauncherAuthorized } from
  "@/lib/amux/ideaSessionMaxLauncherAuth";
import { AmuxSessionBudgetSettlementError,
  commitAmuxSessionBudgetOutcome } from
  "@/lib/amux/ideaSessionAnalysisBudgetSettlementService";
import { prisma } from "@/lib/prisma";

const uuid = z.string().uuid();
const bodySchema = z.object({
  claimId: uuid, requestId: uuid, reservationId: uuid, ideaId: uuid,
  invocationOrdinal: z.number().int().safe().nonnegative(),
  outcome: z.literal("outcome_unknown"),
  inputTokens: z.null(), outputTokens: z.null(),
}).strict();

/** A stopped or uncertain local invocation. A paid (bounded) claim keeps its
 * full monthly reservation for the owner; a subscription (max_shadow) claim is
 * closed by the system at zero in the same transaction (operator, 2026-11-16).
 * This endpoint cannot record success or retry a claim. The exact claim
 * receipt GET remains the response-loss readback. */
export async function POST(request: Request): Promise<Response> {
  const v4Authorized = isAmuxV4AnalysisAgentAuthorized(request,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET);
  const maxAuthorized = isAmuxV19MaxLauncherAuthorized(request,
    process.env[AMUX_V19_MAX_LAUNCHER_SECRET_ENV],
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET);
  if (!v4Authorized && !maxAuthorized) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let body: z.infer<typeof bodySchema>;
  try { body = await readLimitedJson(request, 1024, bodySchema); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  let callbackReturned = false;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const saved = await commitAmuxSessionBudgetOutcome(tx, {
        claimId: body.claimId, outcome: "outcome_unknown",
        inputTokens: null, outputTokens: null,
        requiredBudgetMode: maxAuthorized ? "max_shadow" : "bounded",
        exactAgentClaim: { requestId: body.requestId,
          reservationId: body.reservationId, ideaId: body.ideaId,
          invocationOrdinal: body.invocationOrdinal },
      });
      callbackReturned = true;
      return saved;
    }, { maxWait: 5_000, timeout: 15_000 });
    return amuxJsonNoStore(result);
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxSessionBudgetSettlementError) {
      return amuxJsonNoStore({ error: error.code }, 409);
    }
    return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
  }
}

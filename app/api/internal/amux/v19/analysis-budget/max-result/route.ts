export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV } from
  "@/lib/amux/ideaAnalysisQueueCore";
import { AMUX_V19_MAX_LAUNCHER_SECRET_ENV,
  isAmuxV19MaxLauncherAuthorized } from
  "@/lib/amux/ideaSessionMaxLauncherAuth";
import { AmuxSessionBudgetSettlementError,
  commitAmuxSessionBudgetOutcome } from
  "@/lib/amux/ideaSessionAnalysisBudgetSettlementService";
import { prisma } from "@/lib/prisma";

const WRITE_ENV = "TOMVERSE_AMUX_V19_SESSION_BUDGET_MAX_RESULT_WRITE";
const CLAIM_READ_ENV = "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ";
const STOP_READ_ENV = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ";
const uuid = z.string().uuid();
const bodySchema = z.object({ claimId: uuid, requestId: uuid,
  reservationId: uuid, ideaId: uuid,
  invocationOrdinal: z.number().int().safe().nonnegative(),
  outcome: z.enum(["verified_success", "invocation_failed"]),
  inputTokens: z.number().int().safe().nonnegative(),
  outputTokens: z.number().int().safe().nonnegative(),
}).strict().refine((body) => body.inputTokens + body.outputTokens > 0 &&
  Number.isSafeInteger(body.inputTokens + body.outputTokens));

/** Only the fixed Max launcher records measured usage for its exact claim.
 * Missing/untrusted usage must use the separate outcome-unknown hold route. */
export async function POST(request: Request): Promise<Response> {
  if (!isAmuxV19MaxLauncherAuthorized(request,
    process.env[AMUX_V19_MAX_LAUNCHER_SECRET_ENV],
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (process.env[WRITE_ENV] !== "enabled" ||
      process.env[CLAIM_READ_ENV] !== "enabled" ||
      process.env[STOP_READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false,
      reason: "session_budget_max_result_write_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let body: z.infer<typeof bodySchema>;
  try { body = await readLimitedJson(request, 1_024, bodySchema); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  let callbackReturned = false;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const saved = await commitAmuxSessionBudgetOutcome(tx, {
        claimId: body.claimId, outcome: body.outcome,
        inputTokens: body.inputTokens, outputTokens: body.outputTokens,
        requiredBudgetMode: "max_shadow",
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
      return amuxJsonNoStore({ error: error.code, reason: error.reason }, 409);
    }
    return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
  }
}

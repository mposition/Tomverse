export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AUTO_PROMOTION_APPLY_ENV,
  AUTO_PROMOTION_CODE_LATCH,
  AUTO_TICK_ROUTE_BUDGET_MS,
  autoPromotionApplyPermitted,
  autoTickHttpStatus,
} from "@/lib/amux/autoPromotionCore";
import { tickAutoPromotion } from "@/lib/amux/autoPromotionService";
import { AMUX_V22_AUTO_PROMOTION_ENV,
  amuxV22AutoPromotionEnabled } from "@/lib/amux/v22AutoPromotionCore";
import { tickV22AutoPromotion } from "@/lib/amux/v22AutoPromotionService";
import { v22PromotionTickWire, v22WorkerClaimTickWire } from
  "@/lib/amux/v22TickWire";
import { AMUX_V22_WORKER_CLAIM_ENV, amuxV22WorkerClaimEnabled } from
  "@/lib/amux/v22WorkerClaimCore";
import { tickV22WorkerClaim } from "@/lib/amux/v22WorkerClaimService";
import { withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import {
  admitAmuxOrchestratorRequest,
  amuxInternalErrorResponse,
  amuxInvalidOrchestratorIdentityResponse,
  amuxJsonNoStore,
  isAmuxInputError,
} from "@/lib/amux/internalRoute";
import { readAmuxOrchestratorWriteIdentity } from "@/lib/amux/orchestratorHaltCore";

/**
 * The system actor `amux-auto-promoter` consumes at most one bound grant.
 *
 * docs/policy/development-agent-orchestration.md, version 15 ("자동 승격
 * 개정"). The caller is the Railway AMUX Orchestrator, every five minutes.
 * Order: bearer credential, then an empty body, then the code latch and the
 * environment switch, and only then a transaction. The tick expires due
 * grants, then consumes the oldest bound grant through the same checks as the
 * owner route. A lost outcome is recorded and never retried.
 *
 * The whole tick runs inside one route budget anchored on the database clock
 * (`AUTO_TICK_ROUTE_BUDGET_MS`), like the other AMUX lifecycle routes: no
 * transaction starts that could not finish inside it, and each one checks it
 * as its last statement before COMMIT. That check precedes the COMMIT and
 * does not bound it (policy version 18). A failure answers in the shape the
 * other AMUX internal routes use; the body carries a code, never an error
 * message.
 */

const noStore = { "Cache-Control": "no-store" };
const requestSchema = z.object({}).strict();
const OPERATION = "auto_promotion_tick";

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
  }
  // Orchestration policy version 20, section 4. Without the identity headers
  // (an orchestrator built before version 20) the tick is served exactly as
  // before, with no admission.
  const identity = readAmuxOrchestratorWriteIdentity(request.headers);
  if (identity.kind === "invalid") {
    return amuxInvalidOrchestratorIdentityResponse();
  }

  return withAmuxRouteBudget(async () => {
    try {
      const refused = await admitAmuxOrchestratorRequest(identity, "auto_promotion_tick");
      if (refused) return refused;
      await readLimitedJson(request, 1_024, requestSchema);
    } catch (error) {
      if (isAmuxInputError(error)) {
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      }
      return amuxInternalErrorResponse(OPERATION, error);
    }

    const legacyEnabled = autoPromotionApplyPermitted({
        envValue: process.env[AUTO_PROMOTION_APPLY_ENV],
        codeLatch: AUTO_PROMOTION_CODE_LATCH,
      });
    const v22Enabled = amuxV22AutoPromotionEnabled(
      process.env[AMUX_V22_AUTO_PROMOTION_ENV]);
    const claimEnabled = amuxV22WorkerClaimEnabled(
      process.env[AMUX_V22_WORKER_CLAIM_ENV]);
    if (!legacyEnabled && !v22Enabled && !claimEnabled) {
      return Response.json(
        { promoted: false, reason: "apply_disabled", expired: 0 },
        { status: 409, headers: noStore },
      );
    }
    if ((v22Enabled || claimEnabled) && identity.kind !== "admitted" &&
        !legacyEnabled) {
      return Response.json({ promoted: false, reason: "apply_disabled", expired: 0 },
        { status: 409, headers: noStore });
    }

    try {
      if (claimEnabled && identity.kind === "admitted") {
        const result = await tickV22WorkerClaim();
        if (result.claimed || result.reason === "outcome_unknown" ||
            (!v22Enabled && !legacyEnabled)) {
          return Response.json(v22WorkerClaimTickWire(result), {
            status: result.claimed ? 200 : autoTickHttpStatus(result.reason),
            headers: noStore,
          });
        }
      }
      if (v22Enabled && identity.kind === "admitted") {
        const result = await tickV22AutoPromotion();
        if (result.promoted || (!result.promoted && result.reason === "outcome_unknown") ||
            !legacyEnabled) {
          return Response.json(v22PromotionTickWire(result), {
            status: result.promoted ? 200 : autoTickHttpStatus(result.reason),
            headers: noStore,
          });
        }
      }
      const result = await tickAutoPromotion();
      return Response.json(result, { status: autoTickHttpStatus(result.reason), headers: noStore });
    } catch (error) {
      return amuxInternalErrorResponse(OPERATION, error);
    }
  }, AUTO_TICK_ROUTE_BUDGET_MS);
}

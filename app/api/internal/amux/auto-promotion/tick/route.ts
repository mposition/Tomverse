export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AUTO_PROMOTION_APPLY_ENV,
  AUTO_PROMOTION_CODE_LATCH,
  AUTO_TICK_ROUTE_BUDGET_MS,
  AUTO_TICK_TRANSACTION_MAX_MS,
  autoPromotionApplyPermitted,
  autoTickHttpStatus,
} from "@/lib/amux/autoPromotionCore";
import { tickAutoPromotion } from "@/lib/amux/autoPromotionService";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import { AMUX_V22_AUTO_PROMOTION_ENV,
  amuxV22AutoPromotionEnabled } from "@/lib/amux/v22AutoPromotionCore";
import { tickV22AutoPromotion } from "@/lib/amux/v22AutoPromotionService";
import { v22PromotionTickWire, v22WorkerClaimTickWire } from
  "@/lib/amux/v22TickWire";
import { AMUX_V22_WORKER_CLAIM_ENV, amuxV22WorkerClaimEnabled } from
  "@/lib/amux/v22WorkerClaimCore";
import { tickV22WorkerClaim } from "@/lib/amux/v22WorkerClaimService";
import { amuxRouteHasBudgetForMs, withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { loadCurrentAmuxContentKeys } from "@/lib/amux/ideaKeyConfig";
import { AMUX_SCORE_REFRESH_ENV, amuxScoreAutoRefreshEnabled } from
  "@/lib/amux/portfolioScoreCore";
import { refreshDueAmuxPortfolioScores } from "@/lib/amux/portfolioScoreService";
import { sweepAmuxStalledCards } from "@/lib/amux/stalledCardSweep";
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

/** Owner decision 2026-11-14: before promotion reads its candidates, extend
 * the active window of scores whose confirmed inputs are unchanged (default
 * off, `TOMVERSE_AMUX_V4_SCORE_AUTO_REFRESH=enabled`). Each refresh must leave
 * room for the claim and promotion transactions after it. A refusal never
 * fails the tick; a refresh whose COMMIT outcome is lost stops it, answered
 * like the promotion's own lost write, before any claim or promotion runs. */
async function refreshScoresBeforePromotion(): Promise<Response | null> {
  let digestKey: ReturnType<typeof loadCurrentAmuxContentKeys>;
  try { digestKey = loadCurrentAmuxContentKeys(process.env); } catch {
    console.error(JSON.stringify({ event: "amux_score_refresh_unavailable" }));
    return null;
  }
  try {
    const result = await refreshDueAmuxPortfolioScores({
      digestKey,
      // This refresh, then the claim and the promotion transactions.
      hasBudget: () => amuxRouteHasBudgetForMs(3 * AUTO_TICK_TRANSACTION_MAX_MS),
    });
    if (result.refreshed || result.failed || result.orphaned.length) {
      // orphanedTaskIds: backlog Tasks behind an archived, unfinished
      // dependency; no refresh or promotion moves them until the owner does.
      console.info(JSON.stringify({ event: "amux_score_refresh",
        refreshed: result.refreshed, skipped: result.skipped,
        failed: result.failed, orphanedTaskIds: result.orphaned }));
    }
    return null;
  } catch (error) {
    if (error instanceof BoardImportError && error.code === "outcome_unknown") {
      console.error(JSON.stringify({ event: "amux_score_refresh_outcome_unknown",
        taskId: error.approvalId }));
      return Response.json(v22PromotionTickWire({ promoted: false,
        reason: "outcome_unknown" }), {
        status: autoTickHttpStatus("outcome_unknown"), headers: noStore });
    }
    console.error(JSON.stringify({ event: "amux_score_refresh_unavailable" }));
    return null;
  }
}

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

    if (v22Enabled && identity.kind === "admitted" &&
        amuxScoreAutoRefreshEnabled(process.env[AMUX_SCORE_REFRESH_ENV])) {
      const stopped = await refreshScoresBeforePromotion();
      if (stopped) return stopped;
    }

    const response = await claimAndPromote();
    // AMUXFLOW/B2: stopped cards go to the owner queue after this tick's
    // answer is decided, so the sweep's write never turns a later transient
    // claim or promotion error into an unknown outcome. Its own switch; never
    // a reason this tick fails.
    if (identity.kind === "admitted") await sweepStalledCardsAfterTick();
    return response;

    async function claimAndPromote(): Promise<Response> {
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
    }
  }, AUTO_TICK_ROUTE_BUDGET_MS);
}

/** The stalled card sweep, only while the route still has room for it. */
async function sweepStalledCardsAfterTick() {
  if (!amuxRouteHasBudgetForMs(2 * AUTO_TICK_TRANSACTION_MAX_MS)) return;
  try {
    const moved = await sweepAmuxStalledCards(3);
    if (moved.length) console.info(JSON.stringify({ event: "amux_stalled_card_sweep", moved }));
  } catch (error) {
    console.error(JSON.stringify({ event: "amux_stalled_card_sweep_unavailable",
      error: error instanceof Error ? error.name : "unknown" }));
  }
}

export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_DB_BOUNDARIES,
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
  amuxRouteHasBudgetFor,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import {
  admitAmuxOrchestratorRequest,
  amuxInternalErrorResponse,
  amuxInvalidOrchestratorIdentityResponse,
  amuxJsonNoStore,
  isAmuxInputError,
} from "@/lib/amux/internalRoute";
import { readAmuxOrchestratorWriteIdentity } from "@/lib/amux/orchestratorHaltCore";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import {
  reclaimExpiredAmuxClaims,
  reclaimExpiredAmuxExecutions,
  quarantineExpiredAmuxV22TaskExecutions,
  releaseUnstartedAmuxV22Assignments,
} from "@/lib/amux/execution";
import { AMUX_V22_TASK_EXECUTION_CODE_LATCH } from
  "@/lib/amux/v22TaskExecutionCore";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import { amuxRecoverFailureFields, type AmuxRecoverStep } from "@/lib/amux/recoverFailure";
import { sweepExpiredAmuxQuotaObservations } from "@/lib/amux/telemetry";

const requestSchema = z.object({}).strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return Response.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  // Orchestration policy version 20, section 4. Without the identity headers
  // (an orchestrator built before version 20) the sweep is served exactly as
  // before, with no admission.
  const identity = readAmuxOrchestratorWriteIdentity(request.headers);
  if (identity.kind === "invalid") {
    return amuxInvalidOrchestratorIdentityResponse();
  }

  return withAmuxRouteBudget(async () => {
    let step: AmuxRecoverStep = "request";
    try {
      const refused = await admitAmuxOrchestratorRequest(identity, "recover");
      if (refused) return refused;
      await readLimitedJson(request, 1 * 1_024, requestSchema);

      // Selection-only can still accept quota telemetry. Keep its 90-day
      // evidence bounded without opening execution mutations during that phase.
      step = "quota_sweep";
      const quotaObservationsDeleted =
        await sweepExpiredAmuxQuotaObservations();

      if (!isAmuxExecutionApiEnabled()) {
        return Response.json(
          {
            recovered: false,
            reason: "execution_api_disabled",
            quota_observations_deleted: quotaObservationsDeleted,
          },
          {
            status: 409,
            headers: { "Cache-Control": "no-store" },
          },
        );
      }

      let more = false;
      step = "reclaim_executions";
      const reclaimed = await reclaimExpiredAmuxExecutions({
        onMoreWork: () => {
          more = true;
        },
      });

      let reclaimedClaims = 0;
      if (amuxRouteHasBudgetFor(AMUX_DB_BOUNDARIES.ownershipRecoveryRead)) {
        step = "reclaim_claims";
        reclaimedClaims = await reclaimExpiredAmuxClaims({
          onMoreWork: () => {
            more = true;
          },
        });
      } else {
        more = true;
      }

      let quarantinedV22 = 0;
      let releasedUnstartedV22 = 0;
      // Recovery drains or quarantines work already admitted before the
      // environment kill switch was closed. A code-latch-off deployment has
      // never admitted v22 work and must not query its new tables.
      if (AMUX_V22_TASK_EXECUTION_CODE_LATCH) {
        if (amuxRouteHasBudgetFor(AMUX_DB_BOUNDARIES.executionRecoveryWrite)) {
          quarantinedV22 = await quarantineExpiredAmuxV22TaskExecutions(20);
        } else more = true;
        if (amuxRouteHasBudgetFor(AMUX_DB_BOUNDARIES.ownershipRecoveryWrite)) {
          releasedUnstartedV22 = await releaseUnstartedAmuxV22Assignments(20);
        } else more = true;
      }

      return Response.json(
        {
          recovered: true,
          reclaimed,
          reclaimed_claims: reclaimedClaims,
          quota_observations_deleted: quotaObservationsDeleted,
          ...(AMUX_V22_TASK_EXECUTION_CODE_LATCH ?
            { quarantined_v22: quarantinedV22,
              released_unstarted_v22: releasedUnstartedV22 } : {}),
          more,
        },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (error) {
      if (isAmuxInputError(error)) {
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      }
      // The response stays opaque; the log names the step and error class only.
      console.error("AMUX recovery failed", amuxRecoverFailureFields(step, error));
      return amuxInternalErrorResponse("execution_recover", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

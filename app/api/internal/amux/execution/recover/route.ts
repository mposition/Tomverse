export const dynamic = "force-dynamic";

import { z } from "zod";
import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_DB_BOUNDARIES,
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
  amuxRouteHasBudgetFor,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import {
  reclaimExpiredAmuxClaims,
  reclaimExpiredAmuxExecutions,
} from "@/lib/amux/execution";
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

  return withAmuxRouteBudget(async () => {
    let step: AmuxRecoverStep = "request";
    try {
      await readLimitedJson(request, 1 * 1_024, requestSchema);

      // Selection-only can still accept quota telemetry. Keep its 90-day
      // evidence bound without opening execution mutations during that phase.
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

      return Response.json(
        {
          recovered: true,
          reclaimed,
          reclaimed_claims: reclaimedClaims,
          quota_observations_deleted: quotaObservationsDeleted,
          more,
        },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (error) {
      const securityResponse = apiSecurityResponse(error);
      if (securityResponse) return securityResponse;
      // The response stays opaque; the log names the step and error class only.
      console.error("AMUX recovery failed", amuxRecoverFailureFields(step, error));
      return Response.json(
        { error: "AMUX recovery is unavailable." },
        {
          status: 500,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

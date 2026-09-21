export const dynamic = "force-dynamic";

import { z } from "zod";
import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import {
  reclaimExpiredAmuxClaims,
  reclaimExpiredAmuxExecutions,
} from "@/lib/amux/execution";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
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

  try {
    await readLimitedJson(
      request,
      1 * 1_024,
      requestSchema,
    );

    // Selection-only can still accept quota telemetry. Keep its 90-day
    // evidence bound without opening execution mutations during that phase.
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

    const reclaimed =
      await reclaimExpiredAmuxExecutions();

    const reclaimedClaims =
      await reclaimExpiredAmuxClaims();

    return Response.json(
      {
        recovered: true,
        reclaimed,
        reclaimed_claims: reclaimedClaims,
        quota_observations_deleted:
          quotaObservationsDeleted,
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
    return Response.json(
      { error: "AMUX recovery is unavailable." },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

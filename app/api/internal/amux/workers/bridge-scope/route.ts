export const dynamic = "force-dynamic";

import {
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxInternalErrorResponse, amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { readAmuxWorkerBridgeScope } from "@/lib/amux/workerBridgeScope";

/**
 * Orchestration policy version 55, section 1 (stage S1): a bridge started
 * with `--worker` reads, with its bearer, whether its worker is listed and
 * which kind of bridge serves it. Read-only; it registers, renews and
 * assigns nothing.
 */
export async function GET(request: Request) {
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
    try {
      return amuxJsonNoStore(await readAmuxWorkerBridgeScope());
    } catch (error) {
      return amuxInternalErrorResponse("worker_bridge_scope", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

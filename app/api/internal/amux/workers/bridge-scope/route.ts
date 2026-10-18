export const dynamic = "force-dynamic";

import {
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxInternalErrorResponse, amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { readAmuxWorkerBridgeScope } from "@/lib/amux/workerBridgeScope";

/**
 * Orchestration policy version 55, section 1 (stage S1): a bridge started
 * with `--worker` reads, with its bearer, whether its worker is listed and
 * which kind of bridge serves it. Read-only; it registers, renews and
 * assigns nothing. While the stage's code latch is off it answers
 * `bridge_scope_off`.
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

  if (!isAmuxExecutionApiEnabled()) {
    return amuxJsonNoStore(
      { listed: false, reason: "execution_api_disabled" },
      409,
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

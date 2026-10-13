export const dynamic = "force-dynamic";

import {
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxInternalErrorResponse, amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { readAmuxWorkerSessionList } from "@/lib/amux/workerSessionList";

/**
 * Orchestration policy version 35, section 4 (stage R2d): the bridge reads
 * which sessions the derived worker catalog lists, with its bearer, at start
 * and on every heartbeat round. Read-only; it registers, renews and assigns
 * nothing. While R2d's code latch is off it answers `session_list_off` and
 * the bridge keeps its environment allowlist.
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
      return amuxJsonNoStore(await readAmuxWorkerSessionList());
    } catch (error) {
      return amuxInternalErrorResponse("worker_session_list", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

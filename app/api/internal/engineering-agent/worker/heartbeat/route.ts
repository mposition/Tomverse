export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_PRISMA_INT_MAX } from "@/lib/amux/claimContract";
import { withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import {
  ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  heartbeatEngineeringAgentWorker,
  engineeringAgentAmuxAdapterPermittedNow,
} from "@/lib/engineeringAgentAmuxAdapter";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";

// Renews the runner's AMUX runtime lease through the adapter. Dispatch
// readiness is the runner's word and the engineering switches' together: a
// worker that could not claim is never offered cards.

const requestSchema = z
  .object({
    instanceId: z.string().uuid(),
    generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
    status: z.enum(["starting", "idle", "busy", "error", "stopped"]),
    dispatchReady: z.boolean(),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!(await engineeringAgentAmuxAdapterPermittedNow())) return engineeringAgentJson({ refused: "adapter_closed" }, 409);
  try {
    const body = await readLimitedJson(request, 1024, requestSchema);
    const outcome = await withAmuxRouteBudget(
      () =>
        heartbeatEngineeringAgentWorker({
          lease: { instanceId: body.instanceId, generation: body.generation },
          status: body.status,
          dispatchReady: body.dispatchReady,
        }),
      ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
    );
    return engineeringAgentJson(outcome, outcome.accepted ? 200 : 409);
  } catch (error) {
    return engineeringAgentErrorResponse("worker_heartbeat", error);
  }
}

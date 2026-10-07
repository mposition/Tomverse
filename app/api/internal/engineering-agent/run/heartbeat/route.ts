export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_MAX_EXPECTED_REVISION, AMUX_PRISMA_INT_MAX } from "@/lib/amux/claimContract";
import { withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import {
  ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  heartbeatEngineeringAgentRunLease,
  engineeringAgentAmuxAdapterPermittedNow,
} from "@/lib/engineeringAgentAmuxAdapter";
import { isRunId } from "@/lib/engineeringAgentCore";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";

// Renews the attempt's lease and the run's in one AMUX transaction. Repeating
// a heartbeat changes nothing a second one would not, so it carries no request
// key; a heartbeat that renewed nothing says so, and the runner stops.

const requestSchema = z
  .object({
    instanceId: z.string().uuid(),
    generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
    runId: z.string().refine(isRunId),
    attemptId: z.string().uuid(),
    taskRevision: z.number().int().min(0).max(AMUX_MAX_EXPECTED_REVISION),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!(await engineeringAgentAmuxAdapterPermittedNow())) return engineeringAgentJson({ refused: "adapter_closed" }, 409);
  try {
    const body = await readLimitedJson(request, 1024, requestSchema);
    const renewed = await withAmuxRouteBudget(
      () =>
        heartbeatEngineeringAgentRunLease({
          lease: { instanceId: body.instanceId, generation: body.generation },
          runId: body.runId,
          attemptId: body.attemptId,
          taskRevision: body.taskRevision,
        }),
      ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
    );
    return engineeringAgentJson({ renewed }, renewed ? 200 : 409);
  } catch (error) {
    return engineeringAgentErrorResponse("run_heartbeat", error);
  }
}

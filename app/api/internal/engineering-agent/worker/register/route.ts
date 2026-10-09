export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import {
  ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  engineeringAgentAmuxAdapterPermittedNow,
  registerEngineeringAgentWorker,
} from "@/lib/engineeringAgentAmuxAdapter";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
  runAttachedIdempotentEngineeringAgentRequest,
} from "@/lib/engineeringAgentRouteAuth";

// The runner process registers its AMUX runtime through the adapter
// (docs/policy/development-agent-orchestration.md, Authority, version 12).
// The worker is the adapter's constant; a new registration fences out every
// earlier generation, as it does on the AMUX route. It is an idempotent
// request (docs/policy/engineering-agent.md §10): a retry whose first answer
// was lost gets the generation already created, never a new one.

const requestSchema = z
  .object({
    requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    instanceId: z.string().uuid(),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!(await engineeringAgentAmuxAdapterPermittedNow())) return engineeringAgentJson({ refused: "adapter_closed" }, 409);
  try {
    const body = await readLimitedJson(request, 1024, requestSchema);
    const outcome = await runAttachedIdempotentEngineeringAgentRequest({
      route: "worker/register",
      requestKey: body.requestKey,
      body,
      work: (markCommitted) =>
        withAmuxRouteBudget(
          () => registerEngineeringAgentWorker({ instanceId: body.instanceId, markCommitted }),
          ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
        ),
    });
    if (outcome.kind === "conflict") return engineeringAgentJson({ error: "request_key_reused" }, 409);
    if (outcome.kind === "replay") {
      return engineeringAgentJson({ replayed: true, state: outcome.state, generation: outcome.resultRef }, 200);
    }
    if (outcome.kind === "not_committed") return engineeringAgentJson(outcome.value, 409);
    return engineeringAgentJson(outcome.value, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("worker_register", error);
  }
}

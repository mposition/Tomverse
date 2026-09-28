export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import {
  ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  isEngineeringAgentAmuxAdapterOpen,
  registerEngineeringAgentWorker,
} from "@/lib/engineeringAgentAmuxAdapter";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";

// The runner process registers its AMUX runtime through the adapter
// (docs/policy/development-agent-orchestration.md, Authority, version 12).
// The worker is the adapter's constant; a new registration fences out every
// earlier generation, as it does on the AMUX route.

const requestSchema = z.object({ instanceId: z.string().uuid() }).strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!isEngineeringAgentAmuxAdapterOpen()) return engineeringAgentJson({ refused: "adapter_closed" }, 409);
  try {
    const body = await readLimitedJson(request, 1024, requestSchema);
    const outcome = await withAmuxRouteBudget(
      () => registerEngineeringAgentWorker({ instanceId: body.instanceId }),
      ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
    );
    return engineeringAgentJson(outcome, outcome.registered ? 200 : 409);
  } catch (error) {
    return engineeringAgentErrorResponse("worker_register", error);
  }
}

export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_PRISMA_INT_MAX } from "@/lib/amux/claimContract";
import { withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import {
  ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  engineeringAgentAmuxAdapterPermittedNow,
  pullEngineeringAgentDelivery,
} from "@/lib/engineeringAgentAmuxAdapter";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";

// The runner pulls the execution brief AMUX queued with its attempt. The
// brief is a card's text: the runner treats it as data
// (docs/policy/engineering-agent.md §7), and this route passes it on exactly
// as AMUX stored it.

const requestSchema = z
  .object({
    instanceId: z.string().uuid(),
    generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!(await engineeringAgentAmuxAdapterPermittedNow())) return engineeringAgentJson({ refused: "adapter_closed" }, 409);
  try {
    const body = await readLimitedJson(request, 1024, requestSchema);
    const outcome = await withAmuxRouteBudget(
      () => pullEngineeringAgentDelivery({ lease: { instanceId: body.instanceId, generation: body.generation } }),
      ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
    );
    if (!outcome.available) {
      return engineeringAgentJson(outcome, outcome.reason === "runtime_not_ready" ? 409 : 200);
    }
    return engineeringAgentJson(outcome, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("delivery_pull", error);
  }
}

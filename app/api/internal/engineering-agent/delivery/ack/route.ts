export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_PRISMA_INT_MAX } from "@/lib/amux/claimContract";
import { withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import {
  ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  acknowledgeEngineeringAgentDelivery,
  engineeringAgentAmuxAdapterPermittedNow,
} from "@/lib/engineeringAgentAmuxAdapter";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";

// The runner acknowledges the brief it received. AMUX's receipt, attempt,
// runtime-generation and task-revision fences decide; a repeat is idempotent
// there, so this route carries no request key of its own.

const requestSchema = z
  .object({
    instanceId: z.string().uuid(),
    generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
    attemptId: z.string().uuid(),
    receiptId: z.string().uuid(),
    taskRevision: z.number().int().min(0).max(AMUX_PRISMA_INT_MAX),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!(await engineeringAgentAmuxAdapterPermittedNow())) return engineeringAgentJson({ refused: "adapter_closed" }, 409);
  try {
    const body = await readLimitedJson(request, 1024, requestSchema);
    const outcome = await withAmuxRouteBudget(
      () =>
        acknowledgeEngineeringAgentDelivery({
          lease: { instanceId: body.instanceId, generation: body.generation },
          attemptId: body.attemptId,
          receiptId: body.receiptId,
          taskRevision: body.taskRevision,
        }),
      ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
    );
    return engineeringAgentJson(outcome, outcome.acknowledged ? 200 : 409);
  } catch (error) {
    return engineeringAgentErrorResponse("delivery_ack", error);
  }
}

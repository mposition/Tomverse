export const dynamic = "force-dynamic";

import { z } from "zod";
import { AMUX_PRISMA_INT_MAX, amuxMachineIdSchema } from
  "@/lib/amux/claimContract";
import { AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
  withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { readAmuxV22TaskExecution } from "@/lib/amux/execution";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxInternalErrorResponse, amuxJsonNoStore } from
  "@/lib/amux/internalRoute";

const querySchema = z.object({ assignment_id: z.string().uuid(),
  worker: amuxMachineIdSchema, instance_id: z.string().uuid(),
  generation: z.coerce.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
}).strict();

export async function GET(request: Request) {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  // Read-back remains available after the write switch is closed. Otherwise
  // a lost start/settlement response could never be resolved safely.
  return withAmuxRouteBudget(async () => {
    try {
      const parsed = querySchema.safeParse(Object.fromEntries(
        new URL(request.url).searchParams));
      if (!parsed.success) return amuxJsonNoStore({ error: "Invalid request." }, 400);
      const result = await readAmuxV22TaskExecution({
        assignmentId: parsed.data.assignment_id,
        worker: parsed.data.worker, instanceId: parsed.data.instance_id,
        generation: parsed.data.generation,
      });
      return amuxJsonNoStore(result, result.found ? 200 : 404);
    } catch (error) {
      return amuxInternalErrorResponse("v22_execution_attempt", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

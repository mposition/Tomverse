export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_MAX_EXPECTED_REVISION, AMUX_PRISMA_INT_MAX,
  amuxMachineIdSchema } from "@/lib/amux/claimContract";
import { AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
  withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { heartbeatAmuxV22TaskExecution } from "@/lib/amux/execution";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxInternalErrorResponse, amuxJsonNoStore,
  isAmuxInputError } from "@/lib/amux/internalRoute";
import { AMUX_V22_TASK_EXECUTION_CODE_LATCH } from
  "@/lib/amux/v22TaskExecutionCore";

const requestSchema = z.object({ attempt_id: z.string().uuid(),
  worker: amuxMachineIdSchema, instance_id: z.string().uuid(),
  generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
  task_revision: z.number().int().min(0).max(AMUX_MAX_EXPECTED_REVISION),
}).strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  // Admission's environment switch may be closed while an existing attempt
  // still needs a heartbeat. A code-latch-off build never admits v22 work.
  if (!AMUX_V22_TASK_EXECUTION_CODE_LATCH)
    return amuxJsonNoStore({ accepted: false,
      reason: "v22_execution_disabled" }, 409);
  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 4 * 1_024, requestSchema);
      const accepted = await heartbeatAmuxV22TaskExecution({
        attemptId: body.attempt_id, worker: body.worker,
        instanceId: body.instance_id, generation: body.generation,
        taskRevision: body.task_revision,
      });
      return amuxJsonNoStore(accepted ? { accepted: true } :
        { accepted: false, reason: "fenced_out" }, accepted ? 200 : 409);
    } catch (error) {
      if (isAmuxInputError(error))
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      return amuxInternalErrorResponse("v22_execution_heartbeat", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

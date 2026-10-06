export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_MAX_EXPECTED_REVISION, AMUX_PRISMA_INT_MAX,
  amuxMachineIdSchema } from "@/lib/amux/claimContract";
import { AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
  withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { amuxInternalErrorResponse, amuxJsonNoStore,
  isAmuxInputError } from "@/lib/amux/internalRoute";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { startAmuxV22TaskExecution } from "@/lib/amux/execution";
import { AMUX_V22_TASK_EXECUTION_ENV,
  amuxV22TaskExecutionEnabled } from "@/lib/amux/v22TaskExecutionCore";

const requestSchema = z.object({
  task_id: amuxMachineIdSchema,
  assignment_id: z.string().uuid(),
  worker: amuxMachineIdSchema,
  instance_id: z.string().uuid(),
  generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
  expected_revision: z.number().int().min(0).max(AMUX_MAX_EXPECTED_REVISION),
}).strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (!amuxV22TaskExecutionEnabled(process.env[AMUX_V22_TASK_EXECUTION_ENV]))
    return amuxJsonNoStore({ started: false,
      reason: "v22_execution_disabled" }, 409);
  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 4 * 1_024, requestSchema);
      const result = await startAmuxV22TaskExecution({
        taskId: body.task_id, assignmentId: body.assignment_id,
        worker: body.worker, instanceId: body.instance_id,
        generation: body.generation,
        expectedRevision: body.expected_revision,
      });
      if (!result.started) return amuxJsonNoStore(result, 409);
      return amuxJsonNoStore({ started: true,
        attempt_id: result.attemptId,
        task_revision: result.taskRevision,
        lease_expires_at: result.leaseExpiresAt.toISOString() }, 200);
    } catch (error) {
      if (isAmuxInputError(error))
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      return amuxInternalErrorResponse("v22_execution_start", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

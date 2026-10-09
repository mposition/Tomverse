export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_MAX_EXPECTED_REVISION, AMUX_PRISMA_INT_MAX,
  amuxMachineIdSchema } from "@/lib/amux/claimContract";
import { AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
  withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { settleAmuxV22TaskExecution } from "@/lib/amux/execution";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxInternalErrorResponse, amuxJsonNoStore,
  isAmuxInputError } from "@/lib/amux/internalRoute";
import { AMUX_V22_TASK_EXECUTION_CODE_LATCH } from
  "@/lib/amux/v22TaskExecutionCore";

const requestSchema = z.object({ attempt_id: z.string().uuid(),
  worker: amuxMachineIdSchema, instance_id: z.string().uuid(),
  generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
  task_revision: z.number().int().min(0).max(AMUX_MAX_EXPECTED_REVISION),
  outcome: z.enum(["succeeded", "failed", "blocked"]),
  invocation_ids: z.array(z.string().uuid()).max(128),
}).strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  // An environment kill switch closes admission, not settlement of an
  // existing fenced attempt. A code-latch-off build stays dark.
  if (!AMUX_V22_TASK_EXECUTION_CODE_LATCH)
    return amuxJsonNoStore({ settled: false,
      reason: "v22_execution_disabled" }, 409);
  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 8 * 1_024, requestSchema);
      const result = await settleAmuxV22TaskExecution({
        attemptId: body.attempt_id, worker: body.worker,
        instanceId: body.instance_id, generation: body.generation,
        taskRevision: body.task_revision, outcome: body.outcome,
        invocationIds: body.invocation_ids,
      });
      return amuxJsonNoStore(result, result.settled ? 200 : 409);
    } catch (error) {
      if (isAmuxInputError(error))
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      return amuxInternalErrorResponse("v22_execution_settle", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

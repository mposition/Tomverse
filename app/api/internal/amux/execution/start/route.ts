export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_MAX_EXPECTED_REVISION,
  AMUX_PRISMA_INT_MAX,
  amuxMachineIdSchema,
} from "@/lib/amux/claimContract";
import {
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import {
  amuxInternalErrorResponse,
  amuxJsonNoStore,
  isAmuxInputError,
} from "@/lib/amux/internalRoute";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import { startAmuxExecution } from "@/lib/amux/execution";

const requestSchema = z
  .object({
    task_id: amuxMachineIdSchema,
    worker: amuxMachineIdSchema,
    instance_id: z.string().uuid(),
    generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
    expected_revision: z.number().int().min(0).max(AMUX_MAX_EXPECTED_REVISION),
  })
  .strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return Response.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  if (!isAmuxExecutionApiEnabled()) {
    return Response.json(
      {
        started: false,
        reason: "execution_api_disabled",
      },
      {
        status: 409,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 4 * 1_024, requestSchema);

      const outcome = await startAmuxExecution({
        taskId: body.task_id,
        worker: body.worker,
        instanceId: body.instance_id,
        generation: body.generation,
        expectedRevision: body.expected_revision,
      });

      if (!outcome.started) {
        return Response.json(outcome, {
          status: 409,
          headers: {
            "Cache-Control": "no-store",
          },
        });
      }

      return Response.json(
        {
          started: true,
          attempt_id: outcome.attemptId,
          task_revision: outcome.taskRevision,
          lease_expires_at: outcome.leaseExpiresAt.toISOString(),
        },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (error) {
      if (isAmuxInputError(error)) {
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      }
      return amuxInternalErrorResponse("execution_start", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

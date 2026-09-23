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
import { settleAmuxExecution } from "@/lib/amux/execution";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";

const requestSchema = z
  .object({
    attempt_id: z.string().uuid(),
    worker: amuxMachineIdSchema,
    instance_id: z.string().uuid(),
    generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
    task_revision: z.number().int().min(0).max(AMUX_MAX_EXPECTED_REVISION),
    outcome: z.enum(["succeeded", "failed", "blocked"]),
    to_status: z.enum(["todo", "review", "done", "blocked"]),
    reason: z.string().trim().max(1_000).nullable().optional(),
    cost_microusd: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
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
        settled: false,
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
      const body = await readLimitedJson(request, 8 * 1_024, requestSchema);

      const outcome = await settleAmuxExecution({
        attemptId: body.attempt_id,
        worker: body.worker,
        instanceId: body.instance_id,
        generation: body.generation,
        taskRevision: body.task_revision,
        outcome: body.outcome,
        toStatus: body.to_status,
        reason: body.reason ?? null,
        actualCostMicrousd:
          body.cost_microusd === null || body.cost_microusd === undefined
            ? null
            : BigInt(body.cost_microusd),
      });

      return Response.json(outcome, {
        status: outcome.settled ? 200 : 409,
        headers: {
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      if (isAmuxInputError(error)) {
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      }
      return amuxInternalErrorResponse("execution_settle", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

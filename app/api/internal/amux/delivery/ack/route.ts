export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
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
import { acknowledgeAmuxWorkDelivery } from "@/lib/amux/delivery";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";

const requestSchema = z
  .object({
    attempt_id: z.string().uuid(),
    receipt_id: z.string().uuid(),
    worker: amuxMachineIdSchema,
    instance_id: z.string().uuid(),
    generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
    task_revision: z.number().int().min(0).max(AMUX_PRISMA_INT_MAX),
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
        acknowledged: false,
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

      const outcome = await acknowledgeAmuxWorkDelivery({
        attemptId: body.attempt_id,
        receiptId: body.receipt_id,
        worker: body.worker,
        instanceId: body.instance_id,
        generation: body.generation,
        taskRevision: body.task_revision,
      });

      return Response.json(outcome, {
        status: outcome.acknowledged ? 200 : 409,
        headers: {
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      if (isAmuxInputError(error)) {
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      }
      return amuxInternalErrorResponse("delivery_ack", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

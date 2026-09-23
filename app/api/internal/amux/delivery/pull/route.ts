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
import { pullAmuxWorkDelivery } from "@/lib/amux/delivery";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";

const requestSchema = z
  .object({
    worker: amuxMachineIdSchema,
    instance_id: z.string().uuid(),
    generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
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
        available: false,
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
      const body = await readLimitedJson(request, 2 * 1_024, requestSchema);

      const outcome = await pullAmuxWorkDelivery({
        worker: body.worker,
        instanceId: body.instance_id,
        generation: body.generation,
      });

      if (!outcome.available) {
        return Response.json(outcome, {
          status: outcome.reason === "runtime_not_ready" ? 409 : 200,
          headers: {
            "Cache-Control": "no-store",
          },
        });
      }

      return Response.json(
        {
          available: true,
          delivery: {
            attempt_id: outcome.delivery.attemptId,
            task_id: outcome.delivery.taskId,
            worker: outcome.delivery.worker,
            task_revision: outcome.delivery.taskRevision,
            prompt: outcome.delivery.prompt,
            receipt_id: outcome.delivery.receiptId,
            lease_expires_at: outcome.delivery.leaseExpiresAt.toISOString(),
          },
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
      return amuxInternalErrorResponse("delivery_pull", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

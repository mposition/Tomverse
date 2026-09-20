export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { pullAmuxWorkDelivery } from "@/lib/amux/delivery";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";

const requestSchema = z
  .object({
    worker: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9._:-]+$/),
    instance_id: z.string().uuid(),
    generation: z.number().int().min(1),
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

  try {
    const body = await readLimitedJson(
      request,
      2 * 1_024,
      requestSchema,
    );

    const outcome =
      await pullAmuxWorkDelivery({
        worker: body.worker,
        instanceId: body.instance_id,
        generation: body.generation,
      });

    if (!outcome.available) {
      return Response.json(
        outcome,
        {
          status:
            outcome.reason ===
            "runtime_not_ready"
              ? 409
              : 200,
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }

    return Response.json(
      {
        available: true,
        delivery: {
          attempt_id:
            outcome.delivery.attemptId,
          task_id: outcome.delivery.taskId,
          worker: outcome.delivery.worker,
          task_revision:
            outcome.delivery.taskRevision,
          prompt: outcome.delivery.prompt,
          receipt_id:
            outcome.delivery.receiptId,
          lease_expires_at:
            outcome.delivery.leaseExpiresAt.toISOString(),
        },
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch {
    return Response.json(
      { error: "Invalid request." },
      {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

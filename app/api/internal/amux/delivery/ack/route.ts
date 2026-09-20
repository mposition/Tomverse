export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { acknowledgeAmuxWorkDelivery } from "@/lib/amux/delivery";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";

const requestSchema = z
  .object({
    attempt_id: z.string().uuid(),
    receipt_id: z.string().uuid(),
    worker: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9._:-]+$/),
    instance_id: z.string().uuid(),
    generation: z.number().int().min(1),
    task_revision: z.number().int().min(0),
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

  try {
    const body = await readLimitedJson(
      request,
      4 * 1_024,
      requestSchema,
    );

    const outcome =
      await acknowledgeAmuxWorkDelivery({
        attemptId: body.attempt_id,
        receiptId: body.receipt_id,
        worker: body.worker,
        instanceId: body.instance_id,
        generation: body.generation,
        taskRevision: body.task_revision,
      });

    return Response.json(
      outcome,
      {
        status:
          outcome.acknowledged ? 200 : 409,
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

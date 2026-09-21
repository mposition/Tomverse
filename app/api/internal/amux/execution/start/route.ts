export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import { startAmuxExecution } from "@/lib/amux/execution";

const requestSchema = z
  .object({
    task_id: z.string().trim().min(1).max(120),
    worker: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9._:-]+$/),
    instance_id: z.string().uuid(),
    generation: z.number().int().min(1),
    expected_revision: z.number().int().min(0),
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

  try {
    const body = await readLimitedJson(
      request,
      4 * 1_024,
      requestSchema,
    );

    const outcome = await startAmuxExecution({
      taskId: body.task_id,
      worker: body.worker,
      instanceId: body.instance_id,
      generation: body.generation,
      expectedRevision:
        body.expected_revision,
    });

    if (!outcome.started) {
      return Response.json(
        outcome,
        {
          status: 409,
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }

    return Response.json(
      {
        started: true,
        attempt_id: outcome.attemptId,
        task_revision: outcome.taskRevision,
        lease_expires_at:
          outcome.leaseExpiresAt.toISOString(),
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

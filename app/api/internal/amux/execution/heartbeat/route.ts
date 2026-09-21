export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { heartbeatAmuxExecution } from "@/lib/amux/execution";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";

const requestSchema = z
  .object({
    attempt_id: z.string().uuid(),
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
        accepted: false,
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

    const accepted =
      await heartbeatAmuxExecution({
        attemptId: body.attempt_id,
        worker: body.worker,
        instanceId: body.instance_id,
        generation: body.generation,
        taskRevision: body.task_revision,
      });

    return Response.json(
      accepted
        ? { accepted: true }
        : {
            accepted: false,
            reason: "fenced_out",
          },
      {
        status: accepted ? 200 : 409,
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

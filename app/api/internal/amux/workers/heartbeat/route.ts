export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { getConfiguredAmuxWorkerCatalog } from "@/lib/amux/routing";
import { heartbeatAmuxWorkerRuntime } from "@/lib/amux/workerRuntime";

const requestSchema = z
  .object({
    worker_name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9._:-]+$/),
    instance_id: z.string().uuid(),
    generation: z.number().int().min(1),
    status: z.enum([
      "starting",
      "idle",
      "busy",
      "error",
      "stopped",
    ]),
    dispatch_ready: z.boolean(),
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

  try {
    const body = await readLimitedJson(
      request,
      2 * 1_024,
      requestSchema,
    );

    const catalog = getConfiguredAmuxWorkerCatalog();

    if (!catalog) {
      return Response.json(
        {
          accepted: false,
          reason: "worker_catalog_unavailable",
        },
        {
          status: 409,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    if (
      !catalog.some(
        (worker) =>
          worker.worker_name === body.worker_name,
      )
    ) {
      return Response.json(
        {
          accepted: false,
          reason: "worker_not_configured",
        },
        {
          status: 409,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const heartbeat =
      await heartbeatAmuxWorkerRuntime({
        workerName: body.worker_name,
        instanceId: body.instance_id,
        generation: body.generation,
        status: body.status,
        dispatchReady: body.dispatch_ready,
      });

    if (!heartbeat.accepted) {
      return Response.json(
        {
          accepted: false,
          reason:
            heartbeat.reason ??
            "runtime_lease_lost",
        },
        {
          status: 409,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    return Response.json(
      {
        accepted: true,
        lease_expires_at:
          heartbeat.leaseExpiresAt.toISOString(),
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

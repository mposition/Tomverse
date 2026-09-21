export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { getConfiguredAmuxWorkerCatalog } from "@/lib/amux/routing";
import { registerAmuxWorkerRuntime } from "@/lib/amux/workerRuntime";

const requestSchema = z
  .object({
    worker_name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9._:-]+$/),
    instance_id: z.string().uuid(),
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
          registered: false,
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
          registered: false,
          reason: "worker_not_configured",
        },
        {
          status: 409,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const runtime = await registerAmuxWorkerRuntime(
      body.worker_name,
      body.instance_id,
    );

    return Response.json(
      {
        registered: true,
        generation: runtime.generation,
        lease_expires_at:
          runtime.leaseExpiresAt.toISOString(),
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

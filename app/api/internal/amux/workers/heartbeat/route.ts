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
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import { getConfiguredAmuxWorkerCatalog } from "@/lib/amux/routing";
import { heartbeatAmuxWorkerRuntime } from "@/lib/amux/workerRuntime";

const requestSchema = z
  .object({
    worker_name: amuxMachineIdSchema,
    instance_id: z.string().uuid(),
    generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
    status: z.enum(["starting", "idle", "busy", "error", "stopped"]),
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

  if (!isAmuxExecutionApiEnabled()) {
    return amuxJsonNoStore(
      { accepted: false, reason: "execution_api_disabled" },
      409,
    );
  }

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 2 * 1_024, requestSchema);

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

      if (!catalog.some((worker) => worker.worker_name === body.worker_name)) {
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

      const heartbeat = await heartbeatAmuxWorkerRuntime({
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
            reason: heartbeat.reason ?? "runtime_lease_lost",
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
          lease_expires_at: heartbeat.leaseExpiresAt.toISOString(),
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
      return amuxInternalErrorResponse("worker_heartbeat", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

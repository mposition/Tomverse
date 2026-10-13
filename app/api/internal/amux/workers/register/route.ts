export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxMachineIdSchema } from "@/lib/amux/claimContract";
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
import { amuxWorkerCatalogRefusal } from "@/lib/amux/workerAssignmentCatalog";
import { amuxWorkerDerivedCatalogAssignmentOpen } from "@/lib/amux/workerDerivedCatalogCore";
import {
  AmuxWorkerRegistrationRefusedError,
  registerAmuxWorkerRuntime,
} from "@/lib/amux/workerRuntime";

const requestSchema = z
  .object({
    worker_name: amuxMachineIdSchema,
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

  if (!isAmuxExecutionApiEnabled()) {
    return amuxJsonNoStore(
      { registered: false, reason: "execution_api_disabled" },
      409,
    );
  }

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 2 * 1_024, requestSchema);

      // Orchestration policy version 35, section 3 (R2c): with the derived
      // catalog's code latch on, the name is checked against it inside the
      // registration's own transaction; until then, against the variable here.
      const derived = amuxWorkerDerivedCatalogAssignmentOpen();
      const catalog = derived ? [] : getConfiguredAmuxWorkerCatalog();

      if (!derived && !catalog) {
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

      if (!derived && !catalog?.some((worker) => worker.worker_name === body.worker_name)) {
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
        undefined,
        undefined,
        derived ? (tx) => amuxWorkerCatalogRefusal(tx, body.worker_name, true) : undefined,
      );

      return Response.json(
        {
          registered: true,
          generation: runtime.generation,
          lease_expires_at: runtime.leaseExpiresAt.toISOString(),
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
      if (error instanceof AmuxWorkerRegistrationRefusedError) {
        return amuxJsonNoStore({ registered: false, reason: error.reason }, 409);
      }
      return amuxInternalErrorResponse("worker_register", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

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
import { amuxWorkerCatalogRefusal } from "@/lib/amux/workerAssignmentCatalog";
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

      // Orchestration policy version 35, section 3: the name is checked
      // against the catalog derived from the registry, inside the
      // registration's own transaction. An absent catalog or an unlisted name
      // is refused (worker_catalog_unavailable, worker_not_configured).
      const runtime = await registerAmuxWorkerRuntime(
        body.worker_name,
        body.instance_id,
        undefined,
        undefined,
        (tx) => amuxWorkerCatalogRefusal(tx, body.worker_name),
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

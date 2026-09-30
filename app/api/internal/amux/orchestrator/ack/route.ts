export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import {
  amuxInternalErrorResponse,
  amuxJsonNoStore,
  isAmuxInputError,
} from "@/lib/amux/internalRoute";
import {
  AMUX_ORCHESTRATOR_ACK_KINDS,
  isAmuxOrchestratorUuid,
} from "@/lib/amux/orchestratorHaltCore";
import { acknowledgeAmuxOrchestratorWrite } from "@/lib/amux/orchestratorHaltService";

/**
 * The orchestrator's acknowledgement of a known answer to one of its write
 * calls (docs/policy/development-agent-orchestration.md, version 20, section
 * 4). `definite` answers a 2xx or a 409 refusal and succeeds whatever the
 * request committed. `no_commit` answers one of the three 503 reasons that say
 * nothing was committed, and is refused (409 `receipts_present`) when the
 * request has a receipt; the orchestrator halts on that refusal. Both take the
 * admission's row lock and count the receipts after it. Acknowledging twice
 * changes nothing.
 */

const requestSchema = z
  .object({
    request_id: z.string().refine(isAmuxOrchestratorUuid),
    kind: z.enum(AMUX_ORCHESTRATOR_ACK_KINDS),
  })
  .strict();

const OPERATION = "orchestrator_ack";

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 1_024, requestSchema);
      const decision = await acknowledgeAmuxOrchestratorWrite({
        requestId: body.request_id,
        kind: body.kind,
      });
      return decision.acked
        ? amuxJsonNoStore({ acked: true })
        : amuxJsonNoStore({ acked: false, reason: decision.reason }, 409);
    } catch (error) {
      if (isAmuxInputError(error)) {
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      }
      return amuxInternalErrorResponse(OPERATION, error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

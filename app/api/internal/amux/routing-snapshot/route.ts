export const dynamic = "force-dynamic";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_MACHINE_ID_PATTERN,
  AMUX_MAX_EXPECTED_REVISION,
} from "@/lib/amux/claimContract";
import { withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import {
  amuxBoundedJsonNoStore,
  amuxInternalErrorResponse,
  amuxJsonNoStore,
  AmuxResponseCapacityError,
  isAmuxInputError,
} from "@/lib/amux/internalRoute";
import { buildAmuxRoutingSnapshot } from "@/lib/amux/routing";
import { amuxRoutingResponseSchema } from "@/lib/amux/wireContract";
import { z } from "zod";

const requestSchema = z
  .object({
    task_id: z.string().min(1).max(120).regex(AMUX_MACHINE_ID_PATTERN),
    expected_revision: z.number().int().min(0).max(AMUX_MAX_EXPECTED_REVISION),
  })
  .strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 2 * 1_024, requestSchema);
      const snapshot = await buildAmuxRoutingSnapshot(
        body.task_id,
        body.expected_revision,
      );
      return amuxBoundedJsonNoStore(snapshot, 200, amuxRoutingResponseSchema);
    } catch (error) {
      if (isAmuxInputError(error)) {
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      }
      if (error instanceof AmuxResponseCapacityError) {
        return amuxJsonNoStore(
          { eligible: false, reason: "board_capacity_exceeded" },
          409,
        );
      }
      return amuxInternalErrorResponse("routing_snapshot", error);
    }
  }, 2_800);
}

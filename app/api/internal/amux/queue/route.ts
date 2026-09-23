export const dynamic = "force-dynamic";

import { readLimitedJson } from "@/lib/apiSecurity";
import { withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import {
  amuxBoundedJsonNoStore,
  amuxInternalErrorResponse,
  amuxJsonNoStore,
  AmuxResponseCapacityError,
  isAmuxInputError,
} from "@/lib/amux/internalRoute";
import { AmuxQueueCapacityError, listDispatchable } from "@/lib/amux/store";
import { amuxQueueResponseSchema } from "@/lib/amux/wireContract";
import { z } from "zod";

const requestSchema = z.object({}).strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }

  return withAmuxRouteBudget(async () => {
    try {
      await readLimitedJson(request, 1_024, requestSchema);
      return amuxBoundedJsonNoStore(
        await listDispatchable(),
        200,
        amuxQueueResponseSchema,
      );
    } catch (error) {
      if (isAmuxInputError(error)) {
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      }
      if (
        error instanceof AmuxQueueCapacityError ||
        error instanceof AmuxResponseCapacityError
      ) {
        return amuxJsonNoStore(
          {
            error: "Queue capacity exceeded.",
            reason: "board_capacity_exceeded",
          },
          409,
        );
      }
      return amuxInternalErrorResponse("queue", error);
    }
  }, 2_800);
}

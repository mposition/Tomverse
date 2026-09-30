export const dynamic = "force-dynamic";

import { readLimitedJson } from "@/lib/apiSecurity";
import { withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import {
  amuxBoundedJsonNoStore,
  amuxInternalErrorResponse,
  amuxJsonNoStore,
  AmuxResponseCapacityError,
  isAmuxInputError,
} from "@/lib/amux/internalRoute";
import { AmuxQueueCapacityError, listOwnedTodos } from "@/lib/amux/store";
import { amuxOwnedQueueResponseSchema } from "@/lib/amux/wireContract";
import { z } from "zod";

const requestSchema = z.object({}).strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }

  if (!isAmuxExecutionApiEnabled()) {
    return amuxJsonNoStore(
      { available: false, reason: "execution_api_disabled" },
      409,
    );
  }

  return withAmuxRouteBudget(async () => {
    try {
      await readLimitedJson(request, 1_024, requestSchema);
      return amuxBoundedJsonNoStore(
        await listOwnedTodos(),
        200,
        amuxOwnedQueueResponseSchema,
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
      return amuxInternalErrorResponse("owned_queue", error);
    }
  }, 2_800);
}

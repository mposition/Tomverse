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
import { listOwnedTodos } from "@/lib/amux/store";
import {
  amuxOwnedQueueResponseSchema,
  keepCanonicalAmuxQueueRows,
} from "@/lib/amux/wireContract";
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
        keepCanonicalAmuxQueueRows("owned", await listOwnedTodos(), (row) => [
          row.id,
          row.owner,
        ]),
        200,
        amuxOwnedQueueResponseSchema,
      );
    } catch (error) {
      if (isAmuxInputError(error)) {
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      }
      // A queue longer than one answer is answered with its head (store.ts);
      // only an answer past the wire's 512 KiB is refused.
      if (error instanceof AmuxResponseCapacityError) {
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

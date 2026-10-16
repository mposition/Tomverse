export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_DB_BOUNDARIES,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import {
  dmInternalRoutesEnabled,
  dmReturnedRefusalStatus,
  dmRouteErrorResponse,
  dmRouteRefusal,
} from "@/lib/amux/decisionMakerInternalRoute";
import { recordDecisionMakerCleanupUnknown } from "@/lib/amux/decisionMakerRequestStore";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker cleanup unknown (docs/policy/amux-decision-maker.md §5,
 * §10): the broker could not confirm that a request's directory -- the card,
 * the snapshot, the prompt and the temporary output -- was deleted. The
 * request store's `recordDecisionMakerCleanupUnknown()` records
 * `amux.decision.cleanup_unknown` under the request's instance and latches
 * that instance `off` in the same transaction; only the operator releases the
 * latch. A request of another instance, or one never assigned, had no
 * directory and records nothing. This route only authenticates, reads the
 * body and runs that one transaction in the route budget and its DB boundary.
 *
 * A report sent again records another pair; it only turns the instance off,
 * so a broker that lost this answer sends it again rather than leave the
 * instance on. The answer carries the latch's switch event, never an audit id.
 *
 * Closed until the operator sets `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 */

const MAX_BODY_BYTES = 1_024;

const requestSchema = z
  .object({
    request_id: z.unknown(),
    instance: z.unknown(),
  })
  .strict();

const OPERATION = "decision_maker_cleanup_unknown";

const refused = dmRouteRefusal("recorded");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      const cleanup = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerCleanupUnknown, (tx) =>
        recordDecisionMakerCleanupUnknown(tx, {
          requestId: body.request_id,
          instance: body.instance,
        }),
      );
      if (!cleanup.recorded) return refused(dmReturnedRefusalStatus(cleanup.reason), cleanup.reason);
      return amuxJsonNoStore({
        recorded: true,
        latch_event_id: cleanup.latch.eventId,
        created_at: cleanup.latch.createdAt,
      });
    } catch (error) {
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}

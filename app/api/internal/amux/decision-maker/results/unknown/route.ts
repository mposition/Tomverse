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
import { recordDecisionMakerResultUnknown } from "@/lib/amux/decisionMakerRequestStore";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker result unknown (docs/policy/amux-decision-maker.md §9):
 * a broker that lost the answer to a result submission, and could not settle
 * it by the (request, result digest) pair on the lookup route, records the
 * result as unknown. The request then goes to the operator and no later
 * result is accepted for it; a pair the ledger already accepted or rejected
 * is reported as such and nothing is written. The decision is the request
 * store's `recordDecisionMakerResultUnknown()`; this route only authenticates,
 * reads the body and runs that one transaction in the route budget and its DB
 * boundary.
 *
 * Closed until the operator sets `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 */

const MAX_BODY_BYTES = 1_024;

const requestSchema = z
  .object({
    request_id: z.unknown(),
    instance: z.unknown(),
    result_digest: z.unknown(),
  })
  .strict();

const OPERATION = "decision_maker_result_unknown";

const refused = dmRouteRefusal("recorded");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      const unknown = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerResultUnknown, (tx) =>
        recordDecisionMakerResultUnknown(tx, {
          requestId: body.request_id,
          instance: body.instance,
          resultDigest: body.result_digest,
        }),
      );
      if (!unknown.recorded) return refused(dmReturnedRefusalStatus(unknown.reason), unknown.reason);
      return amuxJsonNoStore({
        recorded: true,
        event_id: unknown.event.eventId,
        created_at: unknown.event.createdAt,
      });
    } catch (error) {
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}

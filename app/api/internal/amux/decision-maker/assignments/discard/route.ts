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
import { discardDecisionMakerAssignment } from "@/lib/amux/decisionMakerRequestStore";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker assignment discard (docs/policy/amux-decision-maker.md
 * §2-3): the local AMUX could not mark the card -- it was answered, its
 * question revision changed, or it left `needsyou` -- so it discards the
 * assignment and the request closes. The decision is the request store's
 * `discardDecisionMakerAssignment()`; this route only authenticates, reads the
 * body and runs that one transaction in the route budget and its DB boundary.
 *
 * Closed until the operator sets `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 */

const MAX_BODY_BYTES = 1_024;

const requestSchema = z.object({ request_id: z.unknown() }).strict();

const OPERATION = "decision_maker_assignment_discard";

const refused = dmRouteRefusal("recorded");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      const discarded = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerAssignmentDiscard, (tx) =>
        discardDecisionMakerAssignment(tx, { requestId: body.request_id }),
      );
      if (!discarded.recorded) return refused(dmReturnedRefusalStatus(discarded.reason), discarded.reason);
      return amuxJsonNoStore({
        recorded: true,
        event_id: discarded.event.eventId,
        created_at: discarded.event.createdAt,
      });
    } catch (error) {
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}

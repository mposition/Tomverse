export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_DB_BOUNDARIES,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { assignDecisionMakerRequestWithDigestKey } from "@/lib/amux/decisionMakerBodyStore";
import { loadDecisionMakerDigestKeyRing } from "@/lib/amux/decisionMakerDigestKeys";
import {
  dmInternalRoutesEnabled,
  dmReturnedRefusalStatus,
  dmRouteErrorResponse,
  dmRouteRefusal,
} from "@/lib/amux/decisionMakerInternalRoute";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker assignment (docs/policy/amux-decision-maker.md §2-1,
 * §2-3, §9): the bridge takes a request routed to a DM, once, before its
 * assignment deadline by the database clock. The decision -- the request's
 * state, its period key registered and undestroyed, the deadline, the one
 * assignment -- is the body store's `assignDecisionMakerRequestWithDigestKey()`;
 * this route only authenticates, reads the body, loads the key ring and runs
 * that one transaction in the route budget and its DB boundary, whose commit
 * fence holds the assignment deadline.
 *
 * A recorded assignment answers with the request key K_R, for the assigned
 * broker only: the broker keys its input payload and snapshot manifest
 * digests and recomputes a result digest with it (§9, §10). K_R opens no
 * other request and is not the period key, which never leaves the server. It
 * is in this one answer, `no-store`, and in no log line. A second assignment
 * is refused (`already_assigned`), so an answer that was lost is not handed
 * out again: the question stays with the operator.
 *
 * Closed until the operator sets `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 */

const MAX_BODY_BYTES = 1_024;

const requestSchema = z.object({ request_id: z.unknown() }).strict();

const OPERATION = "decision_maker_assignment";

const refused = dmRouteRefusal("recorded");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      const keyRing = loadDecisionMakerDigestKeyRing();
      const assigned = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerAssignment, (tx, context) =>
        assignDecisionMakerRequestWithDigestKey(tx, {
          requestId: body.request_id,
          requireLeaseAt: context.requireLeaseAt,
          keyRing,
        }),
      );
      if (!assigned.recorded) return refused(dmReturnedRefusalStatus(assigned.reason), assigned.reason);
      return amuxJsonNoStore({
        recorded: true,
        event_id: assigned.event.eventId,
        created_at: assigned.event.createdAt,
        result_deadline_at: assigned.event.resultDeadlineAt,
        key_period: assigned.keyPeriod,
        request_key: assigned.requestKey.toString("base64"),
      });
    } catch (error) {
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}

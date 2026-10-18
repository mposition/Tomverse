export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_DB_BOUNDARIES,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { dmDeliveryRouteErrorResponse } from "@/lib/amux/decisionMakerDeliveryRoute";
import {
  dmInternalRoutesEnabled,
  dmReturnedRefusalStatus,
  dmRouteRefusal,
} from "@/lib/amux/decisionMakerInternalRoute";
import { recordDecisionMakerDeliveryOutcome } from "@/lib/amux/decisionMakerJudgmentStore";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker delivery outcome (docs/policy/amux-decision-maker.md
 * §2-7, §9), stage S2-2b3: after the decision, the delivery's receipt -- the
 * local AMUX confirmed the message reached the worker -- or `unknown` when
 * its result is unclear, one of the two once. Recorded under the kill switch
 * as well: each records what already happened. An unknown delivery is never
 * sent again; the bridge pauses the worker's session and a person resolves it
 * in Admin. The decision is the judgment store's
 * `recordDecisionMakerDeliveryOutcome()`; this route only authenticates, reads
 * the body and runs that one transaction in the route budget and its DB
 * boundary.
 *
 * Closed until the operator sets `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 */

const MAX_BODY_BYTES = 1_024;

const requestSchema = z
  .object({
    request_id: z.unknown(),
    outcome: z.unknown(),
  })
  .strict();

const OPERATION = "decision_maker_delivery_outcome";

const refused = dmRouteRefusal("recorded");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      const outcome = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDeliveryOutcome, (tx) =>
        recordDecisionMakerDeliveryOutcome(tx, { requestId: body.request_id, outcome: body.outcome }),
      );
      if (!outcome.recorded) return refused(dmReturnedRefusalStatus(outcome.reason), outcome.reason);
      return amuxJsonNoStore({
        recorded: true,
        event_id: outcome.event.eventId,
        created_at: outcome.event.createdAt,
      });
    } catch (error) {
      return dmDeliveryRouteErrorResponse(OPERATION, error, refused);
    }
  });
}

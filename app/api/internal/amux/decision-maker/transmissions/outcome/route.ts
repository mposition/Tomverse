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
import { recordDecisionMakerTransmitOutcome } from "@/lib/amux/decisionMakerRequestStore";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker transmission outcome (docs/policy/amux-decision-maker.md
 * §10): once the DM process ended the broker records its receipt, or
 * `unknown` when it cannot say. Either way the card counts as sent and is
 * never sent again; one of the two per request, accepted even after the
 * request closed. The decision is the request store's
 * `recordDecisionMakerTransmitOutcome()`; this route only authenticates, reads
 * the body and runs that one transaction in the route budget and its DB
 * boundary.
 *
 * Closed until the operator sets `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 */

const MAX_BODY_BYTES = 1_024;

const requestSchema = z
  .object({
    request_id: z.unknown(),
    instance: z.unknown(),
    outcome: z.unknown(),
  })
  .strict();

const OPERATION = "decision_maker_transmit_outcome";

const refused = dmRouteRefusal("recorded");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      const outcome = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerTransmitOutcome, (tx) =>
        recordDecisionMakerTransmitOutcome(tx, {
          requestId: body.request_id,
          instance: body.instance,
          outcome: body.outcome,
        }),
      );
      if (!outcome.recorded) return refused(dmReturnedRefusalStatus(outcome.reason), outcome.reason);
      return amuxJsonNoStore({
        recorded: true,
        event_id: outcome.event.eventId,
        created_at: outcome.event.createdAt,
      });
    } catch (error) {
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}

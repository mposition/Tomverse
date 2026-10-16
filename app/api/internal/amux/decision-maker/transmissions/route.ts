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
import { recordDecisionMakerTransmitIntent } from "@/lib/amux/decisionMakerRequestStore";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker transmission intent (docs/policy/amux-decision-maker.md
 * §2-4, §10): before any DM process starts, the broker records what it is
 * about to send -- the instance, the input payload digest and the snapshot's
 * state, target SHA and manifest digest, keyed with the request key -- and
 * starts the process only on a recorded intent. Sending the card to a vendor
 * cannot be taken back, so the intent is one per request and the card is never
 * sent again.
 *
 * The decision -- the request's state, the switches read after the audit
 * chain lock (kill switch on, instance off), the result deadline -- is the
 * request store's `recordDecisionMakerTransmitIntent()`; this route only
 * authenticates, reads the body and runs that one transaction in the route
 * budget and its DB boundary, whose commit fence holds the result deadline.
 * Anything but a recorded intent means the broker starts nothing.
 *
 * Closed until the operator sets `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 */

/** A request id, an instance and four short values: the SHA and three digests. */
const MAX_BODY_BYTES = 2_048;

const requestSchema = z
  .object({
    request_id: z.unknown(),
    instance: z.unknown(),
    transmission: z.unknown(),
  })
  .strict();

const OPERATION = "decision_maker_transmit_intent";

const refused = dmRouteRefusal("recorded");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      const intent = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerTransmitIntent, (tx, context) =>
        recordDecisionMakerTransmitIntent(tx, {
          requestId: body.request_id,
          instance: body.instance,
          transmission: body.transmission,
          requireLeaseAt: context.requireLeaseAt,
        }),
      );
      if (!intent.recorded) return refused(dmReturnedRefusalStatus(intent.reason), intent.reason);
      return amuxJsonNoStore({
        recorded: true,
        event_id: intent.event.eventId,
        created_at: intent.event.createdAt,
      });
    } catch (error) {
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}

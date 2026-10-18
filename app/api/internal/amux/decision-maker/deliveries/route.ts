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
import { recordDecisionMakerDelivery } from "@/lib/amux/decisionMakerJudgmentStore";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker delivery decision (docs/policy/amux-decision-maker.md
 * §2-7, §9), stage S2-2b3: before the bridge sends a confirmed answer to the
 * worker, the request's one delivery decision is recorded -- only after a
 * confirmation or an edited confirmation, once (§9: "요청마다 ... 전달 결정 행은
 * 하나뿐이다"), and never while the kill switch is on (§6's table). The bridge
 * sends nothing without this route's recorded answer; an answer it lost is not
 * asked again (the relay halts), so a decision is never doubled. The decision
 * is the judgment store's `recordDecisionMakerDelivery()`; this route only
 * authenticates, reads the body and runs that one transaction in the route
 * budget and its DB boundary.
 *
 * Closed until the operator sets `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 */

const MAX_BODY_BYTES = 1_024;

const requestSchema = z
  .object({
    request_id: z.unknown(),
  })
  .strict();

const OPERATION = "decision_maker_delivery_decision";

const refused = dmRouteRefusal("recorded");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      const decision = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDeliveryDecision, (tx) =>
        recordDecisionMakerDelivery(tx, { requestId: body.request_id }),
      );
      if (!decision.recorded) return refused(dmReturnedRefusalStatus(decision.reason), decision.reason);
      return amuxJsonNoStore({
        recorded: true,
        event_id: decision.event.eventId,
        created_at: decision.event.createdAt,
        judgment_kind: decision.judgmentKind,
      });
    } catch (error) {
      return dmDeliveryRouteErrorResponse(OPERATION, error, refused);
    }
  });
}

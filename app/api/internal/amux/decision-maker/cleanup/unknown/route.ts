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
  settleDmCleanupLatch,
} from "@/lib/amux/decisionMakerInternalRoute";
import { recordDecisionMakerCleanupUnknown } from "@/lib/amux/decisionMakerRequestStore";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker cleanup unknown (docs/policy/amux-decision-maker.md §5,
 * §10, stage S2-2a3): the broker could not confirm that a request's directory
 * and its vendor account's scratch directory were deleted, and reports it for
 * the request's own instance. The request store's
 * `recordDecisionMakerCleanupUnknown()` records the request's one
 * `cleanup_unknown` event under the instance's
 * `amux.decision.cleanup_unknown` audit, or returns the one already recorded
 * when the broker sends the report again (a lost answer is settled by sending
 * the same report, which never writes twice). This route only authenticates,
 * reads the body and runs that one transaction in the route budget and its DB
 * boundary.
 *
 * §5 then latches the instance off: once the report is recorded or found, the
 * route runs the cleanup latch check in a second boundary transaction
 * (`settleDmCleanupLatch()`), which can only turn the instance off and does so
 * once per report -- a report the latch or a person's release already
 * followed owes nothing. The answer is the report's whatever that check does;
 * a latch that could not be written stays owed, and a routing or a
 * transmission intent of the instance is refused meanwhile.
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
      const report = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerCleanupUnknown, (tx) =>
        recordDecisionMakerCleanupUnknown(tx, {
          requestId: body.request_id,
          instance: body.instance,
        }),
      );
      if (report.status === "refused") return refused(dmReturnedRefusalStatus(report.reason), report.reason);
      // The store accepted the instance as the request's own before either answer.
      await settleDmCleanupLatch(body.instance);
      return amuxJsonNoStore({
        recorded: true,
        status: report.status,
        event_id: report.status === "recorded" ? report.event.eventId : report.eventId,
        created_at: report.status === "recorded" ? report.event.createdAt : report.createdAt,
      });
    } catch (error) {
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}

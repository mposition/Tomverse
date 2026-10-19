export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_DB_BOUNDARIES,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { readDecisionMakerUnsettledDelivery } from "@/lib/amux/decisionMakerDeliveryRead";
import { dmDeliveryRouteErrorResponse } from "@/lib/amux/decisionMakerDeliveryRoute";
import { dmInternalRoutesEnabled, dmRouteRefusal } from "@/lib/amux/decisionMakerInternalRoute";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker: the oldest delivery decision with no outcome
 * (docs/policy/amux-decision-maker.md §9), stage S2-2b4. A decision gets its
 * outcome in the same bridge step, so one without is what a bridge that
 * stopped in between left behind; the bridge reads it at its start, looks up
 * the local AMUX's own records -- the receipt of `message_id` in `session`,
 * the answer record of the card's question revision -- and records the
 * outcome they prove (`deliveries/outcome`), pausing the session for an
 * unknown one. Nothing is ever sent again. Composed in a read boundary by
 * lib/amux/decisionMakerDeliveryRead.ts; nothing is written.
 *
 * It carries no answer, only §9's binding, and reads no switch: recording
 * what already happened is allowed under the kill switch (§6's table).
 *
 * Closed until the operator sets `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 */

const MAX_BODY_BYTES = 256;

const requestSchema = z.object({}).strict();

const OPERATION = "decision_maker_delivery_unsettled_read";

const refused = dmRouteRefusal("found");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      const read = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDeliveryUnsettledRead, (tx) =>
        readDecisionMakerUnsettledDelivery(tx),
      );
      if (read.status === "none") return amuxJsonNoStore({ found: true, status: "none", delivery: null });
      return amuxJsonNoStore({
        found: true,
        status: "unsettled",
        delivery: {
          request_id: read.requestId,
          decided_at_ms: read.decidedAtMs,
          card_id: read.cardId,
          question_revision: read.questionRevision,
          // §9's binding: the session whose receipt the local AMUX reads and pauses.
          worker: read.askingWorkerId,
          session: read.session,
          session_attempt: read.sessionAttempt,
          message_id: read.messageId,
        },
      });
    } catch (error) {
      return dmDeliveryRouteErrorResponse(OPERATION, error, refused);
    }
  });
}

export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_DB_BOUNDARIES,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { parseDmDeliveryCursor } from "@/lib/amux/decisionMakerDeliveryCore";
import { readDecisionMakerDeliveryCandidate } from "@/lib/amux/decisionMakerDeliveryRead";
import { dmDeliveryRouteErrorResponse } from "@/lib/amux/decisionMakerDeliveryRoute";
import { dmInternalRoutesEnabled, dmRouteRefusal } from "@/lib/amux/decisionMakerInternalRoute";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker: the next operator-confirmed answer to deliver
 * (docs/policy/amux-decision-maker.md §2-7, §7), stage S2-2b3. The bridge
 * relay asks once per tick, passing the last candidate it was given as
 * `after`. The answer is one confirmation -- `confirm` or `edit_confirm` --
 * with no delivery decision yet: the asking worker's session, the card and
 * question revision, the local message id and the worker message (§7's header,
 * the answer, the sentence); or `undeliverable` when its answer body was
 * erased; or `none`. Composed in a read boundary by
 * lib/amux/decisionMakerDeliveryRead.ts; nothing is written.
 *
 * §6's table: "bridge의 확정 답 조회·전달 — 거부" under the kill switch, which
 * is 409 `kill_switch_on` here with no answer read. A rejection, an unjudged
 * proposal and any other DM output are never returned. Reading releases
 * nothing: the bridge sends only after the delivery decision
 * (deliveries/route.ts) is recorded.
 *
 * Closed until the operator sets `TOMVERSE_AMUX_DM_ROUTING=enabled`. The answer
 * carries the message; no log line here does.
 */

const MAX_BODY_BYTES = 1_024;

const requestSchema = z
  .object({
    after: z.unknown(),
  })
  .strict();

const OPERATION = "decision_maker_delivery_candidate_read";

const refused = dmRouteRefusal("found");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      const after = parseDmDeliveryCursor(body.after);
      if (after === undefined) return refused(400, "invalid_input");
      const read = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDeliveryCandidateRead, (tx) =>
        readDecisionMakerDeliveryCandidate(tx, { after }),
      );
      switch (read.status) {
        case "kill_switch_on":
          return refused(409, "kill_switch_on");
        case "none":
          return amuxJsonNoStore({ found: true, status: "none", delivery: null });
        case "undeliverable":
          return amuxJsonNoStore({
            found: true,
            status: "undeliverable",
            delivery: { request_id: read.requestId, judged_at_ms: read.judgedAtMs, reason: read.reason },
          });
        case "ready":
          return amuxJsonNoStore({
            found: true,
            status: "ready",
            delivery: {
              request_id: read.requestId,
              judged_at_ms: read.judgedAtMs,
              judgment_kind: read.judgmentKind,
              instance: read.instance,
              card_id: read.cardId,
              question_revision: read.questionRevision,
              // §9's binding: the local AMUX holds the card to it before it claims.
              worker: read.askingWorkerId,
              session: read.session,
              session_attempt: read.sessionAttempt,
              message_id: read.messageId,
              message: read.message,
            },
          });
      }
    } catch (error) {
      return dmDeliveryRouteErrorResponse(OPERATION, error, refused);
    }
  });
}

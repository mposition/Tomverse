export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_DB_BOUNDARIES,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import {
  DecisionMakerBodyWriteError,
  recordDecisionMakerRequestWithCardText,
} from "@/lib/amux/decisionMakerBodyStore";
import {
  DecisionMakerDigestKeyError,
  loadDecisionMakerDigestKeyRing,
} from "@/lib/amux/decisionMakerDigestKeys";
import { DecisionMakerRequestWriteError } from "@/lib/amux/decisionMakerRequestStore";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import {
  amuxInternalErrorResponse,
  amuxJsonNoStore,
  isAmuxInputError,
} from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker routing (docs/policy/amux-decision-maker.md §2-1, §2-2,
 * §3): the app route the bridge sends a worker's typed ask to. The decision is
 * `routeDmQuestion()`'s, made inside the body store's routing on reads taken
 * after the audit chain lock; this route only authenticates, reads the body,
 * loads the digest key ring and runs that one transaction in the AMUX route
 * budget and DB boundary. There is no LLM call here and no card text in any
 * answer or log line.
 *
 * Whatever this route answers short of a recorded request -- a refusal, a key
 * ring that is missing, a busy or late database -- the card stays with the
 * operator (§2-1: "route 실패·bridge 실패·마감 경과면 DM 없이 운영자만
 * 남는다"). A request is one per (card, question revision) (§9), so sending
 * the same question again after an unknown outcome reads back the request
 * that committed instead of making a second one.
 *
 * Closed until the operator sets `TOMVERSE_AMUX_DM_ROUTING=enabled`: the
 * bridge path that calls this is stage S2 (§12), and until it is approved and
 * running no request row is written, whatever the switches say.
 */

const AMUX_DM_ROUTING_ENV = "TOMVERSE_AMUX_DM_ROUTING";

/** The card text is capped at 16 KiB (§5); the body carries it once, with the binding. */
const MAX_BODY_BYTES = 64 * 1_024;

const requestSchema = z
  .object({
    binding: z.unknown(),
    card: z.unknown(),
  })
  .strict();

const OPERATION = "decision_maker_routing";

const refused = (status: number, reason: string) =>
  amuxJsonNoStore({ routed: false, reason }, status);

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (process.env[AMUX_DM_ROUTING_ENV] !== "enabled") {
    return refused(409, "dm_routing_disabled");
  }

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      const keyRing = loadDecisionMakerDigestKeyRing();
      const routed = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerRouting, (tx) =>
        recordDecisionMakerRequestWithCardText(tx, {
          binding: body.binding,
          card: body.card,
          keyRing,
        }),
      );
      return amuxJsonNoStore({
        routed: true,
        request_id: routed.requestId,
        created: routed.created,
        route: routed.route,
        instance: routed.instance,
        refusal_codes: routed.refusalCodes,
        same_binding: routed.sameBinding,
        created_at: routed.createdAt,
        assignment_deadline_at: routed.assignmentDeadlineAt,
        card_text_stored: routed.cardText !== null,
      });
    } catch (error) {
      if (isAmuxInputError(error)) return refused(400, "invalid_request");
      if (error instanceof DecisionMakerDigestKeyError) {
        // The code only: never the variable's value.
        console.error(
          JSON.stringify({ subsystem: "amux", event: "dm_digest_keys_unavailable", code: error.code }),
        );
        return refused(503, "dm_digest_keys_unavailable");
      }
      if (error instanceof DecisionMakerRequestWriteError) {
        switch (error.code) {
          case "invalid_input":
            return refused(400, "invalid_input");
          case "key_period_changed":
            // Rolled back at a key period boundary: the store asks for the routing again.
            return refused(409, "dm_key_period_changed");
          case "digest_key_unavailable":
            return refused(503, "dm_digest_key_unavailable");
          case "settings_unreadable":
            return refused(503, "dm_settings_unreadable");
          case "state_unreadable":
            return refused(503, "dm_state_unreadable");
        }
      }
      if (error instanceof DecisionMakerBodyWriteError && error.code === "digest_key_unavailable") {
        return refused(503, "dm_digest_key_unavailable");
      }
      return amuxInternalErrorResponse(OPERATION, error);
    }
  });
}

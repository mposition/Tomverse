export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_DB_BOUNDARIES,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { submitDecisionMakerOutput } from "@/lib/amux/decisionMakerBodyStore";
import { dmRunUnavailableIncident } from "@/lib/amux/decisionMakerCore";
import { loadDecisionMakerDigestKeyRing } from "@/lib/amux/decisionMakerDigestKeys";
import {
  dmReturnedRefusalStatus,
  dmRouteErrorResponse,
  dmRouteRefusal,
  settleDmValidationLatch,
} from "@/lib/amux/decisionMakerInternalRoute";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

/**
 * AMUX Decision Maker result submission (docs/policy/amux-decision-maker.md
 * §2-5, §6, §9, §10): the broker submits the DM's output as the exact bytes
 * it produced, with the card's options as the DM received them and §9's
 * binding values -- or `timeout`, or `unavailable`. The body store's
 * `submitDecisionMakerOutput()` decides everything: the options must be the
 * request's own, the output is validated and digested by the app under the
 * request key (never taken from the caller), and the ledger records the
 * request's one terminal result or a rejection with its reason, with the
 * result's detail and bodies in the same transaction. This route only
 * authenticates, reads the body, loads the key ring and runs that one
 * transaction in the route budget and its DB boundary, whose commit fence
 * holds the result deadline.
 *
 * The (request, result digest) pair is idempotent: the same output again
 * returns the recorded answer. A broker that lost this answer does not submit
 * again; it recomputes the digest with its request key and asks the lookup
 * route (§9). A 200 is the ledger's definite answer for the pair -- accepted,
 * already accepted, rejected or already rejected -- and the DM output, its
 * bodies and the result's detail never appear in it. Whatever the answer, the
 * card the worker sees does not change (§2-5): nothing here reaches it.
 *
 * A validation failure counts toward §8's latch: once one the ledger holds as
 * the request's result -- accepted now, or already -- has committed, the
 * route runs the latch check in a second boundary transaction
 * (`settleDmValidationLatch()`), which can only turn the instance off. The
 * answer is the result's whatever that check does; one that could not be
 * written stays owed to the next check.
 */

/**
 * The raw output is at most 256 KiB (DM_LAUNCH_OUTPUT_MAX_BYTES, the
 * launcher's). Carried here as a JSON string a byte takes at most six (a
 * control character's escape), 1.5 MiB; the options are the routed card's,
 * whose card text is at most 256 KiB (§5), at most twice that here; the
 * binding is a few hundred bytes. 4 MiB holds the worst case of all of it, so
 * a body the relay can build is never refused unread: the relay submits every
 * result and keeps one whose answer it lost owed (owner direction 2026-11-16),
 * and a body this route always refused would stay owed. It was 1,152 KiB,
 * under that worst case, and the relay recorded a larger output as unknown
 * without submitting it.
 */
const MAX_BODY_BYTES = 4 * 1_024 * 1_024;

const requestSchema = z
  .object({
    request_id: z.unknown(),
    instance: z.unknown(),
    binding: z.unknown(),
    output: z.unknown(),
  })
  .strict();

const OPERATION = "decision_maker_result_submission";

const refused = dmRouteRefusal("submitted");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      const keyRing = loadDecisionMakerDigestKeyRing();
      const submission = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerResultSubmission, (tx, context) =>
        submitDecisionMakerOutput(tx, {
          requestId: body.request_id,
          instance: body.instance,
          binding: body.binding,
          output: body.output,
          requireLeaseAt: context.requireLeaseAt,
          keyRing,
        }),
      );
      if (submission.status !== "submitted") {
        return refused(dmReturnedRefusalStatus(submission.status), submission.status);
      }
      const { result } = submission;
      switch (result.status) {
        case "unknown_request":
        case "instance_mismatch":
          return refused(dmReturnedRefusalStatus(result.status), result.status);
        case "accepted":
        case "existing":
        case "rejected":
        case "already_rejected":
          if ((result.status === "accepted" || result.status === "existing") && result.resultKind === "validation_failure") {
            await settleDmValidationLatch(body.instance);
          }
          // A failed run is not a judgment: tell the operator once, when the ledger
          // first records it. Not awaited: the broker's answer never waits on a notice.
          if (result.status === "accepted" && submission.resultKind === "unavailable") {
            void reportOperationalIncident(dmRunUnavailableIncident(body.instance, body.request_id)).catch(() => undefined);
          }
          return amuxJsonNoStore({
            submitted: true,
            status: result.status,
            result_kind: submission.resultKind,
            validation_failure: submission.validationFailure,
            result_digest: submission.resultDigest,
            event_id:
              result.status === "accepted" || result.status === "rejected"
                ? result.event.eventId
                : result.status === "existing"
                  ? result.eventId
                  : null,
            reason: result.status === "rejected" || result.status === "already_rejected" ? result.reason : null,
          });
      }
    } catch (error) {
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}

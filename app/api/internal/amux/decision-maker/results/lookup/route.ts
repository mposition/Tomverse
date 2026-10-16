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
import { lookupDecisionMakerResult } from "@/lib/amux/decisionMakerRequestStore";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";

/**
 * AMUX Decision Maker result lookup (docs/policy/amux-decision-maker.md §9):
 * a broker that lost the answer to a result submission does not submit again.
 * It asks here with the (request, result digest) pair, the digest recomputed
 * with its request key, and learns whether the ledger accepted that pair,
 * rejected it, or has not recorded it. The answer is the request store's
 * `lookupDecisionMakerResult()`, one read in a read boundary; nothing is
 * written. When this does not settle it, the broker records the result as
 * unknown (results/unknown) and the question goes to the operator.
 *
 * Reading the record is allowed under the kill switch (§6's table), so the
 * switches are not read; the route is still closed until the operator sets
 * `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 */

const MAX_BODY_BYTES = 1_024;

// Strings here because the store's reader takes strings; their format (a
// request id, a 64-character digest) is the store's to judge, before any
// statement.
const requestSchema = z
  .object({
    request_id: z.string(),
    result_digest: z.string(),
  })
  .strict();

const OPERATION = "decision_maker_result_lookup_read";

const refused = dmRouteRefusal("found");

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, MAX_BODY_BYTES, requestSchema);
      const lookup = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerResultLookupRead, (tx) =>
        lookupDecisionMakerResult(tx, { requestId: body.request_id, resultDigest: body.result_digest }),
      );
      if (lookup === null) return refused(dmReturnedRefusalStatus("unknown_request"), "unknown_request");
      return amuxJsonNoStore({
        found: true,
        status: lookup.status,
        result_kind: lookup.status === "accepted" ? lookup.resultKind : null,
        event_id: lookup.status === "accepted" ? lookup.eventId : null,
        reason: lookup.status === "rejected" ? lookup.reason : null,
      });
    } catch (error) {
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}

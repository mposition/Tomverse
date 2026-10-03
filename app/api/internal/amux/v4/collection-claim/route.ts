export const dynamic = "force-dynamic";

import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_COLLECTION_AGENT_SECRET_ENV,
  isCollectionAgentAuthorized } from "@/lib/amux/ideaCollectionQueueCore";
import { AMUX_V4_COLLECTION_CLAIM_ENV, AMUX_V4_COLLECTION_CLAIM_MAX_BYTES,
  collectionClaimEnabled, collectionClaimRequestSchema } from
  "@/lib/amux/ideaCollectionClaimCore";
import { AmuxCollectionClaimError, claimAmuxCollection } from
  "@/lib/amux/ideaCollectionClaimService";

/** Secret-isolated collector only. A claim contains no GitHub file body. */
export async function POST(request: Request): Promise<Response> {
  if (!isCollectionAgentAuthorized(request,
    process.env[AMUX_V4_COLLECTION_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET,
    process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!collectionClaimEnabled(process.env[AMUX_V4_COLLECTION_CLAIM_ENV])) {
    return amuxJsonNoStore({ available: false, reason: "collection_claim_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let collectionRequestId: string;
  try {
    const body = await readLimitedJson(request, AMUX_V4_COLLECTION_CLAIM_MAX_BYTES,
      collectionClaimRequestSchema);
    collectionRequestId = body.collectionRequestId;
  } catch {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  try {
    return amuxJsonNoStore(await claimAmuxCollection(collectionRequestId));
  } catch (error) {
    if (error instanceof AmuxCollectionClaimError) {
      if (error.code === "outcome_unknown") {
        return amuxJsonNoStore({ error: "outcome_unknown", retryClaim: false,
          collectionRequestId, readBack: error.readBack ?? "unavailable" }, 503);
      }
      return amuxJsonNoStore({ error: error.code },
        error.code === "not_found" ? 404 : error.code === "not_ready" ? 409 : 503);
    }
    return amuxJsonNoStore({ error: "Collection claim unavailable." }, 503);
  }
}

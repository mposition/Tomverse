export const dynamic = "force-dynamic";

import { ApiSecurityError, readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_COLLECTION_AGENT_SECRET_ENV,
  isCollectionAgentAuthorized } from "@/lib/amux/ideaCollectionQueueCore";
import { AMUX_V4_COLLECTION_RESULT_ENV, AMUX_V4_COLLECTION_RESULT_MAX_BYTES,
  collectionResultEnabled, collectionResultRequestSchema } from
  "@/lib/amux/ideaCollectionResultCore";
import { AmuxCollectionResultError, submitAmuxCollectionResult } from
  "@/lib/amux/ideaCollectionResultService";

/** Only the isolated source collector may submit a display candidate.
 * This route stays dark and never fetches GitHub or calls a model. */
export async function POST(request: Request): Promise<Response> {
  if (!isCollectionAgentAuthorized(request,
    process.env[AMUX_V4_COLLECTION_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET,
    process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!collectionResultEnabled(process.env[AMUX_V4_COLLECTION_RESULT_ENV])) {
    return amuxJsonNoStore({ available: false, reason: "collection_result_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let body;
  try {
    body = await readLimitedJson(request, AMUX_V4_COLLECTION_RESULT_MAX_BYTES,
      collectionResultRequestSchema);
  } catch (error) {
    return amuxJsonNoStore({ error: "Invalid request." },
      error instanceof ApiSecurityError && error.status === 413 ? 413 : 400);
  }
  try {
    return amuxJsonNoStore(await submitAmuxCollectionResult(body));
  } catch (error) {
    if (error instanceof AmuxCollectionResultError) {
      if (error.code === "outcome_unknown") {
        return amuxJsonNoStore({ error: "outcome_unknown", retryResult: false,
          collectionRequestId: body.collectionRequestId,
          readBack: error.readBack ?? "unavailable" }, 503);
      }
      return amuxJsonNoStore({ error: error.code },
        error.code === "not_found" ? 404 : error.code === "not_ready" ? 409 : 503);
    }
    return amuxJsonNoStore({ error: "Collection result unavailable." }, 503);
  }
}

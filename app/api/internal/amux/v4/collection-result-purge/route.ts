export const dynamic = "force-dynamic";

import { ApiSecurityError, readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import {
  AMUX_V4_COLLECTION_RESULT_PURGE_ENV,
  AMUX_V4_COLLECTION_RESULT_PURGE_SECRET_ENV,
  collectionResultPurgeEnabled,
  collectionResultPurgeRequestSchema,
  isCollectionResultPurgeAuthorized,
} from "@/lib/amux/ideaCollectionResultPurgeCore";
import { AMUX_V4_COLLECTION_AGENT_SECRET_ENV } from
  "@/lib/amux/ideaCollectionQueueCore";
import { AmuxCollectionResultPurgeError, purgeDueAmuxCollectionResults } from
  "@/lib/amux/ideaCollectionResultPurgeService";

/** The isolated retention trigger holds no product DB credential. */
export async function POST(request: Request): Promise<Response> {
  if (!isCollectionResultPurgeAuthorized(request,
    process.env[AMUX_V4_COLLECTION_RESULT_PURGE_SECRET_ENV], [
      process.env[AMUX_V4_COLLECTION_AGENT_SECRET_ENV],
      process.env.TOMVERSE_AMUX_SYNC_SECRET,
      process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET,
    ])) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (!collectionResultPurgeEnabled(process.env[AMUX_V4_COLLECTION_RESULT_PURGE_ENV])) {
    return amuxJsonNoStore({ available: false, reason: "collection_result_purge_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  try {
    await readLimitedJson(request, 128, collectionResultPurgeRequestSchema);
  } catch (error) {
    return amuxJsonNoStore({ error: "Invalid request." },
      error instanceof ApiSecurityError && error.status === 413 ? 413 : 400);
  }
  try {
    return amuxJsonNoStore(await purgeDueAmuxCollectionResults());
  } catch (error) {
    if (error instanceof AmuxCollectionResultPurgeError) {
      if (error.code === "outcome_unknown") return amuxJsonNoStore({
        error: "outcome_unknown", retryPurge: false,
        collectionRequestId: error.collectionRequestId,
        readBack: error.readBack ?? "unavailable",
      }, 503);
      return amuxJsonNoStore({ error: error.code, retryPurge: false }, 503);
    }
    return amuxJsonNoStore({ error: "Collection purge unavailable.",
      retryPurge: false }, 503);
  }
}
